import assert from 'node:assert/strict';
import { $, cors } from 'easy-us';
import { OCSWorker } from '../packages/core/src/core/worker/worker';
import { enableSingleQuestionRetry } from '../packages/core/src/core/worker/single-question-retry';
import { QuestionTypes, WorkResult } from '../packages/core/src/core/worker/interface';
import { searchAIAnswer } from '../packages/core/src/core/answer-wrapper/ai';
import { createCXQuestionRetryAdapter } from '../packages/scripts/src/utils/cx-question-retry';
import {
	createQuestionRetryControl,
	registerQuestionRetry,
	requestQuestionRetry
} from '../packages/scripts/src/utils/question-retry-control';

// DOM events complete synchronously in this fixture. Do not wait the platform's 500 ms pacing.
const originalSleep = $.sleep;
$.sleep = async () => {};
const originalOn = cors.on;
const originalEmit = cors.emit;
cors.on = async () => 0;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

let checks = 0;
async function test(name: string, run: () => Promise<void>) {
	await run();
	checks++;
	console.log('PASS ' + name);
}

async function fixture(type: QuestionTypes = 'single', layout: 'exam' | 'practice' = 'exam') {
	const host = document.createElement('main');
	document.body.append(host);
	const roots: HTMLElement[] = [];
	const calls = [0, 0];
	const updates: { index: number; retrying?: boolean; finish?: boolean; error?: string }[] = [];
	const clicks = [0, 0];
	let saves = 0;
	let done = 0;
	let init = 0;
	let answers =
		type === 'multiple' ? ['AC'] : type === 'judgement' ? ['正确'] : type === 'completion' ? ['旧甲', '旧乙'] : ['A'];
	let error = '';
	let responseGate: ReturnType<typeof deferred<void>> | undefined;
	const entered = deferred<void>();
	for (let q = 0; q < 2; q++) {
		const root = document.createElement('section');
		root.innerHTML = `<h3 class="title">题目 ${q + 1}<img src="https://example.test/title-${q}.png"></h3>`;
		const input = document.createElement('input');
		input.type = 'hidden';
		input.name = 'type' + q;
		input.value = type === 'single' ? '0' : type === 'multiple' ? '1' : type === 'judgement' ? '3' : '2';
		root.append(input);
		const count = type === 'completion' || type === 'judgement' ? 2 : 4;
		for (let i = 0; i < count; i++) {
			const wrap = document.createElement('div');
			const option = document.createElement('div');
			option.className = 'option';
			option.innerHTML =
				type === 'completion'
					? '<textarea></textarea>'
					: type === 'judgement'
					? i === 0
						? 'A. 对'
						: 'B. 错'
					: `<img src="https://example.test/option-${i}.png">`;
			wrap.append(option);
			root.append(wrap);
			option.onclick = () => {
				clicks[q]++;
				const wasSelected =
					layout === 'practice' ? option.classList.contains('active') : wrap.getAttribute('aria-checked') === 'true';
				if (type !== 'multiple') {
					for (const other of Array.from(root.querySelectorAll<HTMLElement>('.option'))) {
						other.classList.remove('active');
						other.parentElement!.setAttribute('aria-checked', 'false');
					}
				}
				if (layout === 'practice') option.classList.toggle('active', !wasSelected || type !== 'multiple');
				else wrap.setAttribute('aria-checked', String(!wasSelected || type !== 'multiple'));
			};
		}
		const save = document.createElement('button');
		save.setAttribute('onclick', 'saveQuestion()');
		save.onclick = () => {
			saves++;
		};
		root.append(save);
		host.append(root);
		roots.push(root);
	}
	const adapter = createCXQuestionRetryAdapter<any>({
		layout,
		type: () => type,
		optionText: (option) => (type === 'judgement' ? option.textContent! : option.querySelector('img')?.src || '')
	});
	let results: WorkResult<any>[] = [];
	const worker = new OCSWorker({
		root: roots,
		elements: { title: '.title', options: '.option', type: 'input[type="hidden"]' },
		thread: 1,
		answerer: async (_elements, ctx) => {
			const index = roots.indexOf(ctx.root);
			calls[index]++;
			if (ctx.forceSearch) {
				assert.equal(ctx.searchInfos.length, 0);
				entered.resolve();
				if (responseGate) await responseGate.promise;
			}
			if (error) throw new Error(error);
			return [
				{
					name: 'Mock AI',
					results: [{ question: '题目', answer: answers.join('#'), extra_data: { ai_native: true, answers } }]
				}
			];
		},
		work: {
			type,
			optionText: adapter.optionText,
			handler: async (kind, answer, option) => {
				if (kind === 'completion') option.querySelector('textarea')!.value = answer;
				else option.click();
			}
		},
		onResultsInit: (_result, _index, all) => {
			results = all;
			init++;
		},
		onResultsUpdate: (result, index) => {
			updates.push({ index, retrying: result.retrying, finish: result.result?.finish, error: result.error });
		}
	});
	worker.on('done', () => {
		done++;
	});
	enableSingleQuestionRetry(worker, adapter);
	await worker.doWork();
	worker.emit('done');
	updates.length = 0;
	const selection = (q = 0) =>
		Array.from(roots[q].querySelectorAll<HTMLElement>('.option')).map((option) =>
			layout === 'practice'
				? option.classList.contains('active')
				: option.parentElement!.getAttribute('aria-checked') === 'true'
		);
	return {
		worker,
		results,
		roots,
		calls,
		updates,
		clicks,
		selection,
		entered,
		setAnswers: (value: string[]) => {
			answers = value;
		},
		setError: (value: string) => {
			error = value;
		},
		gate: () => {
			responseGate = deferred<void>();
			return responseGate;
		},
		saves: () => saves,
		done: () => done,
		init: () => init,
		cleanup: () => {
			worker.emit('close');
			host.remove();
		}
	};
}

async function main() {
	for (const layout of ['exam', 'practice'] as const) {
		for (const type of ['single', 'multiple', 'judgement', 'completion'] as const) {
			await test(`${layout}: ${type} replaces only the requested question`, async () => {
				const f = await fixture(type, layout);
				const otherState = f.roots[1].innerHTML;
				const otherResult = f.results[1];
				const oldClicks = f.clicks[1];
				f.setAnswers(
					type === 'single'
						? ['D']
						: type === 'multiple'
						? ['BD']
						: type === 'judgement'
						? ['错误']
						: ['C#; <img src=x onerror=alert(1)>', '新乙']
				);
				await f.results[0].retry!();
				if (type === 'completion')
					assert.deepEqual(
						Array.from(f.roots[0].querySelectorAll('textarea')).map((el) => el.value),
						['C#; <img src=x onerror=alert(1)>', '新乙']
					);
				else
					assert.deepEqual(
						f.selection(),
						type === 'single'
							? [false, false, false, true]
							: type === 'multiple'
							? [false, true, false, true]
							: [false, true]
					);
				assert.deepEqual(f.calls, [2, 1]);
				assert.equal(f.roots[1].innerHTML, otherState);
				assert.equal(f.results[1], otherResult);
				assert.equal(f.clicks[1], oldClicks);
				assert.equal(f.results[0].result?.finish, true);
				assert.equal(f.results[0].retrying, false);
				assert.equal(f.done(), 1);
				assert.equal(f.init(), 1);
				assert.ok(f.updates.every((entry) => entry.index === 0));
				assert.equal(f.updates[0].retrying, true);
				if (type !== 'completion') assert.equal(f.saves(), 0);
				const clickCount = f.clicks[0];
				await f.results[0].retry!();
				assert.equal(f.clicks[0], clickCount, 'same answer must not toggle off');
				f.cleanup();
			});
		}
	}
	for (const bad of [['AZ'], ['AA'], [''], ['公式不应当作字母答案'], []]) {
		await test('invalid multiple answer keeps old selections: ' + JSON.stringify(bad), async () => {
			const f = await fixture('multiple');
			const before = f.selection();
			const clicks = f.clicks[0];
			f.setAnswers(bad);
			await assert.rejects(f.results[0].retry!, /未获取/);
			assert.deepEqual(f.selection(), before);
			assert.equal(f.clicks[0], clicks);
			assert.equal(f.results[0].result?.finish, false);
			assert.equal(f.results[0].retrying, false);
			f.setAnswers(['BD']);
			await f.results[0].retry!();
			assert.equal(f.results[0].result?.finish, true);
			f.cleanup();
		});
	}
	await test('blank count mismatch preserves both previous blank values', async () => {
		const f = await fixture('completion');
		f.setAnswers(['只有一个空']);
		await assert.rejects(f.results[0].retry!, /未获取/);
		assert.deepEqual(
			Array.from(f.roots[0].querySelectorAll('textarea')).map((el) => el.value),
			['旧甲', '旧乙']
		);
		f.cleanup();
	});
	await test('network failure preserves answers, updates error and can recover', async () => {
		const f = await fixture();
		f.setError('AI 请求超时');
		await assert.rejects(f.results[0].retry!, /超时/);
		assert.deepEqual(f.selection(), [true, false, false, false]);
		assert.match(f.results[0].error!, /超时/);
		f.setError('');
		f.setAnswers(['D']);
		await f.results[0].retry!();
		assert.equal(f.results[0].error, undefined);
		f.cleanup();
	});
	await test('duplicate clicks and another question are blocked during a retry', async () => {
		const f = await fixture();
		const gate = f.gate();
		f.setAnswers(['D']);
		const task = f.results[0].retry!();
		await f.entered.promise;
		await assert.rejects(f.results[0].retry!, /等待/);
		await assert.rejects(f.results[1].retry!, /等待/);
		gate.resolve();
		await task;
		assert.deepEqual(f.calls, [2, 1]);
		f.cleanup();
	});
	await test('cannot retry while the full task is running or unresolved', async () => {
		const f = await fixture();
		f.worker.isRunning = true;
		await assert.rejects(f.results[0].retry!, /等待/);
		f.worker.isRunning = false;
		f.results[1].resolved = false;
		await assert.rejects(f.results[0].retry!, /等待/);
		assert.deepEqual(f.calls, [1, 1]);
		f.cleanup();
	});
	for (const mutation of ['remove', 'replace', 'reorder', 'title', 'image', 'type', 'disabled'] as const) {
		await test('stale/disabled question is rejected before querying: ' + mutation, async () => {
			const f = await fixture();
			const root = f.roots[0];
			if (mutation === 'remove') root.remove();
			if (mutation === 'replace')
				root.querySelector('.option')!.replaceWith(root.querySelector('.option')!.cloneNode(true));
			if (mutation === 'reorder') root.append(root.querySelector('.option')!.parentElement!);
			if (mutation === 'title') root.querySelector('.title')!.append('新题');
			if (mutation === 'image') root.querySelector('img')!.src = 'https://example.test/changed.png';
			if (mutation === 'type') (root.querySelector('input') as HTMLInputElement).value = '1';
			if (mutation === 'disabled') root.setAttribute('aria-disabled', 'true');
			await assert.rejects(f.results[0].retry!, /变化|离开|不可编辑/);
			assert.deepEqual(f.calls, [1, 1]);
			f.cleanup();
		});
	}
	await test('page changes during an AI request never click detached or replacement elements', async () => {
		const f = await fixture();
		const gate = f.gate();
		f.setAnswers(['D']);
		const task = f.results[0].retry!();
		const rejected = assert.rejects(task, /变化/);
		await f.entered.promise;
		f.roots[0].querySelector('img')!.src = 'https://example.test/changed.png';
		const before = f.clicks[0];
		gate.resolve();
		await rejected;
		assert.equal(f.clicks[0], before);
		f.cleanup();
	});
	await test('closing the old task prevents late writes to the new result list', async () => {
		const f = await fixture();
		const gate = f.gate();
		const task = f.results[0].retry!();
		const rejected = assert.rejects(task, /失效/);
		await f.entered.promise;
		const count = f.updates.length;
		f.worker.emit('close');
		gate.resolve();
		await rejected;
		assert.equal(f.updates.length, count);
		assert.deepEqual(f.selection(), [true, false, false, false]);
		await assert.rejects(f.results[0].retry!, /失效/);
		f.cleanup();
	});
	await test('failed page clicks are not reported as successful fills', async () => {
		const f = await fixture();
		f.setAnswers(['D']);
		(f.roots[0].querySelectorAll('.option')[3] as HTMLElement).onclick = () => {};
		await assert.rejects(f.results[0].retry!, /未同步成功/);
		assert.equal(f.results[0].result?.finish, false);
		f.cleanup();
	});
	await test('a newer worker taking over the same DOM invalidates old in-flight retries', async () => {
		const f = await fixture();
		const gate = f.gate();
		const pending = f.results[0].retry!();
		const rejected = assert.rejects(pending, /失效/);
		await f.entered.promise;
		const newer = new OCSWorker({
			...f.worker.opts,
			onResultsInit: undefined,
			onResultsUpdate: undefined,
			answerer: async () => [
				{ name: 'New task', results: [{ question: '', answer: 'B', extra_data: { ai_native: true, answers: ['B'] } }] }
			]
		});
		enableSingleQuestionRetry(
			newer,
			createCXQuestionRetryAdapter({
				layout: 'exam',
				type: () => 'single',
				optionText: (option) => option.textContent || ''
			})
		);
		await newer.doWork();
		const updateCount = f.updates.length;
		gate.resolve();
		await rejected;
		assert.equal(f.updates.length, updateCount);
		assert.deepEqual(f.selection(), [false, true, false, false]);
		await assert.rejects(f.results[0].retry!, /失效/);
		newer.emit('close');
		f.cleanup();
	});
	await test('controlled textarea updates do not invalidate the question signature', async () => {
		const f = await fixture('completion');
		for (const input of Array.from(f.roots[0].querySelectorAll('textarea'))) {
			input.addEventListener('input', () => {
				input.defaultValue = input.value;
			});
		}
		f.setAnswers(['新甲', '新乙']);
		await f.results[0].retry!();
		assert.equal(f.results[0].result?.finish, true);
		f.setAnswers(['再甲', '再乙']);
		await f.results[0].retry!();
		assert.deepEqual(
			Array.from(f.roots[0].querySelectorAll('textarea')).map((input) => input.value),
			['再甲', '再乙']
		);
		f.cleanup();
	});
	await test('rich-text blanks stay plain text and dispatch only their own input events', async () => {
		const f = await fixture('completion');
		let inputs = 0;
		for (const option of Array.from(f.roots[0].querySelectorAll<HTMLElement>('.option'))) {
			const iframe = document.createElement('iframe');
			option.append(iframe);
			iframe.contentDocument!.body.innerHTML = '<p>旧内容</p>';
			option.querySelector('textarea')!.addEventListener('input', () => {
				inputs++;
			});
		}
		f.setAnswers(['<img src=x onerror=alert(1)>', 'a;b']);
		await f.results[0].retry!();
		assert.equal(inputs, 2);
		const bodies = Array.from(f.roots[0].querySelectorAll('iframe')).map((frame) => frame.contentDocument!.body);
		assert.equal(bodies[0].textContent, '<img src=x onerror=alert(1)>');
		assert.equal(bodies[0].querySelector('img'), null);
		assert.equal(bodies[1].textContent, 'a;b');
		f.cleanup();
	});
	for (const marker of ['check_answer', 'input'] as const) {
		await test('multiple choice replaces native ' + marker + ' selection state', async () => {
			const f = await fixture('multiple');
			const options = Array.from(f.roots[0].querySelectorAll<HTMLElement>('.option'));
			const isSelected = (option: HTMLElement) =>
				marker === 'input'
					? !!option.parentElement!.querySelector('input')?.checked
					: !!option.parentElement!.querySelector('.check_answer');
			for (const [index, option] of options.entries()) {
				const wrap = option.parentElement!;
				wrap.removeAttribute('aria-checked');
				if (marker === 'input') {
					const input = document.createElement('input');
					input.type = 'checkbox';
					input.checked = index === 0 || index === 2;
					wrap.append(input);
				} else if (index === 0 || index === 2) {
					const span = document.createElement('span');
					span.className = 'check_answer';
					wrap.append(span);
				}
				option.onclick = () => {
					if (marker === 'input') {
						const input = wrap.querySelector('input')!;
						input.checked = !input.checked;
					} else if (isSelected(option)) wrap.querySelector('.check_answer')!.remove();
					else {
						const span = document.createElement('span');
						span.className = 'check_answer';
						wrap.append(span);
					}
				};
			}
			f.setAnswers(['BD']);
			await f.results[0].retry!();
			assert.deepEqual(options.map(isSelected), [false, true, false, true]);
			f.cleanup();
		});
	}
	await test('real AI parser output feeds the retry plan and reasoning stays separate', async () => {
		const f = await fixture();
		(globalThis as any).GM_xmlhttpRequest = (request: any) =>
			request.onload({
				status: 200,
				responseText: JSON.stringify({
					choices: [
						{
							finish_reason: 'stop',
							message: { content: '{"answers":["D"],"uncertain":false}', reasoning_content: 'A is reasoning only' }
						}
					]
				})
			});
		f.worker.opts.answerer = async () => [
			await searchAIAnswer(
				{ endpoint: 'https://example.test/v1', model: 'mock', vision: true },
				{
					title: '图片选择题',
					type: 'single',
					images: ['data:image/png;base64,AA=='],
					suggestion_title: '[图片1]',
					suggestion_options: '[图片2]\\n[图片3]\\n[图片4]\\n[图片5]'
				},
				1000
			)
		];
		await f.results[0].retry!();
		assert.deepEqual(f.selection(), [false, false, false, true]);
		assert.equal(f.results[0].ctx?.searchInfos[0].ai?.reasoning, 'A is reasoning only');
		f.cleanup();
	});
	await test('button invokes one registered question; unsupported tasks have no button', async () => {
		const f = await fixture();
		f.setAnswers(['D']);
		const retry = registerQuestionRetry(f.results[0])!;
		assert.equal(registerQuestionRetry(f.results[0])?.id, retry.id);
		assert.doesNotMatch(JSON.stringify(retry), /function|elements|searchInfos/);
		const control = createQuestionRetryControl({ retry, resolved: true } as any, false);
		document.body.append(control);
		const button = control.querySelector('button')!;
		await button.onclick!({} as MouseEvent);
		assert.deepEqual(f.calls, [2, 1]);
		assert.ok(createQuestionRetryControl({ retry, resolved: true } as any, true).querySelector('button')!.disabled);
		assert.equal(createQuestionRetryControl({ resolved: true } as any, false).querySelector('button'), null);
		await assert.rejects(requestQuestionRetry({ id: 'expired', frame: retry.frame }), /失效/);
		control.remove();
		f.cleanup();
	});
	await test('iframe command goes only to its owning frame and reports receipt errors', async () => {
		cors.emit = (name, args, callback) => {
			assert.equal(name, 'other-frame-session');
			assert.equal(args![0], 'question-token');
			assert.ok(args![1] > Date.now());
			callback!('该题已失效');
		};
		await assert.rejects(requestQuestionRetry({ id: 'question-token', frame: 'other-frame-session' }), /失效/);
	});
	console.log(`Single-question retry: ${checks} scenarios passed.`);
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		$.sleep = originalSleep;
		cors.on = originalOn;
		cors.emit = originalEmit;
	});
