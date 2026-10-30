import assert from 'node:assert/strict';
import { buildAIRequest, searchAIAnswer } from '../packages/core/src/core/answer-wrapper/ai';
import { searchAIEnsemble } from '../packages/core/src/core/answer-wrapper/ai-ensemble';
import { createImageSuggestion, buildAnswererEnv } from '../packages/scripts/src/utils/answerer-env';
import { createCommonAnswerer } from '../packages/scripts/src/utils/work';
import { OCSWorker } from '../packages/core/src/core/worker/worker';
import { CommonProject } from '../packages/scripts/src/projects/common';

/** Independent offline acceptance checks. No course page or real API is used. */
const runtime = globalThis as any;
const originalRequest = runtime.GM_xmlhttpRequest;
const originalGet = runtime.GM_getValue;
const originalImage = Object.getOwnPropertyDescriptor(runtime, 'Image');
const originalCreateElement = document.createElement.bind(document);
const config = { endpoint: 'https://acceptance.invalid/v1', model: 'fixture', vision: true, authMode: 'none' as const };
const question = { type: 'single', title: '选择第二个选项', options: '甲\n乙', option_count: 2 };
// Real 20x20 JPEG generated locally with Pillow; the fixture contains no external content.
const jpeg =
	'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAUABQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigAooooAKKKKACiiigD//2Q==';
const svg =
	'data:image/svg+xml,' +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>'
	);
function png(width = 40, height = 20) {
	const bytes = Buffer.alloc(26);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	bytes[24] = 8;
	bytes[25] = 6;
	return 'data:image/png;base64,' + bytes.toString('base64');
}
function respond(request: any, answers: string[], extra: Record<string, any> = {}) {
	request.onload({
		status: 200,
		responseText: JSON.stringify({
			choices: [
				{ finish_reason: 'stop', message: { content: JSON.stringify({ answers, uncertain: false }) }, ...extra }
			]
		})
	});
}
let checks = 0;
async function test(name: string, action: () => void | Promise<void>) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.resolve().then(action),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Acceptance fixture timed out: ' + name)), 3000);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
	checks++;
	console.log('PASS ' + name);
}
async function main() {
	runtime.GM_getValue = () => 'retained-key-must-not-leak';
	await test('inline JPEG retains its real media type and exact bytes', async () => {
		const result = await createImageSuggestion('inline JPEG', '', [jpeg]);
		assert.deepEqual(result?.images, [jpeg]);
		assert.deepEqual(result?.urls, [jpeg]);
	});
	await test('generic or missing image MIME identifies the real JPEG bytes without relabeling them as PNG', async () => {
		for (const mime of ['application/octet-stream', 'binary/octet-stream', '']) {
			const source = jpeg.replace('data:image/jpeg;', `data:${mime};`);
			const result = await createImageSuggestion('generic image MIME', '', [source]);
			assert.deepEqual(result?.images, [jpeg]);
			assert.deepEqual(result?.urls, [source]);
		}
		const invalid = 'data:application/octet-stream;base64,' + Buffer.from('not an image').toString('base64');
		assert.equal(await createImageSuggestion('invalid generic bytes', '', [invalid]), undefined);
	});
	await test('CORS fallback accepts a valid JPEG served with generic Content-Type', async () => {
		const fileReaderDescriptor = Object.getOwnPropertyDescriptor(runtime, 'FileReader');
		let requests = 0;
		class CorsBlockedImage {
			crossOrigin = '';
			onload: any;
			onerror: any;
			set src(_url: string) {
				queueMicrotask(() => this.onerror?.());
			}
		}
		class GenericFileReader {
			result = '';
			onload: any;
			readAsDataURL(blob: { type: string; fixture: string }) {
				assert.equal(blob.type, 'application/octet-stream');
				this.result = blob.fixture;
				queueMicrotask(() => this.onload?.());
			}
		}
		Object.defineProperty(runtime, 'Image', { configurable: true, value: CorsBlockedImage });
		Object.defineProperty(runtime, 'FileReader', { configurable: true, value: GenericFileReader });
		runtime.GM_xmlhttpRequest = (request: any) => {
			requests++;
			request.onload({
				status: 200,
				response: { type: 'application/octet-stream', fixture: jpeg.replace('image/jpeg', 'application/octet-stream') }
			});
		};
		try {
			const result = await createImageSuggestion('fallback', '', ['https://acceptance.invalid/generic-image']);
			assert.deepEqual(result?.images, [jpeg]);
			assert.equal(requests, 1);
		} finally {
			if (originalImage) Object.defineProperty(runtime, 'Image', originalImage);
			if (fileReaderDescriptor) Object.defineProperty(runtime, 'FileReader', fileReaderDescriptor);
		}
	});
	await test('inline percent-encoded SVG is rasterized rather than relabeled as PNG', async () => {
		let decoded = '';
		class RasterImage {
			onload?: () => void;
			onerror?: () => void;
			naturalWidth = 40;
			naturalHeight = 20;
			set src(value: string) {
				decoded = value;
				this.onload?.();
			}
		}
		Object.defineProperty(runtime, 'Image', { configurable: true, value: RasterImage });
		document.createElement = ((name: string) =>
			name === 'canvas'
				? { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }), toDataURL: () => png() }
				: originalCreateElement(name)) as any;
		// This assertion tests the conversion contract; real browser rasterization is checked separately.
		runtime.GM_xmlhttpRequest = () => {
			throw new Error('No network is allowed in this fixture');
		};
		try {
			const result = await createImageSuggestion('inline SVG', '', [svg]);
			assert.equal(decoded, svg);
			assert.deepEqual(result?.images, [png()]);
		} finally {
			if (originalImage) Object.defineProperty(runtime, 'Image', originalImage);
			document.createElement = originalCreateElement;
		}
	});
	await test('malformed image data fails completeness checks before any paid AI request', async () => {
		let requests = 0;
		runtime.GM_xmlhttpRequest = () => requests++;
		for (const bad of ['data:text/html;base64,PGh0bWw+', 'data:image/png;base64,not base64!*']) {
			const { env } = await buildAnswererEnv({ title: 'bad inline', titleImages: [bad], enableImageOptimize: true });
			assert.equal(env.expected_image_count, 1);
			assert.equal(env.images?.length || 0, 0);
			const result = await searchAIAnswer(config, env as any, 1000);
			assert.equal(result.results.length, 0);
			assert.ok(result.error);
		}
		assert.equal(requests, 0);
	});
	await test('stalled image loading and its GM fallback both have bounded timeouts', async () => {
		const setTimeoutOriginal = runtime.setTimeout;
		const clearTimeoutOriginal = runtime.clearTimeout;
		const timers = new Map<object, () => void>();
		let fallback: any;
		class StalledImage {
			crossOrigin = '';
			onload: any;
			onerror: any;
			set src(_url: string) {}
		}
		Object.defineProperty(runtime, 'Image', { configurable: true, value: StalledImage });
		runtime.setTimeout = (callback: () => void, ms: number, ...args: unknown[]) => {
			if (ms !== 20_000) return setTimeoutOriginal(callback, ms, ...args);
			const token = {};
			timers.set(token, callback);
			return token;
		};
		runtime.clearTimeout = (token: object) => {
			if (!timers.delete(token)) clearTimeoutOriginal(token);
		};
		runtime.GM_xmlhttpRequest = (request: any) => (fallback = request);
		try {
			const task = createImageSuggestion('stalled image', '', ['https://acceptance.invalid/stalled.png']);
			assert.equal(timers.size, 1);
			[...timers.values()][0]();
			assert.equal(fallback.timeout, 20_000);
			assert.equal(timers.size, 1);
			[...timers.values()][0]();
			assert.equal(await task, undefined);
			assert.equal(timers.size, 0);
		} finally {
			runtime.setTimeout = setTimeoutOriginal;
			runtime.clearTimeout = clearTimeoutOriginal;
			if (originalImage) Object.defineProperty(runtime, 'Image', originalImage);
		}
	});
	await test('closing during the search interval prevents a new paid request', async () => {
		let closed = false;
		let requests = 0;
		runtime.GM_xmlhttpRequest = () => requests++;
		const answerer = createCommonAnswerer({
			titleTransform: () => 'closed interval',
			optionsTransform: () => '甲\n乙',
			answererWrappers: [{ ai: config } as any],
			period: 0.02
		});
		const task = answerer({}, { type: 'single', elements: { options: [] }, isClosed: () => closed } as any);
		closed = true;
		await assert.rejects(task, /任务已关闭/);
		assert.equal(requests, 0);
	});
	for (const action of ['close', 'pause']) {
		await test(action + ' during image preparation prevents a new paid request until allowed', async () => {
			const originalOptimize = CommonProject.scripts.settings.cfg.imageOptimize;
			const images: any[] = [];
			let closed = false;
			let paused = false;
			let release = () => {};
			const resumed = new Promise<void>((resolve) => {
				release = resolve;
			});
			let requests = 0;
			class HeldImage {
				crossOrigin = '';
				onload: any;
				onerror: any;
				naturalWidth = 40;
				naturalHeight = 20;
				set src(_url: string) {
					images.push(this);
				}
			}
			Object.defineProperty(runtime, 'Image', { configurable: true, value: HeldImage });
			document.createElement = ((name: string) =>
				name === 'canvas'
					? { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }), toDataURL: () => png() }
					: originalCreateElement(name)) as any;
			CommonProject.scripts.settings.cfg.imageOptimize = true;
			runtime.GM_xmlhttpRequest = (request: any) => {
				requests++;
				respond(request, ['B']);
			};
			const source = 'https://acceptance.invalid/preparation-' + action + '.png';
			const answerer = createCommonAnswerer({
				titleTransform: () => ({ text: 'question ' + source, images: [source] }),
				optionsTransform: () => '甲\n乙',
				answererWrappers: [{ ai: config } as any],
				period: 0
			});
			const ctx = {
				type: 'single',
				elements: { options: [originalCreateElement('label'), originalCreateElement('label')] },
				isClosed: () => closed,
				waitUntilActive: async () => {
					if (paused) await resumed;
				}
			};
			const task = answerer({}, ctx as any);
			try {
				while (!images.length) await new Promise((resolve) => setTimeout(resolve, 5));
				if (action === 'close') closed = true;
				else paused = true;
				images[0].onload();
				if (action === 'close') await assert.rejects(task, /任务已关闭/);
				else {
					await new Promise((resolve) => setTimeout(resolve, 20));
					assert.equal(requests, 0);
					paused = false;
					release();
					const result = await task;
					assert.equal(result[0].results[0].answer, 'B');
				}
				assert.equal(requests, action === 'close' ? 0 : 1);
			} finally {
				closed = true;
				release();
				await task.catch(() => {});
				CommonProject.scripts.settings.cfg.imageOptimize = originalOptimize;
				if (originalImage) Object.defineProperty(runtime, 'Image', originalImage);
				document.createElement = originalCreateElement;
			}
		});
	}
	await test('a basic 120-second model response still resolves after 71 virtual seconds', async () => {
		const originalNow = Date.now;
		const root = document.createElement('section');
		root.innerHTML =
			'<h3>long request</h3><label>甲<input name="acceptance" type="radio"></label><label>乙<input name="acceptance" type="radio"></label>';
		document.body.append(root);
		let pending: any;
		let result: any;
		let clicks = 0;
		runtime.GM_xmlhttpRequest = (request: any) => (pending = request);
		const worker = new OCSWorker({
			root: [root],
			elements: { title: 'h3', options: 'label' },
			answerer: createCommonAnswerer({
				titleTransform: () => 'long request',
				optionsTransform: () => '甲\n乙',
				answererWrappers: [
					{ name: 'basic acceptance', url: config.endpoint, ai: { ...config, timeoutSeconds: 120 } } as any
				],
				period: 0
			}),
			work: {
				type: 'single',
				optionText: (option) => option.textContent || '',
				handler: (_type, _answer, option) => {
					clicks++;
					option.querySelector('input')!.click();
				}
			},
			onResultsUpdate: (current) => {
				result = current;
			}
		});
		const task = worker.doWork();
		try {
			const started = originalNow();
			while (!pending) {
				if (originalNow() - started > 1000) throw new Error('basic request did not start');
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			assert.equal(pending.timeout, 120_000);
			const advanced = originalNow() + 71_000;
			Date.now = () => advanced;
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(
				result.resolved,
				false,
				'the resolver must not expire while the configured AI request remains valid'
			);
			respond(pending, ['B']);
			pending = undefined;
			const results = await task;
			assert.equal(results[0].result?.finish, true, JSON.stringify(results[0].ctx?.searchInfos));
			assert.equal(clicks, 1);
			assert.equal(root.querySelectorAll('input')[1].checked, true);
		} finally {
			Date.now = originalNow;
			if (pending) respond(pending, ['B']);
			await task;
			worker.emit('close');
			root.remove();
		}
	});
	for (const action of ['close', 'pause', 'pause-then-close'] as const) {
		await test(action + ' while participant calls are inflight gates the later paid summary request', async () => {
			const pending: any[] = [];
			let closed = false;
			let paused = false;
			let release = () => {};
			const resumed = new Promise<void>((resolve) => (release = resolve));
			runtime.GM_xmlhttpRequest = (request: any) => pending.push(request);
			const answerer = createCommonAnswerer({
				titleTransform: () => 'summary lifecycle',
				optionsTransform: () => '甲\n乙',
				answererWrappers: [
					{
						aiEnsemble: {
							models: [config, { ...config, model: 'second' }],
							summary: { ...config, model: 'summary' },
							rule: 'summary'
						}
					} as any
				],
				period: 0
			});
			const task = answerer({}, {
				type: 'single',
				elements: { options: [originalCreateElement('label'), originalCreateElement('label')] },
				isClosed: () => closed,
				waitUntilActive: async () => {
					if (paused) await resumed;
				}
			} as any);
			try {
				while (pending.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
				assert.ok(pending.every((request) => !request.data.includes('beforeRequest')));
				if (action === 'close') closed = true;
				else paused = true;
				respond(pending[0], ['B']);
				respond(pending[1], ['B']);
				await new Promise((resolve) => setTimeout(resolve, 20));
				assert.equal(pending.length, 2, 'no new summary HTTP may start while paused or closed');
				if (action === 'pause') {
					paused = false;
					release();
					while (pending.length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
					assert.equal(JSON.parse(pending[2].data).model, 'summary');
					assert.ok(!pending[2].data.includes('beforeRequest'));
					respond(pending[2], ['B']);
					const result = await task;
					assert.equal(result[0].ensemble?.status, 'summarized');
					assert.equal(result[0].results[0].answer, 'B');
				} else {
					closed = true;
					release();
					const result = await task;
					assert.equal(pending.length, 2);
					assert.equal(result[0].results.length, 0);
					assert.match(result[0].ensemble?.summary?.error || '', /任务已关闭/);
				}
			} finally {
				closed = true;
				release();
				for (const request of pending) respond(request, ['B']);
				await task.catch(() => {});
			}
		});
	}
	for (const status of [400, 401, 402, 403, 404, 429, 500]) {
		await test('HTTP ' + status + ' exposes a local error without returning a candidate or credentials', async () => {
			runtime.GM_xmlhttpRequest = (request: any) => {
				assert.equal(request.anonymous, true);
				assert.equal(request.headers.Authorization, undefined);
				request.onload({ status, responseText: 'retained-key-must-not-leak <script>raw upstream</script>' });
			};
			const result = await searchAIAnswer(config, question, 1000);
			assert.equal(result.results.length, 0);
			assert.equal(result.ai?.call?.status, 'error');
			assert.ok(result.error?.includes(String(status)));
			assert.ok(!JSON.stringify(result).includes('retained-key-must-not-leak'));
		});
	}
	for (const callback of ['onerror', 'ontimeout', 'onabort']) {
		await test(callback + ' settles safely without a candidate', async () => {
			runtime.GM_xmlhttpRequest = (request: any) => request[callback]();
			const result = await searchAIAnswer(config, question, 1000);
			assert.equal(result.results.length, 0);
			assert.equal(result.ai?.call?.status, 'error');
			assert.ok(result.error);
		});
	}
	for (const finishReason of ['length', 'content_filter', 'tool_calls']) {
		await test(finishReason + ' rejects even a syntactically valid final answer', async () => {
			runtime.GM_xmlhttpRequest = (request: any) => respond(request, ['B'], { finish_reason: finishReason });
			const result = await searchAIAnswer(config, question, 1000);
			assert.equal(result.results.length, 0);
			assert.match(result.error || '', /未正常完成/);
		});
	}
	await test('progress observer mutation and rejected promises cannot change the consensus result', async () => {
		runtime.GM_xmlhttpRequest = (request: any) => respond(request, ['B']);
		const result = await searchAIEnsemble(
			{ models: [config, { ...config, model: 'second' }], rule: 'confidence', threshold: 100 },
			{
				...question,
				onProgress: async (snapshot) => {
					snapshot.ensemble!.members.length = 0;
					snapshot.results.push({ question: 'injected', answer: 'A' });
					throw new Error('diagnostic listener failure');
				}
			},
			1000
		);
		assert.equal(result.ensemble?.status, 'agreed');
		assert.equal(result.ensemble?.members.length, 2);
		assert.equal(result.results.length, 1);
		assert.equal(result.results[0].answer, 'B');
	});
	await test('failed participants remain in the vote denominator at the 66 versus 67 percent boundary', async () => {
		for (const threshold of [66, 67]) {
			let index = 0;
			runtime.GM_xmlhttpRequest = (request: any) => {
				if (index++ === 0) request.ontimeout();
				else respond(request, ['B']);
			};
			const result = await searchAIEnsemble(
				{
					models: [config, { ...config, model: 'second' }, { ...config, model: 'third' }],
					rule: 'confidence',
					threshold
				},
				question,
				1000
			);
			assert.deepEqual(result.ensemble?.vote, { count: 2, total: 3, threshold });
			assert.equal(result.ensemble?.status, threshold === 66 ? 'agreed' : 'review');
			assert.equal(result.results.length, threshold === 66 ? 1 : 0);
		}
	});
	await test('bad image count and mismatched option groups are rejected before transport', () => {
		assert.throws(() => buildAIRequest(config, { ...question, expected_image_count: 2, images: [png()] }));
		assert.throws(() =>
			buildAIRequest(config, { ...question, option_items: [{ label: 'B', text: 'wrong first label' }] })
		);
	});
	console.log(`Full core acceptance: ${checks} scenarios passed (offline).`);
}
main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		runtime.GM_xmlhttpRequest = originalRequest;
		runtime.GM_getValue = originalGet;
		if (originalImage) Object.defineProperty(runtime, 'Image', originalImage);
		document.createElement = originalCreateElement;
	});
