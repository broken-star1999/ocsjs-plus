import assert from 'node:assert/strict';
import { cors, $modal } from 'easy-us';
import { canonicalEnsembleAnswers, searchAIEnsemble } from '../packages/core/src/core/answer-wrapper/ai-ensemble';
import {
	createAIAnswererWrappers,
	aiModelKey,
	AIProviderState
} from '../packages/core/src/core/answer-wrapper/ai-providers';
import { getAIKeyStorage } from '../packages/core/src/core/answer-wrapper/ai';
import { defaultAnswerWrapperHandler } from '../packages/core/src/core/answer-wrapper/answer.wrapper.handler';
import { createDefaultQuestionResolver } from '../packages/core/src/core/worker/question.resolver';
import { OCSWorker, CustomOCSWorker } from '../packages/core/src/core/worker/worker';
import { AnswerWrapperHandlerConfig } from '../packages/core/src/core/answer-wrapper/answer.wrapper.handler';
import { enableSingleQuestionRetry } from '../packages/core/src/core/worker/single-question-retry';
import { createCXQuestionRetryAdapter } from '../packages/scripts/src/utils/cx-question-retry';
import {
	createAIConsensusSettings,
	createAIConsensusSettingsButton,
	AIConsensusSettings
} from '../packages/scripts/src/utils/ai-consensus-settings';
import { createAIEnsembleDetails } from '../packages/scripts/src/elements/ai-ensemble-details';
import {
	registerManualReview,
	createQuestionRetryControl,
	requestQuestionRetry,
	serializeManualReview
} from '../packages/scripts/src/utils/question-retry-control';

const state: AIProviderState = {
	selection: aiModelKey('one', 'a'),
	sources: ['one', 'two'].map((id, i) => ({
		id,
		name: id,
		preset: 'openai',
		endpoint: 'https://' + id + '.example/v1',
		timeoutSeconds: 10,
		catalog: [],
		models: [{ id: i ? 'b' : 'a', name: i ? 'Model B' : 'Model A', enabled: true, vision: true, extraBody: {} }]
	}))
};
const assignments = [
	{ key: aiModelKey('one', 'a'), threads: 3 },
	{ key: aiModelKey('two', 'b'), threads: 2 }
];
const configs = createAIAnswererWrappers(state, true, assignments)[0].aiEnsemble!;
const question = { title: '题目', type: 'single', options: 'A.甲\nB.乙\nC.丙\nD.丁' };
let requests: any[] = [];
const runtime = globalThis as any;
// The test DOM predates replaceChildren; browser builds use the native API.
if (!Element.prototype.replaceChildren)
	Element.prototype.replaceChildren = function (...nodes: (Node | string)[]) {
		while (this.firstChild) this.removeChild(this.firstChild);
		for (const node of nodes) this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
	};
runtime.GM_getValue = (key: string) =>
	key === getAIKeyStorage(state.sources[0].endpoint, 'one') ? 'one-key' : 'two-key';
function install(answers: (request: any, index: number) => string[] | 'error' | 'uncertain' | 'invalid', hold = false) {
	requests = [];
	runtime.GM_xmlhttpRequest = (request: any) => {
		const index = requests.length;
		requests.push(request);
		request.respond = () => {
			const result = answers(request, index);
			if (result === 'error') return request.onload({ status: 401, responseText: '' });
			request.onload({
				status: 200,
				responseText: JSON.stringify({
					choices: [
						{
							finish_reason: 'stop',
							message: {
								content:
									result === 'invalid'
										? 'not json'
										: JSON.stringify({
												answers: result === 'uncertain' ? [] : result,
												uncertain: result === 'uncertain'
										  }),
								reasoning_content: 'reasoning-' + index + ' <img src=x onerror=alert(1)> '
							}
						}
					],
					usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
				})
			});
		};
		if (!hold) request.respond();
	};
}
let checks = 0;
async function test(name: string, action: () => Promise<void> | void) {
	await action();
	checks++;
	console.log('PASS ' + name);
}
const waitUntil = async (predicate: () => boolean) => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > 4000) throw new Error('test timed out');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

async function workerFixture(disagree = true, custom = false, retry = false) {
	install((_request, index) => (disagree && index % 2 ? ['B'] : ['A']));
	const config = { ...configs, models: configs.models.slice(0, 2) };
	const root = document.createElement('section');
	root.innerHTML =
		'<h3>题目</h3><label>A<input type="radio" name="choice" value="A"></label><label>B<input type="radio" name="choice" value="B"></label>';
	document.body.append(root);
	root.querySelectorAll('input').forEach((input) =>
		input.addEventListener('change', () => {
			root
				.querySelectorAll('label')
				.forEach((label) => label.classList.toggle('active', label.querySelector('input')!.checked));
		})
	);
	let result: any;
	let clicks = 0;
	let settled = false;
	let resolverCalls = 0;
	const worker = custom
		? new CustomOCSWorker({
				questions: () => [{ text: '题目', type: 'single' }],
				period: 0,
				answerer: async () => [await searchAIEnsemble(config, question, 1000)],
				resolver: async () => {
					resolverCalls++;
					return { finish: true };
				},
				onResultsUpdate: (current) => {
					result = current;
				}
		  })
		: new OCSWorker({
				root: [root],
				elements: { title: 'h3', options: 'label' },
				answerer: async () => [await searchAIEnsemble(config, question, 1000)],
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
	if (retry && worker instanceof OCSWorker)
		enableSingleQuestionRetry(
			worker,
			createCXQuestionRetryAdapter({
				layout: 'practice',
				type: () => 'single',
				optionText: (option) => option.textContent || ''
			})
		);
	const task = worker.doWork().then((value) => {
		settled = true;
		return value;
	});
	await waitUntil(() => result?.resolved === true);
	return {
		worker,
		root,
		task,
		result: () => result,
		settled: () => settled,
		clicks: () => clicks,
		resolverCalls: () => resolverCalls,
		cleanup: () => {
			worker.emit('close');
			root.remove();
		}
	};
}

async function main() {
	await test('ordinary mode remains one model and ignores advanced settings', () => {
		const wrappers = createAIAnswererWrappers(state, false, assignments, { threshold: 1, summaryEnabled: true });
		assert.equal(wrappers.length, 1);
		assert.equal(wrappers[0].ai?.model, 'a');
		assert.equal(wrappers[0].aiEnsemble, undefined);
	});
	await test('per-model thread counts produce three A calls and two B calls concurrently', async () => {
		install(() => ['D'], true);
		const pending = searchAIEnsemble(configs, { ...question, images: ['data:image/png;base64,AA=='] }, 1000);
		assert.equal(requests.length, 5, 'all requests must start before the first response');
		assert.deepEqual(
			requests.map((request) => JSON.parse(request.data).model),
			['a', 'a', 'a', 'b', 'b']
		);
		assert.equal(requests[0].headers.Authorization, 'Bearer one-key');
		assert.equal(requests[4].headers.Authorization, 'Bearer two-key');
		assert.ok(requests.every((request) => JSON.parse(request.data).messages[1].content[1].type === 'image_url'));
		requests
			.slice()
			.reverse()
			.forEach((request) => request.respond());
		const result = await pending;
		assert.equal(result.results[0].answer, 'D');
		assert.equal(result.ensemble?.members.length, 5);
		assert.match(result.ensemble!.members[0].name, /第 1 次/);
		assert.match(result.ensemble!.members[2].name, /第 3 次/);
		assert.match(result.ensemble!.members[3].name, /第 1 次/);
		assert.ok(!JSON.stringify(result).includes('one-key'));
		assert.ok(!JSON.stringify(result).includes('base64'));
	});
	await test('one model with three threads is explicitly supported', async () => {
		install(() => ['A']);
		const wrapper = createAIAnswererWrappers(state, true, [assignments[0]])[0];
		const result = await defaultAnswerWrapperHandler([wrapper], question);
		assert.equal(requests.length, 3);
		assert.equal(result[0].results[0].answer, 'A');
	});
	for (const threads of [0, -1, 1.5, 9, NaN])
		await test('invalid thread count is blocked: ' + threads, async () => {
			install(() => ['A']);
			const wrapper = createAIAnswererWrappers(state, true, [{ key: assignments[0].key, threads }])[0];
			const info = await defaultAnswerWrapperHandler([wrapper], question);
			assert.equal(requests.length, 0);
			assert.equal(info[0].results.length, 0);
		});
	await test('disabled models, duplicate rows, missing summary and too few calls fail closed', () => {
		assert.ok(createAIAnswererWrappers(state, true, [{ ...assignments[0], threads: 1 }])[0].aiEnsemble?.error);
		assert.ok(createAIAnswererWrappers(state, true, [assignments[0], assignments[0]])[0].aiEnsemble?.error);
		assert.ok(createAIAnswererWrappers({ ...state, sources: [] }, true, assignments)[0].aiEnsemble?.error);
		assert.ok(createAIAnswererWrappers(state, true, assignments, { summaryEnabled: true })[0].aiEnsemble?.error);
	});
	for (const [type, values, expected] of [
		['single', ['b'], ['B']],
		['multiple', ['CA'], ['AC']],
		['judgement', ['对'], ['正确']],
		['completion', ['C#;a,b', '2'], ['C#;a,b', '2']]
	] as const) {
		await test('canonical answer boundaries: ' + type, () => {
			assert.deepEqual(canonicalEnsembleAnswers([...values], { ...question, type }), [...expected]);
		});
	}
	await test('75 percent accepts 3 of 4 and records exact denominator', async () => {
		install((_request, i) => (i === 3 ? ['B'] : ['D']));
		const result = await searchAIEnsemble(
			{ ...configs, models: configs.models.slice(0, 4), threshold: 75 },
			question,
			1000
		);
		assert.equal(result.results[0].answer, 'D');
		assert.deepEqual(result.ensemble?.vote, { count: 3, total: 4, threshold: 75 });
	});
	await test('80 percent rejects the same 3 of 4, default requires all', async () => {
		for (const threshold of [80, undefined]) {
			install((_request, i) => (i === 3 ? ['B'] : ['D']));
			const result = await searchAIEnsemble(
				{ ...configs, models: configs.models.slice(0, 4), threshold },
				question,
				1000
			);
			assert.equal(result.results.length, 0);
			assert.equal(result.ensemble?.status, 'review');
		}
	});
	await test('ties are manual even at 50 percent', async () => {
		install((_request, i) => (i % 2 ? ['B'] : ['A']));
		const result = await searchAIEnsemble(
			{ ...configs, models: configs.models.slice(0, 4), threshold: 50 },
			question,
			1000
		);
		assert.equal(result.results.length, 0);
	});
	for (const failure of ['error', 'uncertain', 'invalid'] as const)
		await test('failures count in denominator: ' + failure, async () => {
			install((_request, i) => (i === 3 ? failure : ['A']));
			const result = await searchAIEnsemble(
				{ ...configs, models: configs.models.slice(0, 4), threshold: 75 },
				question,
				1000
			);
			assert.equal(result.results[0].answer, 'A');
			assert.equal(result.ensemble?.vote?.total, 4);
			assert.ok(result.ensemble?.members[3].error);
		});
	await test('fill blanks are strict even with a low objective threshold', async () => {
		install((_request, i) => (i === 4 ? ['different', '乙'] : ['甲', '乙']));
		const result = await searchAIEnsemble({ ...configs, threshold: 50 }, { ...question, type: 'completion' }, 1000);
		assert.equal(result.results.length, 0);
		assert.equal(result.ensemble?.vote?.threshold, 100);
	});
	for (const type of ['completion', 'unknown'])
		await test('incidental choice words never lower the strict threshold: ' + type, async () => {
			install((_request, i) => (i === 4 ? ['B'] : ['A']));
			const result = await searchAIEnsemble(
				{ ...configs, threshold: 50 },
				{ ...question, type, title: '请解释单选题与多选题的区别。' },
				1000
			);
			assert.equal(result.ensemble?.status, 'review');
			assert.equal(result.ensemble?.vote?.threshold, 100);
			assert.equal(result.results.length, 0);
		});
	await test('an explicit completion type preserves separate blanks despite a leading choice label', async () => {
		install(() => ['A', 'B']);
		const result = await searchAIEnsemble(
			configs,
			{ ...question, type: 'completion', title: '多选题：请把这个词填入第一个空，字母填入第二个空。' },
			1000
		);
		assert.equal(result.results[0].answer, 'A#B');
		assert.equal(result.ensemble?.vote?.threshold, 100);
		for (const request of requests)
			assert.equal(JSON.parse(JSON.parse(request.data).messages[1].content).type, 'completion');
	});
	await test('untyped judgement labels use one type consistently for requests, parsing and voting', async () => {
		install((_request, i) => (i % 2 ? ['A'] : ['错误']));
		const result = await searchAIEnsemble(
			configs,
			{ type: 'unknown', title: '1. (判断题, 5 分) 题干', options: 'A. 错\nB. 对' },
			1000
		);
		assert.equal(result.ensemble?.status, 'agreed');
		assert.equal(result.results[0].answer, '错误');
		for (const request of requests) {
			const body = JSON.parse(request.data);
			assert.equal(JSON.parse(body.messages[1].content).type, 'judgement');
			assert.match(body.messages[0].content, /本题为判断题/);
		}
	});
	await test('judgment aliases agree without comparing reasoning', async () => {
		install((_request, i) => (i % 2 ? ['正确'] : ['对']));
		const result = await searchAIEnsemble(configs, { ...question, type: 'judgement' }, 1000);
		assert.equal(result.results[0].answer, '正确');
	});
	for (const type of ['judgement', 'single'])
		await test('judgment letters agree with truth words using reversed actual options: ' + type, async () => {
			install((_request, i) => (i % 2 ? ['B'] : ['正确']));
			const result = await searchAIEnsemble(configs, { ...question, type, options: 'A. 错\nB. 对' }, 1000);
			assert.equal(result.ensemble?.status, 'agreed');
			assert.equal(result.results[0].answer, '正确');
			assert.equal(result.ensemble?.vote?.count, 5);
		});
	await test('summary receives every answer and reasoning, images and its own scoped key', async () => {
		const summary = { ...configs.models[4], model: 'summary', label: '总结模型' };
		install((request, i) => (JSON.parse(request.data).model === 'summary' ? ['C'] : i % 2 ? ['B'] : ['A']));
		const result = await searchAIEnsemble(
			{ ...configs, summary, rule: 'confidence-then-summary' },
			{ ...question, images: ['data:image/png;base64,AA=='] },
			1000
		);
		assert.equal(requests.length, 6);
		assert.equal(result.ensemble?.status, 'summarized');
		assert.equal(result.results[0].answer, 'C');
		const request = requests[5];
		const content = JSON.parse(request.data).messages[1].content;
		const payload = JSON.parse(content[0].text);
		assert.equal(payload.model_reports.length, 5);
		assert.match(payload.model_reports[0].reasoning, /reasoning-0/);
		assert.deepEqual(payload.model_reports[1].answers, ['B']);
		assert.equal(content[1].type, 'image_url');
		assert.equal(request.headers.Authorization, 'Bearer two-key');
		assert.ok(!JSON.stringify(payload).includes('one-key'));
		assert.ok(!JSON.stringify(payload).includes('two-key'));
	});
	await test('passing threshold never calls summary; failed summary never falls back to a candidate', async () => {
		const summary = { ...configs.models[0], model: 'summary' };
		install(() => ['A']);
		await searchAIEnsemble({ ...configs, summary, rule: 'confidence-then-summary' }, question, 1000);
		assert.equal(requests.length, 5);
		install((request, i) => (JSON.parse(request.data).model === 'summary' ? 'error' : i % 2 ? ['B'] : ['A']));
		const result = await searchAIEnsemble({ ...configs, summary, rule: 'confidence-then-summary' }, question, 1000);
		assert.equal(result.results.length, 0);
		assert.ok(result.ensemble?.summary?.error);
	});
	for (const rule of [
		'manual',
		'unanimous',
		'confidence',
		'summary',
		'confidence-then-summary',
		'summary-then-confidence'
	] as const) {
		await test('decision rule matrix: ' + rule, async () => {
			const summary = { ...configs.models[0], model: 'summary' };
			install((request, index) => (JSON.parse(request.data).model === 'summary' ? ['C'] : index === 3 ? ['B'] : ['D']));
			const result = await searchAIEnsemble(
				{ ...configs, models: configs.models.slice(0, 4), threshold: 75, rule, summary },
				question,
				1000
			);
			const expected =
				rule === 'manual' || rule === 'unanimous'
					? undefined
					: rule === 'summary' || rule === 'summary-then-confidence'
					? 'C'
					: 'D';
			assert.equal(result.results[0]?.answer, expected);
			assert.equal(requests.length, rule === 'summary' || rule === 'summary-then-confidence' ? 5 : 4);
		});
	}
	await test('summary-first falls back to confidence only after a failed summary', async () => {
		install((request, index) => (JSON.parse(request.data).model === 'summary' ? 'error' : index === 3 ? ['B'] : ['D']));
		const result = await searchAIEnsemble(
			{
				...configs,
				models: configs.models.slice(0, 4),
				threshold: 75,
				rule: 'summary-then-confidence',
				summary: { ...configs.models[0], model: 'summary' }
			},
			question,
			1000
		);
		assert.equal(result.results[0].answer, 'D');
		assert.ok(result.ensemble?.summary?.error);
	});
	await test('manual rule never auto-fills even when every model agrees', async () => {
		install(() => ['A']);
		const result = await searchAIEnsemble({ ...configs, rule: 'manual' }, question, 1000);
		assert.equal(result.results.length, 0);
		assert.equal(result.ensemble?.status, 'review');
	});
	await test('disabled capability cannot be used by an active decision rule', () => {
		assert.ok(
			createAIAnswererWrappers(state, true, assignments, { rule: 'unanimous', confidenceEnabled: false })[0].aiEnsemble
				?.error
		);
		assert.ok(
			createAIAnswererWrappers(state, true, assignments, { rule: 'confidence', confidenceEnabled: false })[0].aiEnsemble
				?.error
		);
		assert.ok(
			createAIAnswererWrappers(state, true, assignments, { rule: 'summary', summaryEnabled: false })[0].aiEnsemble
				?.error
		);
	});
	for (const rule of ['unexpected', 'toString', 'summary'] as const) {
		await test('invalid rule or missing summary makes no paid requests: ' + rule, async () => {
			install(() => ['A']);
			const info = await searchAIEnsemble({ ...configs, rule: rule as any, summary: undefined }, question, 1000);
			assert.equal(requests.length, 0);
			assert.equal(info.ensemble?.status, 'review');
			assert.match(info.error!, /规则|总结模型/);
		});
	}
	await test('review blocks all default resolver paths even if an individual answer is present', async () => {
		install((_request, i) => (i % 2 ? ['B'] : ['A']));
		const info = await searchAIEnsemble(configs, question, 1000);
		info.results = [{ question: '', answer: 'A', extra_data: { ai_native: true, answers: ['A'] } }];
		for (const resolver of Object.values(createDefaultQuestionResolver({} as any))) {
			let clicks = 0;
			assert.equal(
				(
					await resolver([info], [], () => {
						clicks++;
					})
				).finish,
				false
			);
			assert.equal(clicks, 0);
		}
	});
	await test('worker waits for a real human acknowledgment, blocks force upload and never writes the minority', async () => {
		const f = await workerFixture();
		assert.equal(f.settled(), false);
		assert.equal(f.clicks(), 0);
		let uploads = 0;
		const worker = f.worker as OCSWorker;
		worker.uploadHandler({
			results: [f.result()],
			type: 'force',
			callback: () => {
				uploads++;
			}
		});
		assert.equal(uploads, 0);
		f.root.querySelectorAll('input')[1].click();
		await f.result().confirmReview();
		await f.task;
		assert.equal(f.clicks(), 0);
		assert.equal(f.result().result.manual, true);
		assert.equal(f.root.querySelectorAll('input')[1].checked, true);
		worker.uploadHandler({
			results: [f.result()],
			type: 'force',
			callback: () => {
				uploads++;
			}
		});
		assert.equal(uploads, 1);
		f.cleanup();
	});
	await test('agreed answers fill without requiring a manual confirmation', async () => {
		const f = await workerFixture(false);
		await f.task;
		assert.equal(f.clicks(), 1);
		assert.equal(f.result().result.finish, true);
		assert.equal(f.root.querySelector('input')!.checked, true);
		f.cleanup();
	});
	await test('pending human review disables retry and the running worker rejects direct retry', async () => {
		const f = await workerFixture(true, false, true);
		assert.equal(f.worker.isRunning, true);
		const button = createQuestionRetryControl(
			{
				resolved: true,
				retry: { frame: '', id: '' },
				searchInfos: [{ ensemble: f.result().ctx.searchInfos[0].ensemble }]
			} as any,
			false
		).querySelector('button')!;
		assert.equal(button.disabled, true);
		await assert.rejects(f.result().retry, /等待当前/);
		f.cleanup();
		await f.task;
	});
	for (const custom of [false, true]) {
		await test(
			'failed confirmation storage rolls back and can be retried: ' + (custom ? 'custom' : 'default'),
			async () => {
				const f = await workerFixture(true, custom);
				const original = f.worker.opts.onResultsUpdate;
				let fail = true;
				(f.worker.opts as any).onResultsUpdate = async (...args: any[]) => {
					if (fail) {
						fail = false;
						throw new Error('storage failure');
					}
					await (original as any)?.(...args);
				};
				const confirm = custom ? f.result()._confirmReview : f.result().confirmReview;
				await assert.rejects(confirm, /storage failure/);
				assert.equal(custom ? f.result().finish : f.result().result.finish, false);
				assert.equal((custom ? f.result().searchInfos : f.result().ctx.searchInfos)[0].ensemble.status, 'review');
				assert.equal(f.settled(), false);
				await confirm();
				await f.task;
				assert.equal(custom ? f.result().finish : f.result().result.finish, true);
				f.cleanup();
			}
		);
	}
	await test('an extended query deadline waits for sequential model work instead of resolving too early', async () => {
		const before = AnswerWrapperHandlerConfig.timeout_seconds;
		AnswerWrapperHandlerConfig.timeout_seconds = -9.99; // Compress the ordinary 10-second grace for this controlled test.
		const root = document.createElement('section');
		root.innerHTML = '<h3>题目</h3><label>A</label>';
		document.body.append(root);
		let result: any;
		let clicks = 0;
		const worker = new OCSWorker({
			root: [root],
			elements: { title: 'h3', options: 'label' },
			answerer: async (_elements, ctx) => {
				ctx.searchDeadline = Date.now() + 1500;
				await new Promise((resolve) => setTimeout(resolve, 250));
				return [
					{ name: 'delayed', results: [{ question: '', answer: 'A', extra_data: { ai_native: true, answers: ['A'] } }] }
				];
			},
			work: {
				type: 'single',
				optionText: (option) => option.textContent || '',
				handler: () => {
					clicks++;
				}
			},
			onResultsUpdate: (current) => {
				result = current;
			}
		});
		try {
			await worker.doWork();
			assert.equal(result.result.finish, true);
			assert.equal(clicks, 1);
		} finally {
			AnswerWrapperHandlerConfig.timeout_seconds = before;
			worker.emit('close');
			root.remove();
		}
	});
	await test('single-question redo can produce a review while preserving the old page answer', async () => {
		const f = await workerFixture(false, false, true);
		await f.task;
		install((_request, index) => (index % 2 ? ['B'] : ['A']));
		await assert.rejects(f.result().retry, /人工/);
		assert.equal(f.root.querySelector('input')!.checked, true);
		f.root.querySelectorAll('input')[1].click();
		await f.result().confirmReview();
		assert.equal(f.result().result.manual, true);
		assert.equal(f.root.querySelectorAll('input')[1].checked, true);
		f.cleanup();
	});
	await test('close releases a waiting task and invalidates old confirmations', async () => {
		const f = await workerFixture();
		const confirm = f.result().confirmReview;
		f.cleanup();
		await f.task;
		await assert.rejects(confirm, /关闭/);
		assert.equal(f.clicks(), 0);
	});
	for (const custom of [false, true]) {
		await test(
			'closing before a delayed answer blocks late page and result writes: ' + (custom ? 'custom' : 'default'),
			async () => {
				const root = document.createElement('section');
				root.innerHTML = '<h3>题目</h3><label>A</label>';
				document.body.append(root);
				let release!: () => void;
				let started = false;
				let writes = 0;
				let clicks = 0;
				const answerer = async () => {
					started = true;
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return [
						{ name: 'delayed', results: [], ensemble: { status: 'review' as const, reason: 'review', members: [] } }
					];
				};
				const worker = custom
					? new CustomOCSWorker({
							questions: () => [{ text: '题目', type: 'single' }],
							period: 0,
							answerer,
							resolver: async () => {
								clicks++;
								return { finish: true };
							},
							onResultsUpdate: () => {
								writes++;
							}
					  })
					: new OCSWorker({
							root: [root],
							elements: { title: 'h3', options: 'label' },
							answerer,
							work: {
								type: 'single',
								handler: () => {
									clicks++;
								}
							},
							onResultsUpdate: () => {
								writes++;
							}
					  });
				const task = worker.doWork();
				await waitUntil(() => started);
				worker.emit('close');
				const before = writes;
				release();
				await task;
				assert.equal(writes, before);
				assert.equal(clicks, 0);
				assert.equal(worker.isRunning, false);
				root.remove();
			}
		);
	}
	await test('custom workers bypass their resolver until a user handles the disagreement', async () => {
		const f = await workerFixture(true, true);
		assert.equal(f.resolverCalls(), 0);
		assert.equal(f.settled(), false);
		const originalOn = cors.on;
		cors.on = async () => 0;
		const serialized = serializeManualReview(f.result());
		assert.equal(serialized._confirmReview, undefined);
		assert.ok(serialized.reviewControl);
		await requestQuestionRetry(serialized.reviewControl!);
		await f.task;
		assert.equal(f.result().finish, true);
		cors.on = originalOn;
		f.cleanup();
	});
	await test('review details render model text without executing HTML', async () => {
		install((_request, i) => (i % 2 ? ['B'] : ['A']));
		const result = await searchAIEnsemble(configs, question, 1000);
		const panel = createAIEnsembleDetails(result.ensemble!);
		assert.equal(panel.querySelector('img'), null);
		assert.match(panel.textContent!, /reasoning-0/);
	});
	await test('advanced UI persists per-model counts, threshold and optional summary, basic hides it', () => {
		let value: AIConsensusSettings = {
			mode: 'basic',
			assignments: [],
			sources: state.sources,
			threshold: 100,
			confidenceEnabled: true,
			rule: 'confidence',
			summaryEnabled: false,
			summaryKey: ''
		};
		let update = () => {};
		const root = createAIConsensusSettings({
			read: () => value,
			write: (patch) => {
				value = { ...value, ...patch };
				update();
			},
			observe: (listener) => {
				update = listener;
				return () => {};
			}
		});
		document.body.append(root);
		assert.equal(root.style.display, 'none');
		value.mode = 'advanced';
		update();
		const checkbox = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		checkbox.checked = true;
		checkbox.onchange!({} as Event);
		const count = root.querySelector<HTMLInputElement>('input[type="number"]')!;
		count.value = '3';
		count.onchange!({} as Event);
		assert.equal(value.assignments[0].threads, 3);
		const threshold = root.querySelector<HTMLInputElement>('[aria-label="置信度阈值（一致率）"]')!;
		threshold.value = '75';
		threshold.onchange!({} as Event);
		assert.equal(value.threshold, 75);
		const summary = root.querySelector<HTMLInputElement>('[aria-label="启用总结模型"]')!;
		summary.checked = true;
		summary.onchange!({} as Event);
		assert.equal(value.summaryEnabled, true);
		value.mode = 'basic';
		update();
		assert.equal(root.style.display, 'none');
		root.remove();
	});
	for (const [confidenceEnabled, summaryEnabled, expected] of [
		[false, false, ['manual']],
		[true, false, ['manual', 'unanimous', 'confidence']],
		[false, true, ['manual', 'summary']],
		[true, true, ['manual', 'unanimous', 'confidence', 'summary', 'confidence-then-summary', 'summary-then-confidence']]
	] as const) {
		await test(`rule choices only show enabled capabilities: confidence=${confidenceEnabled}, summary=${summaryEnabled}`, () => {
			const value: AIConsensusSettings = {
				mode: 'advanced',
				assignments,
				sources: state.sources,
				threshold: 100,
				confidenceEnabled,
				summaryEnabled,
				summaryKey: '',
				rule: 'manual'
			};
			const root = createAIConsensusSettings({ read: () => value, write: () => {}, observe: () => () => {} });
			const rule = root.querySelector<HTMLSelectElement>('[aria-label="决策规则"]')!;
			assert.deepEqual(
				[...rule.options].map((option) => option.value),
				[...expected]
			);
			assert.equal(
				[...rule.options].some((option) => option.disabled),
				false
			);
			root.remove();
		});
	}
	await test('switches preserve an available chosen rule and replace it only when unavailable', () => {
		let value: AIConsensusSettings = {
			mode: 'advanced',
			assignments,
			sources: state.sources,
			threshold: 100,
			confidenceEnabled: true,
			summaryEnabled: true,
			summaryKey: '',
			rule: 'summary-then-confidence'
		};
		let refresh = () => {};
		const root = createAIConsensusSettings({
			read: () => value,
			write: (patch) => {
				value = { ...value, ...patch };
				refresh();
			},
			observe: (listener) => {
				refresh = listener;
				return () => {};
			}
		});
		document.body.append(root);
		const toggle = (label: string, checked: boolean) => {
			const input = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
			input.checked = checked;
			input.onchange!({} as Event);
			const rule = root.querySelector<HTMLSelectElement>('[aria-label="决策规则"]')!;
			assert.equal(rule.value, value.rule);
			assert.ok([...rule.options].some((option) => option.value === value.rule));
		};
		toggle('启用总结模型', false);
		assert.equal(value.rule, 'confidence');
		toggle('启用总结模型', true);
		assert.equal(value.rule, 'confidence');
		toggle('启用置信度选择', false);
		assert.equal(value.rule, 'summary');
		toggle('启用总结模型', false);
		assert.equal(value.rule, 'manual');
		toggle('启用置信度选择', true);
		assert.equal(value.rule, 'manual');
		root.remove();
	});
	await test('main-page entry opens a draft modal; cancel discards, save validates and reopening keeps settings', () => {
		let value: AIConsensusSettings = {
			mode: 'basic',
			assignments,
			sources: state.sources,
			threshold: 100,
			confidenceEnabled: true,
			rule: 'confidence',
			summaryEnabled: false,
			summaryKey: ''
		};
		let update = () => {};
		let popup: HTMLDivElement;
		const original = $modal.simple;
		($modal as any).simple = (options: any) => {
			popup = document.createElement('div');
			popup.append(options.content, options.footer);
			document.body.append(popup);
			return popup;
		};
		const button = createAIConsensusSettingsButton({
			read: () => value,
			write: (patch) => {
				value = { ...value, ...patch };
				update();
			},
			observe: (listener) => {
				update = listener;
				return () => {};
			}
		});
		document.body.append(button);
		const click = (text: string) =>
			[...popup.querySelectorAll('button')].find((entry) => entry.textContent === text)!.click();
		const change = (selector: string, text: string) => {
			const field = popup.querySelector<HTMLInputElement>(selector)!;
			field.value = text;
			field.onchange!({} as Event);
		};
		try {
			assert.equal(button.disabled, true);
			assert.equal(button.querySelector('.ai-consensus-settings'), null);
			value.mode = 'advanced';
			update();
			assert.equal(button.disabled, false);
			button.click();
			change('[aria-label="置信度阈值（一致率）"]', '75');
			assert.equal(value.threshold, 100);
			click('取消');
			assert.equal(value.threshold, 100);
			button.click();
			change('[aria-label="置信度阈值（一致率）"]', '75');
			click('保存高级设置');
			assert.equal(value.threshold, 75);
			assert.equal(popup!.isConnected, false);
			button.click();
			assert.equal(popup!.querySelector<HTMLInputElement>('[aria-label="置信度阈值（一致率）"]')!.value, '75');
			change('input[type="number"]', '0');
			click('保存高级设置');
			assert.equal(popup!.isConnected, true);
			assert.match(popup!.querySelector('[role="alert"]')!.textContent!, /1–8/);
			assert.equal(value.assignments[0].threads, 3);
			click('取消');
		} finally {
			$modal.simple = original;
			popup!?.remove();
			button.remove();
		}
	});
	console.log(`AI ensemble: ${checks} scenarios passed.`);
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
