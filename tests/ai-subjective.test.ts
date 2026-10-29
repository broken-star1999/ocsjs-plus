import assert from 'node:assert/strict';
import { $modal } from 'easy-us';
import { buildAIRequest } from '../packages/core/src/core/answer-wrapper/ai';
import { searchAIEnsemble } from '../packages/core/src/core/answer-wrapper/ai-ensemble';
import {
	aiModelKey,
	createAIAnswererWrappers,
	AIProviderState
} from '../packages/core/src/core/answer-wrapper/ai-providers';
import { createDefaultQuestionResolver } from '../packages/core/src/core/worker/question.resolver';
import { OCSWorker } from '../packages/core/src/core/worker/worker';
import { enableSingleQuestionRetry } from '../packages/core/src/core/worker/single-question-retry';
import { createCommonAnswerer } from '../packages/scripts/src/utils/work';
import { createCXQuestionRetryAdapter } from '../packages/scripts/src/utils/cx-question-retry';
import { createAIEnsembleDetails } from '../packages/scripts/src/elements/ai-ensemble-details';
import {
	createAIConsensusSettings,
	createAIConsensusSettingsButton,
	AIConsensusSettings
} from '../packages/scripts/src/utils/ai-consensus-settings';

const runtime = globalThis as any;
runtime.GM_getValue = () => 'offline-fixture-key';
if (!Element.prototype.replaceChildren)
	Element.prototype.replaceChildren = function (...nodes: (Node | string)[]) {
		while (this.firstChild) this.removeChild(this.firstChild);
		for (const node of nodes) this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
	};
const state: AIProviderState = {
	selection: aiModelKey('test', 'a'),
	sources: [
		{
			id: 'test',
			name: 'Offline',
			preset: 'openai',
			endpoint: 'https://offline.example/v1',
			timeoutSeconds: 10,
			catalog: [],
			models: ['a', 'b', 'summary'].map((id) => ({ id, name: id, enabled: true, vision: true, extraBody: {} }))
		}
	]
};
const assignments = [
	{ key: aiModelKey('test', 'a'), threads: 2 },
	{ key: aiModelKey('test', 'b'), threads: 1 }
];
const config = (options: Parameters<typeof createAIAnswererWrappers>[3] = {}) =>
	createAIAnswererWrappers(state, true, assignments, {
		rule: 'confidence',
		confidenceEnabled: true,
		threshold: 100,
		subjectiveRule: 'selected',
		subjectiveSelection: assignments[0].key,
		...options
	})[0].aiEnsemble!;
const subjective = { title: '请填写一个完整答案。', type: 'completion', blank_count: 1 };
let requests: any[] = [];
function install(reply: (payload: any, index: number) => string[] | 'error', hold = false) {
	requests = [];
	runtime.GM_xmlhttpRequest = (request: any) => {
		const index = requests.length;
		requests.push(request);
		request.respond = () => {
			const answers = reply(JSON.parse(request.data), index);
			request.onload(
				answers === 'error'
					? { status: 401, responseText: '' }
					: {
							status: 200,
							responseText: JSON.stringify({
								choices: [
									{
										finish_reason: 'stop',
										message: {
											content: JSON.stringify({ answers, uncertain: false }),
											reasoning_content: '离线测试解析'
										}
									}
								]
							})
					  }
			);
		};
		if (!hold) request.respond();
	};
}
const body = (index: number) => JSON.parse(JSON.parse(requests[index].data).messages[1].content);
let checks = 0;
async function test(name: string, action: () => void | Promise<void>) {
	await action();
	checks++;
	console.log('PASS ' + name);
}
async function fillFixture(count: number, answers: string[]) {
	install(() => answers);
	const root = document.createElement('section');
	root.innerHTML =
		'<h3>要使 for i in range(___, -4, -2) 循环执行15次，i的初值应为____。</h3>' +
		'<textarea>old</textarea>'.repeat(count);
	const fields = [...root.querySelectorAll('textarea')];
	const ctx: any = { root, type: 'completion', elements: { title: [root.querySelector('h3')], options: fields } };
	const answerer = createCommonAnswerer({
		period: 0,
		titleTransform: () => root.querySelector('h3')!.textContent!,
		optionsTransform: () => '',
		answererWrappers: createAIAnswererWrappers(state)
	});
	const infos = await answerer(ctx.elements, ctx);
	const result = await createDefaultQuestionResolver(ctx).completion(infos, fields, (_type, answer, field) => {
		(field as HTMLTextAreaElement).value = answer;
	});
	return { infos, result, fields };
}

async function main() {
	await test('photo regression: two underscores and one real field send one blank and fill one answer', async () => {
		const fixture = await fillFixture(1, ['26']);
		assert.equal(body(0).blank_count, 1);
		assert.match(JSON.parse(requests[0].data).messages[0].content, /恰好包含 1 个字符串/);
		assert.equal(fixture.result.finish, true);
		assert.equal(fixture.fields[0].value, '26');
	});
	await test('a model violating one-field cardinality is diagnosed before filling, with the old value preserved', async () => {
		const fixture = await fillFixture(1, ['26', '26']);
		assert.equal(fixture.result.finish, false);
		assert.match(fixture.infos[0].error!, /返回 2 个答案.*1 个填写位置/);
		assert.equal(fixture.infos[0].ai?.call.status, 'error');
		assert.equal(fixture.fields[0].value, 'old');
	});
	await test('two real fields may legitimately have identical answers; they must not be deduplicated', async () => {
		const fixture = await fillFixture(2, ['26', '26']);
		assert.equal(body(0).blank_count, 2);
		assert.equal(fixture.result.finish, true);
		assert.deepEqual(
			fixture.fields.map((field) => field.value),
			['26', '26']
		);
	});
	await test('zero editable fields are rejected without making a paid request', async () => {
		const fixture = await fillFixture(0, ['26']);
		assert.equal(requests.length, 0);
		assert.match(fixture.infos[0].error!, /填写位置数量/);
	});
	await test('online selections without DOM metadata do not invent a blank count from punctuation', () => {
		const request = buildAIRequest(config().models[0], { title: '填空题：___，___', type: 'completion' });
		assert.equal(JSON.parse(String(request.messages[1].content)).blank_count, undefined);
	});
	await test('selected model uses its first configured response, independently of arrival order', async () => {
		install((_payload, index) => [['first'], ['second'], ['third']][index], true);
		const pending = searchAIEnsemble(config(), subjective, 1000);
		assert.equal(requests.length, 3);
		requests
			.slice()
			.reverse()
			.forEach((request) => request.respond());
		const result = await pending;
		assert.equal(result.results[0].answer, 'first');
		assert.equal(result.ensemble?.status, 'selected');
		assert.equal(result.ensemble?.selected?.index, 0);
		assert.equal(result.ensemble?.vote, undefined);
		const panel = createAIEnsembleDetails(result.ensemble!);
		assert.match(panel.textContent!, /已采用指定的主观题回答/);
		assert.doesNotMatch(panel.textContent!, /最多相同回答|% 一致率/);
	});
	await test('attempt labels remain local to each provider even when endpoint and model ID match', async () => {
		const shared: AIProviderState = {
			...state,
			sources: [...state.sources, { ...state.sources[0], id: 'second-source', name: 'Second provider' }]
		};
		const target = aiModelKey('second-source', 'a');
		const ensemble = createAIAnswererWrappers(
			shared,
			true,
			[
				{ key: assignments[0].key, threads: 2 },
				{ key: target, threads: 2 }
			],
			{ rule: 'confidence', subjectiveRule: 'selected', subjectiveSelection: target }
		)[0].aiEnsemble!;
		install((_payload, index) => ['answer-' + index]);
		const result = await searchAIEnsemble(ensemble, subjective, 1000);
		assert.equal(result.results[0].answer, 'answer-2');
		assert.match(result.ensemble!.members[2].name, /Second provider.*第 1 次/);
		assert.match(result.ensemble!.members[3].name, /Second provider.*第 2 次/);
	});
	await test('a legacy saved response ordinal no longer changes the selected model answer', async () => {
		install((_payload, index) => [index === 0 ? 'first' : 'other']);
		const result = await searchAIEnsemble(config({ subjectiveAttempt: 2 } as any), subjective, 1000);
		assert.equal(result.results[0].answer, 'first');
		assert.equal(result.ensemble?.selected?.index, 0);
	});
	await test('a failed selected answer never falls back to another successful answer or to majority voting', async () => {
		install((_payload, index) => (index === 0 ? 'error' : ['same']));
		const result = await searchAIEnsemble(config(), subjective, 1000);
		assert.equal(result.ensemble?.status, 'review');
		assert.equal(result.results.length, 0);
		assert.match(result.error!, /不自动改用/);
	});
	await test('subjective manual mode displays every candidate without filling or calling the enabled summary model', async () => {
		install(() => ['26']);
		const result = await searchAIEnsemble(
			config({
				rule: 'summary',
				summaryEnabled: true,
				summarySelection: aiModelKey('test', 'summary'),
				subjectiveRule: 'manual'
			}),
			subjective,
			1000
		);
		assert.equal(requests.length, 3);
		assert.equal(result.ensemble?.members.length, 3);
		assert.equal(result.ensemble?.status, 'review');
		assert.equal(result.ensemble?.summary, undefined);
		assert.equal(result.ensemble?.vote, undefined);
		assert.match(result.error!, /主观题已设为全部人工判断/);
		let writes = 0;
		const resolved = await createDefaultQuestionResolver({} as any).completion(
			[result],
			[document.createElement('textarea')],
			() => {
				writes++;
			}
		);
		assert.equal(resolved.finish, false);
		assert.equal(writes, 0);
	});
	await test('manual subjective work waits for human confirmation and never overwrites the human answer', async () => {
		install(() => ['26']);
		const root = document.createElement('section');
		root.innerHTML = '<h3>填写题</h3><textarea>old</textarea>';
		document.body.append(root);
		let current: any,
			writes = 0,
			settled = false;
		const worker = new OCSWorker({
			root: [root],
			elements: { title: 'h3', options: 'textarea' },
			answerer: async () => [await searchAIEnsemble(config({ subjectiveRule: 'manual' }), subjective, 1000)],
			work: {
				type: 'completion',
				handler: () => {
					writes++;
				}
			},
			onResultsUpdate: (result) => {
				current = result;
			}
		});
		const task = worker.doWork().then(() => {
			settled = true;
		});
		try {
			const deadline = Date.now() + 4000;
			while (!current?.confirmReview || !current.resolved) {
				if (Date.now() > deadline) throw new Error('manual confirmation control was not registered');
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			assert.equal(settled, false);
			assert.equal(writes, 0);
			assert.equal(root.querySelector('textarea')!.value, 'old');
			root.querySelector('textarea')!.value = 'human answer';
			await current.confirmReview();
			await task;
			assert.equal(current.result.manual, true);
			assert.equal(root.querySelector('textarea')!.value, 'human answer');
			assert.equal(writes, 0);
		} finally {
			worker.emit('close');
			await task;
			root.remove();
		}
	});
	for (const bad of [
		{ subjectiveSelection: '' },
		{ subjectiveSelection: aiModelKey('removed', 'a') },
		{ subjectiveSelection: aiModelKey('test', 'summary') }
	])
		await test(
			'missing, removed or out-of-range subjective selection affects only subjective questions: ' + JSON.stringify(bad),
			async () => {
				install(() => ['A']);
				const selected = config(bad);
				assert.equal(selected.error, undefined);
				const result = await searchAIEnsemble(selected, subjective, 1000);
				assert.equal(result.ensemble?.status, 'review');
				assert.equal(requests.length, 0);
				const objective = await searchAIEnsemble(
					selected,
					{ title: '题干', type: 'single', options: 'A.甲\nB.乙' },
					1000
				);
				assert.equal(objective.results[0].answer, 'A');
			}
		);
	for (const rule of ['manual', 'confidence', 'unanimous'] as const)
		await test('subjective summary runs independently of objective rule: ' + rule, async () => {
			install((_payload, index) => (index === 3 ? ['summary-answer'] : ['candidate-' + index]));
			const result = await searchAIEnsemble(
				config({
					rule,
					summaryEnabled: true,
					summarySelection: aiModelKey('test', 'summary'),
					subjectiveRule: 'summary'
				}),
				subjective,
				1000
			);
			assert.equal(requests.length, 4);
			assert.equal(body(3).blank_count, 1);
			assert.equal(body(3).model_reports.length, 3);
			assert.equal(body(3).model_reports[1].reasoning, '离线测试解析');
			assert.equal(result.results[0].answer, 'summary-answer');
			assert.equal(result.ensemble?.status, 'summarized');
			assert.equal(result.ensemble?.vote, undefined);
		});
	await test('subjective summary failure stays manual even if every candidate agrees and objective confidence is enabled', async () => {
		install((_payload, index) => (index === 3 ? 'error' : ['same']));
		const result = await searchAIEnsemble(
			config({ summaryEnabled: true, summarySelection: aiModelKey('test', 'summary'), subjectiveRule: 'summary' }),
			subjective,
			1000
		);
		assert.equal(result.ensemble?.status, 'review');
		assert.match(result.error!, /主观题总结失败/);
	});
	await test('summary response cardinality is validated against the actual page fields', async () => {
		install((_payload, index) => (index === 3 ? ['26', '26'] : ['26']));
		const result = await searchAIEnsemble(
			config({ summaryEnabled: true, summarySelection: aiModelKey('test', 'summary'), subjectiveRule: 'summary' }),
			subjective,
			1000
		);
		assert.equal(result.results.length, 0);
		assert.match(result.ensemble?.summary?.error!, /2 个答案.*1 个填写位置/);
	});
	for (const [type, answers] of [
		['single', ['A']],
		['multiple', ['AB']],
		['judgement', ['正确']]
	] as const)
		await test(
			'subjective summary setting does not add a summary call to objective confidence questions: ' + type,
			async () => {
				install(() => [...answers]);
				const result = await searchAIEnsemble(
					config({ subjectiveRule: 'summary', summaryEnabled: true, summarySelection: aiModelKey('test', 'summary') }),
					{ title: '题干', type, options: 'A.对\nB.错' },
					1000
				);
				assert.equal(requests.length, 3);
				assert.equal(result.ensemble?.status, 'agreed');
			}
		);
	await test('objective disagreement cannot be bypassed by the subjective selected-answer rule', async () => {
		install((_payload, index) => [index === 2 ? 'B' : 'A']);
		const result = await searchAIEnsemble(config(), { title: '题干', type: 'single', options: 'A.甲\nB.乙' }, 1000);
		assert.equal(result.ensemble?.status, 'review');
		assert.equal(result.results.length, 0);
	});
	await test('unknown page type stays manual and corrupt subjective confidence settings are rejected', async () => {
		install(() => ['same']);
		assert.equal(
			(await searchAIEnsemble(config(), { title: '题干', type: 'unknown' }, 1000)).ensemble?.status,
			'review'
		);
		install(() => ['same']);
		const invalid = await searchAIEnsemble({ ...config(), subjectiveRule: 'confidence' as any }, subjective, 1000);
		assert.match(invalid.error!, /主观题处理方式无效/);
		assert.equal(requests.length, 0);
	});
	await test('subjective-only summary is included in the worker deadline budget', async () => {
		install(() => ['26']);
		const ensemble = config({
			subjectiveRule: 'summary',
			summaryEnabled: true,
			summarySelection: aiModelKey('test', 'summary')
		});
		ensemble.summary!.timeoutSeconds = 120;
		const ctx: any = { type: 'completion', elements: { options: [document.createElement('textarea')] } };
		const started = Date.now();
		await createCommonAnswerer({
			period: 0,
			titleTransform: () => '题干',
			optionsTransform: () => '',
			answererWrappers: [{ name: 'test', url: '', aiEnsemble: ensemble } as any]
		})(ctx.elements, ctx);
		assert.ok(ctx.searchDeadline >= started + 190_000);
	});
	await test('single-question retry carries actual field count again and preserves the prior value on invalid responses', async () => {
		install(() => ['26']);
		const root = document.createElement('section');
		root.innerHTML = '<h3>range(___,-4,-2)，初值____</h3><div class="editor"><textarea>old</textarea></div>';
		document.body.append(root);
		let current: any;
		const worker = new OCSWorker({
			root: [root],
			elements: { title: 'h3', options: '.editor' },
			answerer: createCommonAnswerer({
				period: 0,
				titleTransform: () => root.querySelector('h3')!.textContent!,
				optionsTransform: () => '',
				answererWrappers: createAIAnswererWrappers(state)
			}),
			work: {
				type: 'completion',
				handler: (_type, answer, field) => {
					field.querySelector('textarea')!.value = answer;
				}
			},
			onResultsUpdate: (result) => {
				current = result;
			}
		});
		enableSingleQuestionRetry(
			worker,
			createCXQuestionRetryAdapter({ layout: 'exam', type: () => 'completion', optionText: () => '' })
		);
		try {
			await worker.doWork();
			assert.equal(body(0).blank_count, 1);
			assert.equal(root.querySelector('textarea')!.value, '26');
			install(() => ['26', '26']);
			await assert.rejects(current.retry(), /2 个答案.*1 个填写位置/);
			assert.equal(body(0).blank_count, 1);
			assert.equal(root.querySelector('textarea')!.value, '26');
		} finally {
			worker.emit('close');
			root.remove();
		}
	});
	for (const confidenceEnabled of [false, true])
		for (const summaryEnabled of [false, true])
			await test(`UI separates objective capabilities and subjective choices: ${confidenceEnabled}/${summaryEnabled}`, () => {
				const value: AIConsensusSettings = {
					mode: 'advanced',
					assignments,
					sources: state.sources,
					threshold: 75,
					confidenceEnabled,
					summaryEnabled,
					summaryKey: '',
					rule: 'manual',
					subjectiveRule: 'selected'
				};
				const root = createAIConsensusSettings({ read: () => value, write: () => {}, observe: () => () => {} });
				const choices = [...root.querySelector<HTMLSelectElement>('[aria-label="主观题处理方式"]')!.options].map(
					(option) => option.value
				);
				assert.deepEqual(choices, summaryEnabled ? ['manual', 'selected', 'summary'] : ['manual', 'selected']);
				assert.ok(root.querySelector('[aria-label="客观题决策方式"]'));
				const models = [...root.querySelector<HTMLSelectElement>('[aria-label="主观题指定模型"]')!.options];
				assert.deepEqual(
					models.map((option) => option.value),
					['', assignments[0].key, assignments[1].key]
				);
			});
	await test('modal cancel discards both strategies; save persists them independently; disabling summary removes only dependent choices', () => {
		let value: AIConsensusSettings = {
			mode: 'advanced',
			assignments,
			sources: state.sources,
			threshold: 75,
			confidenceEnabled: true,
			summaryEnabled: true,
			summaryKey: aiModelKey('test', 'summary'),
			rule: 'confidence',
			subjectiveRule: 'selected',
			subjectiveKey: assignments[0].key
		};
		const original = $modal.simple;
		let popup: HTMLDivElement;
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
			},
			observe: () => () => {}
		});
		const change = (name: string, next: string) => {
			const select = popup.querySelector<HTMLSelectElement>(`[aria-label="${name}"]`)!;
			select.value = next;
			select.onchange!({} as Event);
		};
		const click = (text: string) =>
			[...popup.querySelectorAll('button')].find((item) => item.textContent === text)!.click();
		try {
			button.click();
			change('主观题处理方式', 'summary');
			click('取消');
			assert.equal(value.subjectiveRule, 'selected');
			button.click();
			change('主观题处理方式', 'summary');
			click('保存高级设置');
			assert.equal(value.subjectiveRule, 'summary');
			assert.equal(value.rule, 'confidence');
			button.click();
			const toggle = popup!.querySelector<HTMLInputElement>('[aria-label="启用总结模型"]')!;
			toggle.checked = false;
			toggle.onchange!({} as Event);
			assert.equal(popup!.querySelector<HTMLSelectElement>('[aria-label="主观题处理方式"]')!.value, 'manual');
			assert.equal(popup!.querySelector<HTMLSelectElement>('[aria-label="客观题决策方式"]')!.value, 'confidence');
			click('保存高级设置');
			assert.equal(value.subjectiveRule, 'manual');
			button.click();
			assert.equal(popup!.querySelector<HTMLSelectElement>('[aria-label="主观题处理方式"]')!.value, 'manual');
			assert.equal(popup!.querySelector('[aria-label="主观题指定模型"]'), null);
			change('主观题处理方式', 'selected');
			change('主观题指定模型', assignments[1].key);
			assert.equal(popup!.querySelector('[aria-label="主观题指定回答次数"]'), null);
			click('保存高级设置');
			assert.equal(value.subjectiveKey, assignments[1].key);
			assert.equal(value.summaryEnabled, false);
		} finally {
			$modal.simple = original;
			popup!?.remove();
			button.remove();
		}
	});
	console.log(`AI subjective decisions and page blanks: ${checks} scenarios passed.`);
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
