import assert from 'node:assert/strict';
import {
	canonicalEnsembleAnswers,
	searchAIEnsemble,
	AIEnsembleRule
} from '../packages/core/src/core/answer-wrapper/ai-ensemble';
import {
	createAIAnswererWrappers,
	aiModelKey,
	AIProviderState
} from '../packages/core/src/core/answer-wrapper/ai-providers';

const runtime = globalThis as any;
runtime.GM_getValue = () => '';
const state: AIProviderState = {
	selection: aiModelKey('boundary', 'a'),
	sources: [
		{
			id: 'boundary',
			name: 'Offline',
			preset: 'openai',
			endpoint: 'https://offline.example/v1',
			timeoutSeconds: 10,
			catalog: [],
			models: ['a', 'b', 'summary'].map((id) => ({ id, name: id, enabled: true, vision: true, extraBody: {} }))
		}
	]
};
const assignments = ['a', 'b'].map((id) => ({ key: aiModelKey('boundary', id), threads: 1 }));
const objective = { title: '请选择正确答案。', type: 'single', options: '甲\n乙', option_count: 2 };
const subjective = { title: '请填写答案。', type: 'completion', blank_count: 1 };
let requests: any[] = [];
function install(reply: (model: string, index: number) => string[] | 'error') {
	requests = [];
	runtime.GM_xmlhttpRequest = (request: any) => {
		const index = requests.length;
		requests.push(request);
		const result = reply(JSON.parse(request.data).model, index);
		request.onload(
			result === 'error'
				? { status: 401, responseText: '' }
				: {
						status: 200,
						responseText: JSON.stringify({
							choices: [
								{
									finish_reason: 'stop',
									message: {
										content: JSON.stringify({ answers: result, uncertain: false })
									}
								}
							]
						})
				  }
		);
	};
}
function config(options: Parameters<typeof createAIAnswererWrappers>[3] = {}, providerState = state) {
	return createAIAnswererWrappers(providerState, true, assignments, {
		rule: 'confidence',
		confidenceEnabled: true,
		threshold: 100,
		subjectiveRule: 'selected',
		subjectiveSelection: assignments[0].key,
		...options
	})[0].aiEnsemble!;
}
let checks = 0;
async function test(name: string, action: () => void | Promise<void>) {
	await action();
	checks++;
	console.log('PASS ' + name);
}

async function main() {
	for (const missing of ['deleted', 'disabled'] as const)
		await test('a ' + missing + ' subjective summary model does not block objective confidence', async () => {
			install(() => ['A']);
			const changed = JSON.parse(JSON.stringify(state)) as AIProviderState;
			if (missing === 'deleted') changed.sources[0].models.pop();
			else changed.sources[0].models[2].enabled = false;
			const configured = config(
				{ subjectiveRule: 'summary', summaryEnabled: true, summarySelection: aiModelKey('boundary', 'summary') },
				changed
			);
			assert.equal(configured.error, undefined);
			assert.equal(configured.models.length, 2);
			assert.match(configured.summaryError!, /总结模型/);
			const result = await searchAIEnsemble(configured, objective, 1000);
			assert.equal(result.results[0]?.answer, 'A');
			assert.equal(result.ensemble?.status, 'agreed');
			assert.equal(requests.length, 2);
			assert.equal(result.ensemble?.summary, undefined);
		});
	for (const rule of ['manual', 'selected'] as const)
		await test('missing objective-only summary does not block subjective ' + rule, async () => {
			install(() => ['26']);
			const result = await searchAIEnsemble(
				config({
					rule: 'summary',
					subjectiveRule: rule,
					summaryEnabled: true,
					summarySelection: aiModelKey('boundary', 'removed')
				}),
				subjective,
				1000
			);
			assert.equal(requests.length, 2);
			assert.equal(result.ensemble?.members.length, 2);
			assert.equal(result.ensemble?.status, rule === 'selected' ? 'selected' : 'review');
			assert.equal(result.results[0]?.answer, rule === 'selected' ? '26' : undefined);
			assert.equal(result.ensemble?.summary, undefined);
		});
	await test('disabled objective confidence affects the objective route only', async () => {
		install(() => ['26']);
		const configured = config({ confidenceEnabled: false });
		assert.equal(configured.error, undefined);
		assert.match(configured.objectiveError!, /启用置信度/);
		assert.equal((await searchAIEnsemble(configured, subjective, 1000)).results[0]?.answer, '26');
		assert.equal(requests.length, 2);
		install(() => ['A']);
		const result = await searchAIEnsemble(configured, objective, 1000);
		assert.equal(result.ensemble?.status, 'review');
		assert.match(result.error!, /启用置信度/);
		assert.equal(requests.length, 0);
	});
	for (const type of ['objective', 'subjective'] as const)
		await test(type + ' summary-only route with no summary makes no paid requests', async () => {
			install(() => ['A']);
			const configured = config({
				rule: type === 'objective' ? 'summary' : 'confidence',
				subjectiveRule: type === 'subjective' ? 'summary' : 'manual',
				summaryEnabled: true,
				summarySelection: aiModelKey('boundary', 'removed')
			});
			const result = await searchAIEnsemble(configured, type === 'objective' ? objective : subjective, 1000);
			assert.equal(result.ensemble?.status, 'review');
			assert.match(result.error!, /总结模型/);
			assert.equal(requests.length, 0);
		});
	for (const rule of ['confidence-then-summary', 'summary-then-confidence'] as AIEnsembleRule[])
		for (const agreement of [true, false])
			await test(
				rule + ' with missing summary ' + (agreement ? 'keeps valid confidence' : 'reviews disagreement'),
				async () => {
					install((_model, index) => [agreement || index === 0 ? 'A' : 'B']);
					const result = await searchAIEnsemble(
						config({ rule, summaryEnabled: true, summarySelection: aiModelKey('boundary', 'removed') }),
						objective,
						1000
					);
					assert.equal(requests.length, 2);
					assert.equal(result.ensemble?.status, agreement ? 'agreed' : 'review');
					assert.equal(result.results[0]?.answer, agreement ? 'A' : undefined);
					if (rule === 'summary-then-confidence' || !agreement)
						assert.match(result.ensemble?.summary?.error!, /总结模型/);
				}
			);
	for (const rule of ['confidence-then-summary', 'summary-then-confidence'] as AIEnsembleRule[])
		await test(rule + ' can still use confidence if a saved summary capability is disabled', async () => {
			install(() => ['B']);
			const result = await searchAIEnsemble(config({ rule, summaryEnabled: false }), objective, 1000);
			assert.equal(requests.length, 2);
			assert.equal(result.results[0]?.answer, 'B');
		});
	await test('participant failures remain global and cannot be bypassed by either question type', async () => {
		install(() => ['A']);
		const bad = createAIAnswererWrappers(state, true, [{ key: assignments[0].key, threads: 0 }], {
			rule: 'confidence',
			subjectiveRule: 'manual'
		})[0].aiEnsemble!;
		assert.ok(bad.error);
		for (const question of [objective, subjective]) {
			const result = await searchAIEnsemble(bad, question, 1000);
			assert.equal(result.ensemble?.status, 'review');
			assert.equal(result.ensemble?.members.length, 0);
		}
		assert.equal(requests.length, 0);
	});
	await test('unknown question stays manual even with unavailable objective-only dependencies', async () => {
		install(() => ['A']);
		const result = await searchAIEnsemble(
			config({ confidenceEnabled: false }),
			{ title: '题干', type: 'unknown' },
			1000
		);
		assert.equal(result.ensemble?.status, 'review');
		assert.equal(result.ensemble?.members.length, 2);
		assert.equal(result.results.length, 0);
	});
	for (const [type, answers, optionCount, expected] of [
		['single', ['B'], 2, ['B']],
		['single', ['C'], 2, undefined],
		['single', ['A'], 0, undefined],
		['multiple', ['BA'], 2, ['AB']],
		['multiple', ['AC'], 2, undefined],
		['multiple', ['A'], 0, undefined]
	] as const)
		await test('authoritative option range: ' + type + ' ' + answers + ' / ' + optionCount, () => {
			assert.deepEqual(
				canonicalEnsembleAnswers([...answers], { ...objective, type, option_count: optionCount }),
				expected
			);
		});
	await test('online selections without option metadata never guess a range from string lines', () => {
		assert.deepEqual(
			canonicalEnsembleAnswers(['D'], { title: '单选题 A.甲 B.乙 C.丙 D.丁', type: 'single', options: '' }),
			['D']
		);
		assert.deepEqual(
			canonicalEnsembleAnswers(['AC'], { title: '多选题', type: 'multiple', options: '多行\n并不等于选项数' }),
			['AC']
		);
	});
	for (const type of ['single', 'multiple'] as const)
		await test('out-of-range ' + type + ' summary falls back to valid confidence', async () => {
			install((model) => [model === 'summary' ? (type === 'single' ? 'Z' : 'AC') : type === 'single' ? 'A' : 'AB']);
			const result = await searchAIEnsemble(
				config({
					rule: 'summary-then-confidence',
					summaryEnabled: true,
					summarySelection: aiModelKey('boundary', 'summary')
				}),
				{ ...objective, type },
				1000
			);
			assert.equal(requests.length, 3);
			assert.equal(result.ensemble?.status, 'agreed');
			assert.equal(result.results[0]?.answer, type === 'single' ? 'A' : 'AB');
			assert.ok(result.ensemble?.summary?.error);
			assert.deepEqual(result.ensemble?.vote, { count: 2, total: 2, threshold: 100 });
		});
	await test('out-of-range participants do not vote and remain in the confidence denominator', async () => {
		install((_model, index) => [index === 3 ? 'Z' : 'A']);
		const configured = config({ threshold: 75 });
		configured.models = Array.from({ length: 4 }, () => configured.models[0]);
		const result = await searchAIEnsemble(configured, objective, 1000);
		assert.equal(result.results[0]?.answer, 'A');
		assert.deepEqual(result.ensemble?.vote, { count: 3, total: 4, threshold: 75 });
		assert.ok(result.ensemble?.members[3].error);
	});
	await test('a unanimous out-of-range answer cannot become an agreed result', async () => {
		install(() => ['Z']);
		const result = await searchAIEnsemble(config(), objective, 1000);
		assert.equal(result.ensemble?.status, 'review');
		assert.equal(result.results.length, 0);
		assert.deepEqual(result.ensemble?.vote, { count: 0, total: 2, threshold: 100 });
	});
	await test('valid summary still wins in summary-first mode', async () => {
		install((model) => [model === 'summary' ? 'B' : 'A']);
		const result = await searchAIEnsemble(
			config({
				rule: 'summary-then-confidence',
				summaryEnabled: true,
				summarySelection: aiModelKey('boundary', 'summary')
			}),
			objective,
			1000
		);
		assert.equal(result.ensemble?.status, 'summarized');
		assert.equal(result.results[0]?.answer, 'B');
	});
	console.log(`AI ensemble boundaries: ${checks} scenarios passed.`);
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
