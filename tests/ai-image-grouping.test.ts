import assert from 'node:assert/strict';
import { $, cors } from 'easy-us';
import { buildAIRequest } from '../packages/core/src/core/answer-wrapper/ai';
import {
	AnswerWrapperHandlerConfig,
	defaultAnswerWrapperHandler
} from '../packages/core/src/core/answer-wrapper/answer.wrapper.handler';
import type { AnswererWrapper } from '../packages/core/src/core/answer-wrapper/interface';
import { createDefaultQuestionResolver } from '../packages/core/src/core/worker/question.resolver';
import { OCSWorker } from '../packages/core/src/core/worker/worker';
import { enableSingleQuestionRetry } from '../packages/core/src/core/worker/single-question-retry';
import type { QuestionTypes, WorkResult } from '../packages/core/src/core/worker/interface';
import { buildAnswererEnv } from '../packages/scripts/src/utils/answerer-env';
import { createCommonAnswerer, extractTextWithImages } from '../packages/scripts/src/utils/work';
import { createCXQuestionRetryAdapter } from '../packages/scripts/src/utils/cx-question-retry';
import { CommonProject } from '../packages/scripts/src/projects/common';

/**
 * Offline regressions for page option boundaries -> multimodal request -> native
 * answer -> actual DOM write. Image decoding and HTTP replies are fixtures; this
 * suite never contacts a model or a course and does not test model accuracy.
 */
const runtime = globalThis as any;
const config = { endpoint: 'https://grouping.invalid/v1', model: 'grouping-test', vision: true };
const wrapper: AnswererWrapper = {
	name: 'Offline grouped AI',
	url: config.endpoint,
	method: 'post',
	type: 'GM_xmlhttpRequest',
	headers: {},
	handler: '',
	ai: config
};
type Item = { text: string; images?: string[] };
type ImagePlan = { data: string; delay?: number } | 'fail';
type Captured = { body: any; question: any; options: any };
const plans = new Map<string, ImagePlan>();
const originalImage = Object.getOwnPropertyDescriptor(runtime, 'Image');
const originalCreateElement = document.createElement.bind(document);
const originalRequest = runtime.GM_xmlhttpRequest;
const originalGetValue = runtime.GM_getValue;
const originalImageOptimize = CommonProject.scripts.settings.cfg.imageOptimize;
const originalSleep = $.sleep;
const originalCorsOn = cors.on;
const originalTimeout = AnswerWrapperHandlerConfig.timeout_seconds;
let sequence = 0;
let cases = 0;
let requests: Captured[] = [];
let failedImages: string[] = [];
let conversionOrder: string[] = [];
let answer: (request: Captured, index: number) => string[] = () => ['A'];

// Only PNG headers are needed by the real minimum-dimension guard. These are
// deliberately not evidence of browser decoding or visual model recognition.
function png(index = 0): string {
	const bytes = Buffer.alloc(26);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	bytes.writeUInt32BE(20 + index, 16);
	bytes.writeUInt32BE(20, 20);
	bytes[24] = 8;
	bytes[25] = 6;
	return 'data:image/png;base64,' + bytes.toString('base64');
}
function image(name: string, plan: ImagePlan = { data: png(++sequence) }): string {
	const url = `https://images.invalid/grouping-${++sequence}-${name}.png`;
	plans.set(url, plan);
	return url;
}
class FixtureImage {
	crossOrigin = '';
	onload?: () => void;
	onerror?: () => void;
	naturalWidth = 20;
	naturalHeight = 20;
	width = 20;
	height = 20;
	private value = '';
	get src() {
		return this.value;
	}
	set src(url: string) {
		this.value = url;
		const plan = plans.get(url);
		const done = () => {
			conversionOrder.push(url);
			if (!plan || plan === 'fail') this.onerror?.();
			else this.onload?.();
		};
		if (plan && plan !== 'fail' && plan.delay) setTimeout(done, plan.delay);
		else done();
	}
}
Object.defineProperty(runtime, 'Image', { configurable: true, value: FixtureImage });
document.createElement = ((name: string) => {
	if (name.toLowerCase() !== 'canvas') return originalCreateElement(name);
	let source: FixtureImage | undefined;
	return {
		width: 20,
		height: 20,
		getContext: () => ({ drawImage: (value: FixtureImage) => (source = value) }),
		toDataURL: () => {
			const plan = source && plans.get(source.src);
			assert.ok(plan && plan !== 'fail', 'only a loaded image can be converted');
			return plan.data;
		}
	};
}) as typeof document.createElement;
runtime.GM_getValue = () => 'offline-grouping-fixture';
runtime.GM_xmlhttpRequest = (options: any) => {
	assert.match(
		options.url,
		/^https:\/\/(?:grouping|images|legacy)\.invalid\//,
		'network calls stay in offline fixtures'
	);
	if (options.method.toUpperCase() === 'GET') {
		failedImages.push(options.url);
		options.onerror(new Error('offline missing image'));
		return;
	}
	const body = JSON.parse(options.data);
	if (!Array.isArray(body.messages)) {
		requests.push({ body, question: undefined, options });
		options.onload({ status: 200, responseText: JSON.stringify({ question: 'legacy', answer: 'legacy response' }) });
		return;
	}
	const content = body.messages[1].content;
	const request = { body, question: JSON.parse(typeof content === 'string' ? content : content[0].text), options };
	const index = requests.length;
	requests.push(request);
	options.onload({
		status: 200,
		responseText: JSON.stringify({
			choices: [
				{
					finish_reason: 'stop',
					message: {
						content: JSON.stringify({ answers: answer(request, index), uncertain: false }),
						reasoning_content: '离线参考，不能替代最终答案字段。'
					}
				}
			]
		})
	});
};
$.sleep = async () => {};
cors.on = async () => 0;
AnswerWrapperHandlerConfig.timeout_seconds = 0.25;

function reset() {
	requests = [];
	failedImages = [];
	conversionOrder = [];
	answer = () => ['A'];
	CommonProject.scripts.settings.cfg.imageOptimize = true;
}
async function test(name: string, action: () => Promise<void> | void) {
	reset();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.resolve().then(action),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Offline grouping case timed out: ' + name)), 5000);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
	cases++;
	console.log('PASS ' + name);
}
async function envFor(title: string, items: Item[], titleImages: string[] = [], type = 'single') {
	const { env } = await buildAnswererEnv({
		type,
		title,
		options: items.map((item) => item.text),
		titleImages,
		optionsImages: items.flatMap((item) => item.images || []),
		optionItems: items,
		enableImageOptimize: true
	});
	return { ...env, option_count: items.length };
}
function requestFor(env: Record<string, any>) {
	const request = buildAIRequest(config, env as any);
	const content = request.messages[1].content;
	return {
		request,
		payload: JSON.parse(typeof content === 'string' ? content : content[0].text),
		parts: typeof content === 'string' ? [] : content
	};
}
function imageParts(parts: any[]): any[] {
	return parts.filter((part) => part.type === 'image_url');
}
function captions(parts: any[]): string[] {
	return parts
		.slice(1)
		.filter((part) => part.type === 'text')
		.map((part) => part.text);
}
function domFixture(htmlOptions: string[], multiple = false, titleHTML = '完整题干') {
	const root = document.createElement('section');
	const title = document.createElement('h3');
	title.className = 'title';
	title.innerHTML = titleHTML;
	root.append(title);
	const choiceName = 'grouping-choice-' + ++sequence;
	for (const html of htmlOptions) {
		const wrap = document.createElement('div');
		const input = document.createElement('input');
		input.type = multiple ? 'checkbox' : 'radio';
		input.name = choiceName;
		const option = document.createElement('div');
		option.className = 'option';
		option.innerHTML = html;
		option.onclick = () => {
			if (!multiple) {
				root.querySelectorAll('.option').forEach((other) => other.classList.remove('active'));
				root.querySelectorAll('input').forEach((other) => (other.checked = false));
			}
			input.checked = multiple ? !input.checked : true;
			option.classList.toggle('active', input.checked);
		};
		wrap.append(input, option);
		root.append(wrap);
	}
	document.body.append(root);
	return {
		root,
		title,
		options: [...root.querySelectorAll<HTMLElement>('.option')],
		selection: () => [...root.querySelectorAll<HTMLInputElement>('input')].map((input) => input.checked),
		cleanup: () => root.remove()
	};
}
function pageAnswerer(wrappers = [wrapper]) {
	return createCommonAnswerer({
		period: 0,
		titleTransform: (elements) => extractTextWithImages(elements.title[0]),
		optionsTransform: (elements, ctx) => {
			if (ctx.type === 'completion') return '';
			const items = elements.options.map((option: HTMLElement) => extractTextWithImages(option));
			return {
				text: items.map((item: Item) => item.text).join('\n'),
				images: items.flatMap((item: Item) => item.images || []),
				items
			};
		},
		answererWrappers: wrappers
	});
}
async function fillPage(fixture: ReturnType<typeof domFixture>, type: QuestionTypes, wrappers = [wrapper]) {
	const ctx: any = {
		root: fixture.root,
		type,
		elements: { title: [fixture.title], options: fixture.options },
		searchInfos: []
	};
	const infos = await pageAnswerer(wrappers)(ctx.elements, ctx);
	ctx.searchInfos = infos;
	const result = await createDefaultQuestionResolver(ctx, (option) => extractTextWithImages(option).text)[type!](
		infos,
		fixture.options,
		async (_type, _value, option) => option.click()
	);
	return { ctx, infos, result };
}
function ensembleWrapper(summary = false): AnswererWrapper {
	return {
		...wrapper,
		ai: undefined,
		aiEnsemble: {
			models: ['member-a', 'member-b'].map((model) => ({ ...config, model })),
			rule: summary ? 'confidence-then-summary' : 'confidence',
			threshold: 100,
			...(summary ? { summary: { ...config, model: 'summary' } } : {})
		}
	};
}

async function main() {
	await test('two title images and uneven image counts retain each complete option and upload order', async () => {
		const urls = Array.from({ length: 7 }, (_, i) => image('uneven-' + i));
		const items = [
			{ text: `A第一部分 ${urls[2]}\n第二部分 ${urls[3]}`, images: urls.slice(2, 4) },
			{ text: '纯文字' },
			{ text: urls[4], images: [urls[4]] },
			{ text: `${urls[5]} 与 ${urls[6]}`, images: urls.slice(5) }
		];
		const env = await envFor(`前 ${urls[0]} 中 ${urls[1]} 后`, items, urls.slice(0, 2));
		const { payload, parts } = requestFor(env);
		assert.deepEqual(payload.question_image_refs, ['[图片1]', '[图片2]']);
		assert.deepEqual(
			payload.option_items.map((item: any) => item.label),
			['A', 'B', 'C', 'D']
		);
		assert.match(payload.option_items[0].text, /A第一部分.*\[图片3\][\s\S]*\n第二部分.*\[图片4\]/);
		assert.deepEqual(payload.option_items[0].image_refs, ['[图片3]', '[图片4]']);
		assert.equal(payload.option_items[1].text, '纯文字');
		assert.deepEqual(payload.option_items[1].image_refs || [], []);
		assert.deepEqual(payload.option_items[3].image_refs, ['[图片6]', '[图片7]']);
		assert.deepEqual(
			imageParts(parts).map((part) => part.image_url.url),
			env.images
		);
		assert.equal(captions(parts).length, 7);
		assert.equal(env.options, items.map((item) => item.text).join('\n'), 'legacy raw options stay unchanged');
	});
	await test('different DOM option groupings with the same flattened text produce different AI input', async () => {
		const urls = Array.from({ length: 3 }, (_, i) => image('collision-' + i));
		const left = await envFor('题干', [
			{ text: `第一段 ${urls[0]}\n第二段 ${urls[1]}`, images: urls.slice(0, 2) },
			{ text: `第三段 ${urls[2]}`, images: urls.slice(2) }
		]);
		const right = await envFor('题干', [
			{ text: `第一段 ${urls[0]}`, images: urls.slice(0, 1) },
			{ text: `第二段 ${urls[1]}\n第三段 ${urls[2]}`, images: urls.slice(1) }
		]);
		assert.equal(left.options, right.options, 'fixture reproduces the old information collision');
		assert.notDeepEqual(requestFor(left).payload.option_items, requestFor(right).payload.option_items);
		assert.equal(requestFor(left).payload.option_items.length, 2);
		assert.deepEqual(requestFor(left).payload.option_items[0].image_refs, ['[图片1]', '[图片2]']);
		assert.deepEqual(requestFor(right).payload.option_items[1].image_refs, ['[图片2]', '[图片3]']);
	});
	await test('leading middle and trailing empty options and repeated option text keep their positions', async () => {
		const texts = ['', '重复', '', '重复', '末项', ''];
		const { payload } = requestFor(
			await envFor(
				'题干',
				texts.map((text) => ({ text }))
			)
		);
		assert.deepEqual(
			payload.option_items.map((item: any) => item.label),
			['A', 'B', 'C', 'D', 'E', 'F']
		);
		assert.deepEqual(
			payload.option_items.map((item: any) => item.text),
			texts
		);
		assert.equal(payload.option_count, texts.length);
	});
	await test('one shared URL keeps repeated references in title and multiple options while uploading once', async () => {
		const shared = image('shared');
		const env = await envFor(
			`题干 ${shared} 再看 ${shared}`,
			[
				{ text: `${shared} + ${shared}`, images: [shared, shared] },
				{ text: '纯文字' },
				{ text: '另一个文字选项' },
				{ text: shared, images: [shared] }
			],
			[shared, shared]
		);
		const { payload, parts } = requestFor(env);
		assert.equal(imageParts(parts).length, 1);
		assert.equal(payload.option_items[0].text.match(/\[图片1\]/g).length, 2);
		assert.ok(payload.option_items[0].image_refs.includes('[图片1]'));
		assert.ok(payload.option_items[3].image_refs.includes('[图片1]'));
		const caption = captions(parts).join('\n');
		assert.match(caption, /\[图片1\]/);
		assert.match(caption, /A/);
		assert.match(caption, /D/);
	});
	await test('distinct URLs with identical bytes keep their separate marker identities', async () => {
		const sameBytes = png();
		const first = image('same-bytes-a', { data: sameBytes });
		const second = image('same-bytes-b', { data: sameBytes });
		const { payload, parts } = requestFor(
			await envFor('题干', [
				{ text: first, images: [first] },
				{ text: second, images: [second] }
			])
		);
		assert.equal(imageParts(parts).length, 2);
		assert.deepEqual(
			payload.option_items.map((item: any) => item.image_refs),
			[['[图片1]'], ['[图片2]']]
		);
	});
	await test('overlapping URL prefixes cannot replace a long URL with another image marker', async () => {
		const first = image('prefix');
		const second = first + '?variant=2';
		plans.set(second, { data: png(++sequence) });
		const { payload } = requestFor(
			await envFor(
				`参考 ${first}`,
				[
					{ text: `长URL ${second}`, images: [second] },
					{ text: `短URL ${first}`, images: [first] }
				],
				[first]
			)
		);
		assert.match(payload.question, /\[图片1\]/);
		assert.match(payload.option_items[0].text, /\[图片2\]/);
		assert.doesNotMatch(payload.option_items[0].text, /variant|\[图片1\]/);
		assert.deepEqual(payload.option_items[0].image_refs, ['[图片2]']);
	});
	await test('literal marker text is preserved without inventing an image reference', async () => {
		const url = image('literal-marker');
		const { payload } = requestFor(
			await envFor(
				`正文只是提及 [图片99]，实际图片 ${url}`,
				[{ text: `再次提及 [图片99]，参考 ${url}`, images: [url] }, { text: '纯文字' }],
				[url]
			)
		);
		assert.match(payload.question, /\[图片99\]/);
		assert.match(payload.question, /\[图片1\]/);
		assert.deepEqual(payload.question_image_refs, ['[图片1]']);
		assert.match(payload.option_items[0].text, /\[图片99\]/);
		assert.deepEqual(payload.option_items[0].image_refs, ['[图片1]']);
	});
	await test('asynchronous conversion completion order cannot reorder image ownership', async () => {
		const slow = image('slow', { data: png(30), delay: 25 });
		const fast = image('fast', { data: png(31) });
		const env = await envFor('题干', [
			{ text: slow, images: [slow] },
			{ text: fast, images: [fast] }
		]);
		const { payload, parts } = requestFor(env);
		assert.deepEqual(conversionOrder, [fast, slow]);
		assert.deepEqual(
			imageParts(parts).map((part) => part.image_url.url),
			[png(30), png(31)]
		);
		assert.deepEqual(
			payload.option_items.map((item: any) => item.image_refs),
			[['[图片1]'], ['[图片2]']]
		);
	});
	await test('one failed image blocks the request without deleting or renumbering its option', async () => {
		const good = image('good');
		const bad = image('bad', 'fail');
		const env = await envFor('题干', [{ text: good, images: [good] }, { text: bad, images: [bad] }, { text: '后项' }]);
		const info = (await defaultAnswerWrapperHandler([wrapper], env))[0];
		assert.equal(requests.length, 0);
		assert.equal(info.results.length, 0);
		assert.match(info.error || '', /图片/);
		assert.equal(env.option_count, 3);
		assert.equal(env.option_items.length, 3);
		assert.deepEqual(
			env.option_items.map((item: any) => item.label),
			['A', 'B', 'C']
		);
		assert.equal(failedImages.length, 1);
	});
	await test('invalid label count or image references fail before making a paid request', async () => {
		const url = image('validation');
		const base = await envFor('题干', [{ text: url, images: [url] }, { text: '乙' }]);
		const invalid = [
			{ ...base, option_count: 3 },
			{ ...base, option_items: [{ ...base.option_items[0], label: 'B' }, base.option_items[1]] },
			{ ...base, option_items: [{ ...base.option_items[0], image_refs: ['[图片99]'] }, base.option_items[1]] },
			{ ...base, question_image_refs: ['[图片99]'] },
			{ ...base, option_items: [] },
			{ ...base, type: 'completion', blank_count: 1 }
		];
		for (const question of invalid) assert.throws(() => requestFor(question), /选项|图片|引用|题型|填空|结构/);
		assert.equal(requests.length, 0);
	});
	await test('legacy and online-selection text without known option groups is not split into invented items', async () => {
		const { env } = await buildAnswererEnv({ title: 'A. 段一\n段二\nB. 段三', options: '', enableImageOptimize: true });
		const { payload } = requestFor(env);
		assert.equal(payload.option_items, undefined);
		assert.match(payload.question, /段一\n段二/);
	});
	await test('legacy question-bank raw title and options remain intact with new grouping metadata', async () => {
		const url = image('legacy');
		const title = '原题 ' + url;
		const items = [{ text: 'A第一行\n第二行' }, { text: '乙' }];
		const env = await envFor(title, items, [url]);
		const legacy: AnswererWrapper = {
			name: 'Offline legacy',
			url: 'https://legacy.invalid/search',
			method: 'post',
			type: 'GM_xmlhttpRequest',
			headers: {},
			data: { title: '${title}', options: '${options}' },
			handler: 'return (response) => [response.question, response.answer]'
		};
		const info = (await defaultAnswerWrapperHandler([legacy], env))[0];
		assert.equal(info.results[0].answer, 'legacy response');
		assert.equal(requests[0].body.title, title);
		assert.equal(requests[0].body.options, items.map((item) => item.text).join('\n'));
	});
	for (const letter of ['A', 'B', 'D'])
		await test(`page extraction and native ${letter} response select its actual DOM position`, async () => {
			const urls = Array.from({ length: 5 }, (_, i) => image('select-' + letter + '-' + i));
			const fixture = domFixture(
				[
					`B<br><img src="${urls[1]}"><br>仍属于第一选项`,
					`第二选项<img src="${urls[2]}"><img src="${urls[3]}">`,
					'第三选项',
					`<img src="${urls[4]}">`
				],
				false,
				`题干<img src="${urls[0]}">`
			);
			try {
				answer = () => [letter];
				const { result } = await fillPage(fixture, 'single');
				assert.equal(result.finish, true);
				assert.deepEqual(
					fixture.selection(),
					['A', 'B', 'C', 'D'].map((value) => value === letter)
				);
				assert.equal(requests[0].question.option_count, 4);
				assert.equal(requests[0].question.option_items.length, 4);
				assert.match(requests[0].question.option_items[0].text, /^B\n/);
				assert.equal(requests[0].question.option_items[1].image_refs.length, 2);
			} finally {
				fixture.cleanup();
			}
		});
	await test('default page adapter captures option images without changing legacy innerText options', async () => {
		const urls = Array.from({ length: 5 }, (_, i) => image('default-adapter-' + i));
		const fixture = domFixture(
			urls.slice(1).map((url, i) => `文字${i + 1}<img src="${url}">`),
			false,
			`题干<img src="${urls[0]}">`
		);
		try {
			for (const option of fixture.options)
				Object.defineProperty(option, 'innerText', { configurable: true, get: () => option.textContent });
			const legacyOptions = fixture.options.map((option) => option.innerText).join('\n');
			const ctx: any = {
				root: fixture.root,
				type: 'single',
				elements: { title: [fixture.title], options: fixture.options }
			};
			answer = () => ['B'];
			const infos = await createCommonAnswerer({
				period: 0,
				titleTransform: (elements) => extractTextWithImages(elements.title[0]),
				answererWrappers: [wrapper]
			})(ctx.elements, ctx);
			assert.equal(requests[0].question.options, legacyOptions);
			assert.deepEqual(
				requests[0].question.option_items.map((item: any) => item.image_refs),
				[['[图片2]'], ['[图片3]'], ['[图片4]'], ['[图片5]']]
			);
			assert.equal(imageParts(requests[0].body.messages[1].content).length, 5);
			const result = await createDefaultQuestionResolver(ctx, (option) => extractTextWithImages(option).text).single(
				infos,
				fixture.options,
				(_type, _value, option) => option.click()
			);
			assert.equal(result.finish, true);
			assert.deepEqual(fixture.selection(), [false, true, false, false]);
		} finally {
			fixture.cleanup();
		}
	});
	await test('multi-choice AC keeps whole multi-image options and clicks A and C only', async () => {
		const first = image('multiple-a');
		const second = image('multiple-c');
		const fixture = domFixture([`<img src="${first}"><br>甲`, '干扰项', `丙<img src="${second}">`, '其他'], true);
		try {
			answer = () => ['AC'];
			const { result } = await fillPage(fixture, 'multiple');
			assert.equal(result.finish, true);
			assert.deepEqual(fixture.selection(), [true, false, true, false]);
			assert.deepEqual(
				requests[0].question.option_items.map((item: any) => item.label),
				['A', 'B', 'C', 'D']
			);
		} finally {
			fixture.cleanup();
		}
	});
	await test('reversed judgement A=false B=true interprets model B through the actual option values', async () => {
		const fixture = domFixture(['错', '对']);
		try {
			answer = () => ['B'];
			const { result, infos } = await fillPage(fixture, 'judgement');
			assert.equal(requests[0].question.type, 'judgement');
			assert.deepEqual(
				requests[0].question.option_items.map((item: any) => item.text),
				['错', '对']
			);
			assert.equal(infos[0].results[0].answer, '正确');
			assert.equal(result.finish, true);
			assert.deepEqual(fixture.selection(), [false, true]);
		} finally {
			fixture.cleanup();
		}
	});
	await test('completion fields do not become labelled options and literal answer boundaries remain intact', async () => {
		const root = document.createElement('section');
		root.innerHTML = '<h3>填写两个值</h3><textarea></textarea><textarea></textarea>';
		document.body.append(root);
		try {
			const fields = [...root.querySelectorAll('textarea')];
			const ctx: any = { root, type: 'completion', elements: { title: [root.querySelector('h3')], options: fields } };
			answer = () => ['甲\n乙', '26'];
			const infos = await pageAnswerer()(ctx.elements, ctx);
			const result = await createDefaultQuestionResolver(ctx).completion(infos, fields, (_type, value, field) => {
				(field as HTMLTextAreaElement).value = value;
			});
			assert.equal(requests[0].question.blank_count, 2);
			assert.equal(requests[0].question.option_items, undefined);
			assert.equal(result.finish, true);
			assert.deepEqual(
				fields.map((field) => field.value),
				['甲\n乙', '26']
			);
		} finally {
			root.remove();
		}
	});
	await test('all advanced participants receive the same option groups before confidence selection', async () => {
		const url = image('ensemble');
		const fixture = domFixture(['第一项', `<img src="${url}"><br>第二项`, '第三项']);
		try {
			answer = () => ['B'];
			const { result, infos } = await fillPage(fixture, 'single', [ensembleWrapper()]);
			assert.equal(requests.length, 2);
			assert.deepEqual(requests[0].question.option_items, requests[1].question.option_items);
			assert.equal(infos[0].ensemble?.status, 'agreed');
			assert.equal(result.finish, true);
			assert.deepEqual(fixture.selection(), [false, true, false]);
		} finally {
			fixture.cleanup();
		}
	});
	await test('disagreeing grouped candidates remain for human review without selecting either answer', async () => {
		const url = image('manual-disagreement');
		const fixture = domFixture([`第一项<img src="${url}">`, '第二项', '第三项']);
		try {
			answer = (request) => [request.body.model === 'member-a' ? 'A' : 'C'];
			const { result, infos } = await fillPage(fixture, 'single', [ensembleWrapper()]);
			assert.equal(requests.length, 2);
			assert.deepEqual(requests[0].question.option_items, requests[1].question.option_items);
			assert.equal(infos[0].ensemble?.status, 'review');
			assert.equal(infos[0].results.length, 0);
			assert.equal(result.finish, false);
			assert.deepEqual(fixture.selection(), [false, false, false]);
		} finally {
			fixture.cleanup();
		}
	});
	await test('summary receives original option groups plus all candidates and its result fills the correct option', async () => {
		const url = image('summary');
		const fixture = domFixture([`<img src="${url}">`, '第二项', '第三项']);
		try {
			answer = (request) => [request.body.model === 'summary' ? 'B' : request.body.model === 'member-a' ? 'A' : 'C'];
			const { result, infos } = await fillPage(fixture, 'single', [ensembleWrapper(true)]);
			assert.equal(requests.length, 3);
			const summary = requests.find((request) => request.body.model === 'summary')!;
			assert.deepEqual(summary.question.option_items, requests[0].question.option_items);
			assert.equal(summary.question.model_reports.length, 2);
			assert.equal(infos[0].ensemble?.status, 'summarized');
			assert.equal(result.finish, true);
			assert.deepEqual(fixture.selection(), [false, true, false]);
		} finally {
			fixture.cleanup();
		}
	});
	await test('single-question retry reuses grouped input and updates only its own live DOM choice', async () => {
		const url = image('retry');
		const fixture = domFixture(['第一项', `<img src="${url}"><br>第二项`, '第三项', '末项']);
		const other = domFixture(['其他题甲', '其他题乙']);
		let results: WorkResult<any>[] = [];
		const worker = new OCSWorker({
			root: [fixture.root],
			elements: { title: '.title', options: '.option' },
			thread: 1,
			answerer: pageAnswerer(),
			work: {
				type: 'single',
				optionText: (option) => extractTextWithImages(option).text,
				handler: (_type, _value, option) => option.click()
			},
			onResultsInit: (_current, _index, all) => {
				results = all;
			}
		});
		enableSingleQuestionRetry(
			worker,
			createCXQuestionRetryAdapter({
				layout: 'practice',
				type: () => 'single',
				optionText: (option) => extractTextWithImages(option).text
			})
		);
		try {
			answer = () => ['A'];
			await worker.doWork();
			worker.emit('done');
			assert.deepEqual(fixture.selection(), [true, false, false, false]);
			const otherBefore = other.root.innerHTML;
			answer = () => ['D'];
			await results[0].retry!();
			assert.equal(requests.length, 2);
			assert.deepEqual(requests[0].question.option_items, requests[1].question.option_items);
			assert.deepEqual(fixture.selection(), [false, false, false, true]);
			assert.equal(other.root.innerHTML, otherBefore);
		} finally {
			worker.emit('close');
			fixture.cleanup();
			other.cleanup();
		}
	});
	console.log(`AI image grouping: ${cases} scenarios passed.`);
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		if (originalImage) Object.defineProperty(runtime, 'Image', originalImage);
		else delete runtime.Image;
		document.createElement = originalCreateElement;
		runtime.GM_xmlhttpRequest = originalRequest;
		runtime.GM_getValue = originalGetValue;
		CommonProject.scripts.settings.cfg.imageOptimize = originalImageOptimize;
		$.sleep = originalSleep;
		cors.on = originalCorsOn;
		AnswerWrapperHandlerConfig.timeout_seconds = originalTimeout;
	});
