import assert from 'node:assert/strict';
import type { AnswererWrapper } from '../packages/core/src/core/answer-wrapper/interface';
import { createCommonAnswerer, extractTextWithImages } from '../packages/scripts/src/utils/work';
import { CommonProject } from '../packages/scripts/src/projects/common';

/** Actual page -> common answerer -> multimodal request, with transport replies held locally.
 * The font guard is controlled by promises; no model, font CDN or course server is contacted.
 */
const runtime = globalThis as any;
const oldRequest = runtime.GM_xmlhttpRequest;
const oldImageOptimize = CommonProject.scripts.settings.cfg.imageOptimize;
const wrapper: AnswererWrapper = {
	name: 'Offline upstream sync',
	url: '',
	method: 'post',
	type: 'GM_xmlhttpRequest',
	headers: {},
	handler: '',
	ai: { endpoint: 'https://upstream-sync.invalid/v1', model: 'offline-fixture', vision: true, authMode: 'none' }
};
let requests: { body: any; question: any }[] = [];
let events: string[] = [];
let checks = 0;
runtime.GM_xmlhttpRequest = (request: any) => {
	assert.equal(request.url, 'https://upstream-sync.invalid/v1/chat/completions');
	assert.equal(request.method.toUpperCase(), 'POST');
	events.push('request');
	const body = JSON.parse(request.data);
	const content = body.messages[1].content;
	requests.push({ body, question: JSON.parse(typeof content === 'string' ? content : content[0].text) });
	request.onload({
		status: 200,
		responseText: JSON.stringify({
			choices: [{ finish_reason: 'stop', message: { content: '{"answers":["B"],"uncertain":false}' } }]
		})
	});
};
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => (resolve = done));
	return { promise, resolve };
}
function fixture(optionCount = 2) {
	const root = document.createElement('section');
	root.innerHTML = '<h3>尚未解密</h3>' + '<label>旧选项</label>'.repeat(optionCount);
	const ctx: any = {
		root,
		type: 'single',
		searchInfos: [],
		elements: { title: [root.querySelector('h3')], options: [...root.querySelectorAll('label')] }
	};
	return { root, ctx, title: ctx.elements.title[0] as HTMLElement, options: ctx.elements.options as HTMLElement[] };
}
function answerer(beforeSearch?: (ctx: any) => void | Promise<void>) {
	return createCommonAnswerer({
		period: 0,
		answererWrappers: [wrapper],
		beforeSearch,
		titleTransform: (elements) => {
			events.push('title-read');
			return extractTextWithImages(elements.title[0]);
		},
		optionsTransform: (elements) => {
			events.push('options-read');
			const items = elements.options.map((option: HTMLElement) => extractTextWithImages(option));
			return {
				text: items.map((item: { text: string }) => item.text).join('\n'),
				images: items.flatMap((item: { images: string[] }) => item.images),
				items
			};
		}
	});
}
// Only PNG headers/dimensions are used by the real preflight. This is not an image decoder test.
function png(index: number) {
	const bytes = Buffer.alloc(26);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	bytes.writeUInt32BE(20 + index, 16);
	bytes.writeUInt32BE(20, 20);
	bytes[24] = 8;
	bytes[25] = 6;
	return 'data:image/png;base64,' + bytes.toString('base64');
}
async function test(name: string, run: () => Promise<void>) {
	requests = [];
	events = [];
	CommonProject.scripts.settings.cfg.imageOptimize = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			run(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Offline upstream-sync fixture timed out: ' + name)), 3000);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
	checks++;
	console.log('PASS ' + name);
}

async function main() {
	await test('awaits the font guard before reading either title or options', async () => {
		const page = fixture();
		const entered = deferred();
		const release = deferred();
		const query = answerer(async (ctx) => {
			assert.equal(ctx, page.ctx);
			events.push('hook-enter');
			entered.resolve();
			await release.promise;
			page.title.textContent = '解密完成后的题干';
			page.options[0].textContent = '明文甲';
			page.options[1].textContent = '明文乙';
			events.push('hook-complete');
		});
		const result = query(page.ctx.elements, page.ctx);
		await entered.promise;
		assert.deepEqual(events, ['hook-enter']);
		assert.equal(requests.length, 0);
		release.resolve();
		const infos = await result;
		assert.deepEqual(events, ['hook-enter', 'hook-complete', 'title-read', 'options-read', 'request']);
		assert.equal(requests[0].question.question, '解密完成后的题干');
		assert.deepEqual(
			requests[0].question.option_items.map((item: any) => item.text),
			['明文甲', '明文乙']
		);
		assert.equal(infos[0].results[0].answer, 'B');
	});
	await test('late-rendered mixed title and four image-only options retain five image roles', async () => {
		const page = fixture(4);
		const images = Array.from({ length: 5 }, (_, index) => png(index));
		const release = deferred();
		const query = answerer(async () => {
			await release.promise;
			page.title.innerHTML = `方程组<img src="${images[0]}">的解为`;
			page.options.forEach((option, index) => (option.innerHTML = `<img src="${images[index + 1]}">`));
		});
		const result = query(page.ctx.elements, page.ctx);
		assert.equal(page.root.querySelectorAll('img').length, 0);
		assert.equal(requests.length, 0);
		release.resolve();
		await result;
		assert.equal(requests.length, 1);
		const { body, question } = requests[0];
		assert.match(question.question, /方程组\s*\[图片1\]\s*的解为/);
		assert.deepEqual(question.question_image_refs, ['[图片1]']);
		assert.deepEqual(
			question.option_items.map((item: any) => item.label),
			['A', 'B', 'C', 'D']
		);
		assert.deepEqual(
			question.option_items.map((item: any) => item.image_refs),
			[['[图片2]'], ['[图片3]'], ['[图片4]'], ['[图片5]']]
		);
		assert.deepEqual(
			body.messages[1].content.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url),
			images
		);
	});
	await test('a rejected font guard stops DOM reads and prevents a model request', async () => {
		const page = fixture();
		const query = answerer(async () => {
			await Promise.resolve();
			throw new Error('offline font guard failed');
		});
		await assert.rejects(query(page.ctx.elements, page.ctx), /offline font guard failed/);
		assert.deepEqual(events, []);
		assert.equal(requests.length, 0);
	});
	await test('closing while the guard waits prevents a later paid request', async () => {
		const page = fixture();
		let closed = false;
		page.ctx.isClosed = () => closed;
		const entered = deferred();
		const release = deferred();
		const query = answerer(async () => {
			entered.resolve();
			await release.promise;
		});
		const result = query(page.ctx.elements, page.ctx);
		await entered.promise;
		closed = true;
		release.resolve();
		await assert.rejects(result, /已关闭/);
		assert.equal(requests.length, 0);
		assert.equal(events.includes('options-read'), false);
	});
	await test('pausing during the guard delays the model request until resume', async () => {
		const page = fixture();
		const entered = deferred();
		const release = deferred();
		const pausedGate = deferred();
		const resume = deferred();
		let paused = false;
		page.ctx.waitUntilActive = async () => {
			if (paused) {
				pausedGate.resolve();
				await resume.promise;
			}
		};
		const query = answerer(async () => {
			entered.resolve();
			await release.promise;
		});
		const result = query(page.ctx.elements, page.ctx);
		await entered.promise;
		paused = true;
		release.resolve();
		await pausedGate.promise;
		assert.equal(requests.length, 0);
		assert.equal(events.includes('options-read'), false);
		paused = false;
		resume.resolve();
		await result;
		assert.equal(requests.length, 1);
	});
	await test('each query reruns the guard and sends the newly rendered content', async () => {
		const page = fixture();
		let invocations = 0;
		const query = answerer(async () => {
			await Promise.resolve();
			page.title.textContent = `第${++invocations}次解密后的题干`;
		});
		await query(page.ctx.elements, page.ctx);
		await query(page.ctx.elements, page.ctx);
		assert.equal(invocations, 2);
		assert.deepEqual(
			requests.map((request) => request.question.question),
			['第1次解密后的题干', '第2次解密后的题干']
		);
	});
	await test('a previous hook failure does not prevent a later query from recovering', async () => {
		const page = fixture();
		let ready = false;
		const query = answerer(() => {
			if (!ready) throw new Error('字体未就绪');
			page.title.textContent = '重新加载后的明文';
		});
		await assert.rejects(query(page.ctx.elements, page.ctx), /字体未就绪/);
		assert.equal(requests.length, 0);
		ready = true;
		await query(page.ctx.elements, page.ctx);
		assert.equal(requests.length, 1);
		assert.equal(requests[0].question.question, '重新加载后的明文');
	});
	await test('callers without the optional hook retain their existing answer path', async () => {
		const page = fixture();
		page.title.textContent = '普通明文题目';
		await answerer()(page.ctx.elements, page.ctx);
		assert.deepEqual(events, ['title-read', 'options-read', 'request']);
		assert.equal(requests[0].question.question, '普通明文题目');
	});
	console.log(`Upstream answerer sync: ${checks} scenarios passed.`);
}
main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		runtime.GM_xmlhttpRequest = oldRequest;
		CommonProject.scripts.settings.cfg.imageOptimize = oldImageOptimize;
	});
