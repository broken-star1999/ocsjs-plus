import assert from 'node:assert/strict';
import { buildAIRequest, searchAIAnswer } from '../packages/core/src/core/answer-wrapper/ai';
import {
	AnswerWrapperHandlerConfig,
	defaultAnswerWrapperHandler
} from '../packages/core/src/core/answer-wrapper/answer.wrapper.handler';
import { createDefaultQuestionResolver } from '../packages/core/src/core/worker/question.resolver';
import type { AnswererWrapper } from '../packages/core/src/core/answer-wrapper/interface';
import { buildAnswererEnv } from '../packages/scripts/src/utils/answerer-env';
import { createCommonAnswerer } from '../packages/scripts/src/utils/work';
import { CommonProject } from '../packages/scripts/src/projects/common';

/**
 * Offline integration regressions at the page -> prompt -> answer -> DOM boundary.
 * Image decoding and HTTP transport are controlled fixtures; no external request is made.
 */
const runtime = globalThis as any;
const config = { endpoint: 'https://offline.invalid/v1', model: 'boundary-test', vision: true };
const wrapper: AnswererWrapper = {
	name: 'Offline AI',
	url: config.endpoint,
	method: 'post',
	type: 'GM_xmlhttpRequest',
	headers: {},
	handler: '',
	ai: config
};
let checks = 0;
let sequence = 0;
let aiRequests: any[] = [];
let legacyRequests: any[] = [];
let failedImageRequests: string[] = [];
let answerFromPayload: (question: any) => string[] = () => ['A'];
type ImagePlan = { data: string; width?: number; height?: number } | 'fail';
const imagePlans = new Map<string, ImagePlan>();
let failTinyReload = false;
const originalImageDescriptor = Object.getOwnPropertyDescriptor(runtime, 'Image');
const originalCreateElement = document.createElement.bind(document);
const originalGetValue = runtime.GM_getValue;
const originalRequest = runtime.GM_xmlhttpRequest;
const originalImageOptimize = CommonProject.scripts.settings.cfg.imageOptimize;

// Only the PNG signature/IHDR dimensions are needed by the real pre-upload size check.
// These fixtures deliberately do not represent browser image decoding validation.
function png(width = 20, height = 20): string {
	const bytes = Buffer.alloc(26);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	bytes[24] = 8;
	bytes[25] = 6;
	return 'data:image/png;base64,' + bytes.toString('base64');
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
		const plan = imagePlans.get(url);
		if (plan === 'fail' || (!url.startsWith('data:') && !plan) || (failTinyReload && url === png(1, 1))) {
			this.onerror?.();
			return;
		}
		if (plan) {
			this.naturalWidth = this.width = plan.width ?? 20;
			this.naturalHeight = this.height = plan.height ?? 20;
		} else if (url === png(1, 1)) {
			this.naturalWidth = this.width = 1;
			this.naturalHeight = this.height = 1;
		}
		this.onload?.();
	}
}
// browser-env exposes Image through a configurable getter without a setter.
Object.defineProperty(runtime, 'Image', { configurable: true, value: FixtureImage });
document.createElement = ((name: string) => {
	if (name.toLowerCase() !== 'canvas') return originalCreateElement(name);
	let source: FixtureImage | undefined;
	return {
		width: 20,
		height: 20,
		getContext: () => ({ drawImage: (image: FixtureImage) => (source = image) }),
		toDataURL: () => {
			const plan = source && imagePlans.get(source.src);
			return plan && plan !== 'fail' ? plan.data : png();
		}
	};
}) as typeof document.createElement;
runtime.GM_getValue = () => '';
runtime.GM_xmlhttpRequest = (request: any) => {
	if (request.method.toUpperCase() === 'GET') {
		failedImageRequests.push(request.url);
		request.onerror(new Error('offline image conversion failure'));
		return;
	}
	const body = JSON.parse(request.data);
	if (Array.isArray(body.messages)) {
		aiRequests.push(request);
		const content = body.messages[1].content;
		const question = JSON.parse(typeof content === 'string' ? content : content[0].text);
		request.onload({
			status: 200,
			responseText: JSON.stringify({
				choices: [
					{
						finish_reason: 'stop',
						message: { content: JSON.stringify({ answers: answerFromPayload(question), uncertain: false }) }
					}
				]
			})
		});
		return;
	}
	legacyRequests.push({ request, body });
	request.onload({ status: 200, responseText: JSON.stringify({ question: 'legacy', answer: 'legacy answer' }) });
};
function reset() {
	aiRequests = [];
	legacyRequests = [];
	failedImageRequests = [];
	answerFromPayload = () => ['A'];
	failTinyReload = false;
}
function image(name: string, plan: ImagePlan, extensionless = false) {
	const url = `https://images.invalid/${++sequence}-${name}${extensionless ? '?id=7' : '.png'}`;
	imagePlans.set(url, plan);
	return url;
}
function payload(index = 0) {
	const content = JSON.parse(aiRequests[index].data).messages[1].content;
	return JSON.parse(typeof content === 'string' ? content : content[0].text);
}
async function test(name: string, action: () => void | Promise<void>) {
	reset();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.resolve().then(action),
			new Promise<never>((resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Offline fixture did not settle: ' + name)), 1500);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
	checks++;
	console.log('PASS ' + name);
}
async function query(env: Record<string, any>) {
	return (await defaultAnswerWrapperHandler([wrapper], env))[0];
}
function choiceDOM(texts: string[], multiple = false) {
	const root = document.createElement('section');
	for (const text of texts) {
		const label = document.createElement('label');
		const input = document.createElement('input');
		input.type = multiple ? 'checkbox' : 'radio';
		input.name = 'offline-choice';
		label.append(input, document.createTextNode(text));
		root.append(label);
	}
	return {
		root,
		options: Array.from(root.querySelectorAll('label')),
		inputs: Array.from(root.querySelectorAll('input'))
	};
}

async function main() {
	await test('duplicate single-choice contents retain their positions from request through actual radio click', async () => {
		const texts = ['重复内容', '重复内容', '目标答案'];
		const { env } = await buildAnswererEnv({ type: 'single', title: '选择目标答案', options: texts });
		answerFromPayload = (question) => [String.fromCharCode(65 + question.options.split('\n').indexOf('目标答案'))];
		const infos = await defaultAnswerWrapperHandler([wrapper], { ...env, option_count: 3 });
		const dom = choiceDOM(texts);
		const result = await createDefaultQuestionResolver({} as any, (option) => option.textContent!).single(
			infos,
			dom.options,
			async (_type, _answer, option) => option.querySelector('input')!.click()
		);
		assert.equal(payload().options, texts.join('\n'));
		assert.equal(result.finish, true);
		assert.deepEqual(
			dom.inputs.map((input) => input.checked),
			[false, false, true]
		);
	});
	await test('duplicate multiple-choice contents retain the C/D positions through actual checkbox clicks', async () => {
		const texts = ['重复内容', '重复内容', '目标甲', '目标乙'];
		const { env } = await buildAnswererEnv({ type: 'multiple', title: '选择两个目标', options: texts });
		answerFromPayload = (question) => [
			['目标甲', '目标乙']
				.map((target) => String.fromCharCode(65 + question.options.split('\n').indexOf(target)))
				.join('')
		];
		const infos = await defaultAnswerWrapperHandler([wrapper], { ...env, option_count: 4 });
		const dom = choiceDOM(texts, true);
		const result = await createDefaultQuestionResolver({} as any, (option) => option.textContent!).multiple(
			infos,
			dom.options,
			async (_type, _answer, option) => option.querySelector('input')!.click()
		);
		assert.equal(payload().options, texts.join('\n'));
		assert.equal(result.finish, true);
		assert.deepEqual(
			dom.inputs.map((input) => input.checked),
			[false, false, true, true]
		);
	});
	await test('multiline code options keep repeated statements and blank lines', async () => {
		const options = 'A.\nif ready:\n    run()\n\nB.\nif ready:\n    wait()';
		const { env } = await buildAnswererEnv({ type: 'single', title: '选择代码', options });
		assert.equal(env.options, options);
	});
	await test('an empty option still occupies its original array position', async () => {
		const { env } = await buildAnswererEnv({ type: 'single', title: '题干', options: ['前', '', '后'] });
		assert.equal(env.options, '前\n\n后');
	});
	for (const type of ['single', 'multiple', 'judgement'])
		await test('page adapter supplies actual DOM option_count for ' + type, async () => {
			CommonProject.scripts.settings.cfg.imageOptimize = false;
			const options = choiceDOM(type === 'judgement' ? ['对', '错'] : ['甲', '乙', '丙']).options;
			const ctx: any = { type, elements: { options } };
			answerFromPayload = () => [type === 'judgement' ? '正确' : 'A'];
			await createCommonAnswerer({
				period: 0,
				titleTransform: () => '题干',
				optionsTransform: () => options.map((option) => option.textContent).join('\n'),
				answererWrappers: [wrapper]
			})(ctx.elements, ctx);
			assert.equal(payload().option_count, options.length);
		});
	await test('partial image conversion blocks a paid AI request before answer parsing or filling', async () => {
		const good = image('partial-good', { data: png() });
		const bad = image('partial-bad', 'fail');
		const { env } = await buildAnswererEnv({
			type: 'single',
			title: good,
			options: '甲\n' + bad,
			titleImages: [good],
			optionsImages: [bad],
			enableImageOptimize: true
		});
		assert.equal(env.expected_image_count, 2);
		assert.equal(env.images.length, 1);
		const info = await query({ ...env, option_count: 2 });
		assert.equal(aiRequests.length, 0);
		assert.equal(info.results.length, 0);
		assert.match(info.error || '', /图片/);
		assert.equal(info.ai?.call.status, 'error');
		const dom = choiceDOM(['甲', bad]);
		const result = await createDefaultQuestionResolver({} as any, (option) => option.textContent!).single(
			[info],
			dom.options,
			async (_type, _answer, option) => option.querySelector('input')!.click()
		);
		assert.equal(result.finish, false);
		assert.deepEqual(
			dom.inputs.map((input) => input.checked),
			[false, false]
		);
	});
	await test('all image conversions failing blocks AI even when URLs have no image extension', async () => {
		const first = image('all-failed-title', 'fail', true);
		const second = image('all-failed-option', 'fail', true);
		const { env } = await buildAnswererEnv({
			type: 'single',
			title: first,
			options: second,
			titleImages: [first],
			optionsImages: [second],
			enableImageOptimize: true
		});
		assert.equal(env.expected_image_count, 2);
		assert.equal((env.images || []).length, 0);
		const info = await query({ ...env, option_count: 1 });
		assert.equal(aiRequests.length, 0);
		assert.equal(info.results.length, 0);
		assert.match(info.error || '', /图片/);
		assert.equal(failedImageRequests.length, 2);
	});
	await test('all image conversions succeeding preserve placeholder order and allow AI', async () => {
		const first = image('complete-title', { data: png(21, 20) });
		const second = image('complete-option', { data: png(22, 20) });
		const { env, imageUrls } = await buildAnswererEnv({
			type: 'single',
			title: first,
			options: '甲\n' + second,
			titleImages: [first],
			optionsImages: [second],
			enableImageOptimize: true
		});
		assert.equal(env.expected_image_count, 2);
		assert.equal(env.images.length, 2);
		assert.deepEqual(imageUrls, [first, second]);
		const info = await query({ ...env, option_count: 2 });
		assert.equal(aiRequests.length, 1);
		assert.equal(info.results[0].answer, 'A');
		assert.match(payload().question, /\[图片1\]/);
		assert.match(payload().options, /\[图片2\]/);
		const content = JSON.parse(aiRequests[0].data).messages[1].content;
		assert.deepEqual(
			content.slice(1).map((part: any) => part.image_url.url),
			env.images
		);
	});
	await test('DOM-provided extensionless images are counted and can be submitted after conversion', async () => {
		const url = image('extensionless-good', { data: png() }, true);
		const { env } = await buildAnswererEnv({
			type: 'single',
			title: url,
			titleImages: [url],
			options: '甲\n乙',
			enableImageOptimize: true
		});
		assert.equal(env.expected_image_count, 1);
		assert.equal((await query({ ...env, option_count: 2 })).results[0].answer, 'A');
		assert.equal(aiRequests.length, 1);
	});
	await test('disabled image optimization cannot silently submit extensionless images as text', async () => {
		const url = image('disabled-extensionless', { data: png() }, true);
		const { env } = await buildAnswererEnv({
			type: 'single',
			title: url,
			titleImages: [url],
			options: '甲\n乙',
			enableImageOptimize: false
		});
		const info = await query({ ...env, option_count: 2 });
		assert.equal(info.results.length, 0);
		assert.equal(aiRequests.length, 0);
		assert.match(info.error || '', /图片/);
	});
	await test('duplicate image URLs count once without deleting repeated image options', async () => {
		const same = image('shared-option', { data: png() });
		const options = [same, same, '目标'];
		const { env, imageUrls } = await buildAnswererEnv({
			type: 'single',
			title: '选择目标',
			options,
			optionsImages: [same, same],
			enableImageOptimize: true
		});
		assert.equal(env.expected_image_count, 1);
		assert.equal(env.images.length, 1);
		assert.deepEqual(imageUrls, [same]);
		assert.equal(env.options, options.join('\n'));
		assert.equal(env.suggestion_options.split('\n').length, 3);
		assert.equal(env.suggestion_options.match(/\[图片1\]/g).length, 2);
		assert.equal((await query({ ...env, option_count: 3 })).results.length, 1);
	});
	await test('failed enlargement of a tiny image is counted as a missing image and blocks AI', async () => {
		const good = image('tiny-peer', { data: png() });
		const tiny = image('tiny-broken', { data: png(1, 1), width: 1, height: 1 });
		failTinyReload = true;
		const { env } = await buildAnswererEnv({
			type: 'single',
			title: good,
			options: tiny,
			titleImages: [good],
			optionsImages: [tiny],
			enableImageOptimize: true
		});
		assert.equal(env.expected_image_count, 2);
		assert.equal(env.images.length, 1);
		const info = await query({ ...env, option_count: 1 });
		assert.equal(aiRequests.length, 0);
		assert.equal(info.results.length, 0);
		assert.match(info.error || '', /图片/);
	});
	await test('a successfully enlarged tiny image remains available for AI', async () => {
		const tiny = image('tiny-working', { data: png(1, 1), width: 1, height: 1 });
		const { env } = await buildAnswererEnv({
			type: 'single',
			title: tiny,
			titleImages: [tiny],
			options: '甲\n乙',
			enableImageOptimize: true
		});
		assert.equal(env.expected_image_count, 1);
		assert.equal(env.images.length, 1);
		assert.equal((await query({ ...env, option_count: 2 })).results.length, 1);
		assert.equal(aiRequests.length, 1);
	});
	await test('plain text does not acquire an invented image requirement', async () => {
		const { env } = await buildAnswererEnv({
			type: 'single',
			title: '纯文字题目',
			options: '甲\n乙',
			enableImageOptimize: true
		});
		assert.equal(env.expected_image_count, undefined);
		assert.equal((await query({ ...env, option_count: 2 })).results.length, 1);
		assert.equal(aiRequests.length, 1);
	});
	await test('image metadata is authoritative even when an extensionless URL evades suffix checks', () => {
		assert.throws(
			() => buildAIRequest(config, { title: 'https://images.invalid/render?id=1', expected_image_count: 1 } as any),
			/图片/
		);
		assert.equal(aiRequests.length, 0);
	});
	await test('legacy question-bank requests retain degraded raw text when some images fail', async () => {
		const good = image('legacy-good', { data: png() });
		const bad = image('legacy-bad', 'fail', true);
		const { env } = await buildAnswererEnv({
			type: 'single',
			title: good,
			options: bad,
			titleImages: [good],
			optionsImages: [bad],
			enableImageOptimize: true
		});
		const legacy: AnswererWrapper = {
			name: 'Offline legacy',
			url: 'https://legacy.invalid/search',
			method: 'post',
			type: 'GM_xmlhttpRequest',
			headers: {},
			// eslint-disable-next-line no-template-curly-in-string
			data: { title: '${title}', options: '${options}', images: '${images}', suggestion_title: '${suggestion_title}' },
			handler: 'return (response) => [response.question, response.answer]'
		};
		const oldTimeout = AnswerWrapperHandlerConfig.timeout_seconds;
		AnswerWrapperHandlerConfig.timeout_seconds = 0.05;
		try {
			const info = (await defaultAnswerWrapperHandler([legacy], env))[0];
			assert.equal(info.error, undefined);
			assert.equal(info.results[0].answer, 'legacy answer');
			assert.equal(legacyRequests.length, 1);
			assert.equal(legacyRequests[0].body.title, good);
			assert.equal(legacyRequests[0].body.options, bad);
			assert.equal(aiRequests.length, 0);
		} finally {
			AnswerWrapperHandlerConfig.timeout_seconds = oldTimeout;
		}
	});
	await test('known missing images are rejected by the native API entrypoint too', async () => {
		const info = await searchAIAnswer(
			config,
			{
				type: 'single',
				title: '题干',
				options: '甲\n乙',
				images: [png()],
				expected_image_count: 2,
				option_count: 2
			} as any,
			1000
		);
		assert.equal(info.results.length, 0);
		assert.equal(aiRequests.length, 0);
		assert.match(info.error || '', /图片/);
	});
	console.log(`AI chain boundary checks: ${checks} scenarios passed.`);
}
main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		if (originalImageDescriptor) Object.defineProperty(runtime, 'Image', originalImageDescriptor);
		else delete runtime.Image;
		document.createElement = originalCreateElement;
		runtime.GM_getValue = originalGetValue;
		runtime.GM_xmlhttpRequest = originalRequest;
		CommonProject.scripts.settings.cfg.imageOptimize = originalImageOptimize;
	});
