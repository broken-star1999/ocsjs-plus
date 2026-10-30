import assert from 'node:assert/strict';
import { createDefaultQuestionResolver } from '../packages/core/src/core/worker/question.resolver';
import { resolveMultiple } from '../packages/core/src/core/worker/resolvers/multiple';
import { isPlainAnswer } from '../packages/core/src/core/worker/utils';
import { canonicalEnsembleAnswers } from '../packages/core/src/core/answer-wrapper/ai-ensemble';
import { createCommonAnswerer } from '../packages/scripts/src/utils/work';
import { buildAnswererEnv } from '../packages/scripts/src/utils/answerer-env';

/** Read-only local DOM and transport fixtures: no API key, network or real course submission. */
const runtime = globalThis as any;
const oldRequest = runtime.GM_xmlhttpRequest;
const oldImage = Object.getOwnPropertyDescriptor(runtime, 'Image');
const oldReader = Object.getOwnPropertyDescriptor(runtime, 'FileReader');
const validPNG =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAAGklEQVR4nGNwaDhANmIY1TyqeVTzqOaB1QwAQH9YH2B8DwIAAAAASUVORK5CYII=';
const failures: string[] = [];
let checks = 0;
async function test(name: string, run: () => void | Promise<void>) {
	try {
		await run();
		checks++;
		console.log('PASS ' + name);
	} catch (error) {
		failures.push(name);
		console.error('FAIL ' + name, error);
	}
}

async function main() {
	for (const count of [9, 12, 26]) {
		await test(`valid ${count}-letter AI multiple choice travels from request through actual checkbox writes`, async () => {
			const letters = Array.from({ length: count }, (_, index) => String.fromCharCode(65 + index)).join('');
			let payload: any;
			runtime.GM_xmlhttpRequest = (request: any) => {
				payload = JSON.parse(JSON.parse(request.data).messages[1].content);
				request.onload({
					status: 200,
					responseText: JSON.stringify({
						choices: [
							{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: [letters], uncertain: false }) } }
						]
					})
				});
			};
			const host = document.createElement('section');
			host.innerHTML =
				'<h3>选择全部选项</h3>' +
				Array.from({ length: count }, (_, index) => `<label><input type="checkbox">选项${index + 1}</label>`).join('');
			document.body.append(host);
			const ctx: any = {
				root: host,
				type: 'multiple',
				elements: { title: [host.querySelector('h3')], options: [...host.querySelectorAll('label')] },
				searchInfos: []
			};
			const answerer = createCommonAnswerer({
				period: 0,
				titleTransform: (elements) => elements.title[0].textContent,
				optionsTransform: (elements) => ({
					text: elements.options.map((option: HTMLElement) => option.textContent).join('\n'),
					items: elements.options.map((option: HTMLElement) => ({ text: option.textContent }))
				}),
				answererWrappers: [
					{
						name: 'Local audit',
						url: '',
						method: 'post',
						type: 'GM_xmlhttpRequest',
						headers: {},
						handler: '',
						ai: { endpoint: 'https://audit.invalid/v1', model: 'fixture', vision: false, authMode: 'none' }
					}
				]
			});
			try {
				ctx.searchInfos = await answerer(ctx.elements, ctx);
				assert.equal(payload.option_items.length, count);
				assert.equal(ctx.searchInfos[0].ai.call.status, 'success');
				assert.deepEqual(canonicalEnsembleAnswers([letters], { type: 'multiple', title: 'all', option_count: count }), [
					letters
				]);
				let writes = 0;
				const result = await createDefaultQuestionResolver(ctx, (option) => option.textContent || '').multiple(
					ctx.searchInfos,
					ctx.elements.options,
					(_type, _answer, option) => {
						option.querySelector<HTMLInputElement>('input')!.checked = true;
						writes++;
					}
				);
				assert.equal(result.finish, true);
				assert.equal(writes, count);
				assert.ok([...host.querySelectorAll('input')].every((input) => input.checked));
			} finally {
				host.remove();
			}
		});
	}
	await test('legacy question bank helper keeps its existing eight-letter limit', () => {
		assert.equal(isPlainAnswer('ABCDEFGH'), true);
		assert.equal(isPlainAnswer('ABCDEFGHI'), false);
		assert.equal(
			resolveMultiple(
				['ABCDEFGHI'],
				Array.from({ length: 9 }, (_, index) => `选项${index + 1}`)
			).finish,
			false
		);
	});
	for (const answer of ['AA', 'CA', 'A?', 'ABJ', '答案是 A']) {
		await test(`native multiple choice still rejects invalid complete combinations before writing: ${answer}`, () => {
			assert.equal(resolveMultiple([answer], ['甲', '乙', '丙', '丁'], undefined, true).finish, false);
		});
	}
	for (const badType of ['text/html', 'application/octet-stream']) {
		await test(`same-URL retry can recover from an invalid HTTP 200 ${badType} download`, async () => {
			let downloads = 0;
			let data = `data:${badType};base64,` + Buffer.from('<html>temporary login page</html>').toString('base64');
			class FailedCORSImage {
				onerror?: () => void;
				set src(_url: string) {
					queueMicrotask(() => this.onerror?.());
				}
			}
			class Reader {
				result = '';
				onload?: () => void;
				readAsDataURL(_blob: Blob) {
					this.result = data;
					queueMicrotask(() => this.onload?.());
				}
			}
			Object.defineProperty(runtime, 'Image', { configurable: true, value: FailedCORSImage });
			Object.defineProperty(runtime, 'FileReader', { configurable: true, value: Reader });
			runtime.GM_xmlhttpRequest = (request: any) => {
				downloads++;
				request.onload({ status: 200, response: {} });
			};
			const url = `https://audit.invalid/recover-${encodeURIComponent(badType)}.png`;
			const prepare = () => buildAnswererEnv({ title: url, titleImages: [url], enableImageOptimize: true });
			const first = await prepare();
			assert.equal(first.env.expected_image_count, 1);
			assert.equal(first.env.images?.length || 0, 0);
			assert.equal(downloads, 1);
			data = validPNG;
			const retry = await prepare();
			assert.deepEqual(retry.env.images, [validPNG]);
			assert.deepEqual(retry.imageUrls, [url]);
			assert.equal(downloads, 2, 'the failed downloaded content must be fetched again after recovery');
			const cached = await prepare();
			assert.deepEqual(cached.env.images, [validPNG]);
			assert.equal(downloads, 2, 'validated successful images remain cached');
		});
	}
	if (failures.length) throw new Error(`Code audit regressions failed: ${failures.join('; ')}`);
	console.log(`AI code audit regressions: ${checks} scenarios passed.`);
}
main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		runtime.GM_xmlhttpRequest = oldRequest;
		if (oldImage) Object.defineProperty(runtime, 'Image', oldImage);
		if (oldReader) Object.defineProperty(runtime, 'FileReader', oldReader);
	});
