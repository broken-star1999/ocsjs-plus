import assert from 'node:assert/strict';
import { $modal } from 'easy-us';
import { aiModelKey } from '../packages/core/src/core/answer-wrapper/ai-providers';
import {
	AIConsensusSettings,
	createAIConsensusSettings,
	createAIConsensusSettingsButton
} from '../packages/scripts/src/utils/ai-consensus-settings';
import { describeAIConsensusPlan } from '../packages/scripts/src/utils/ai-consensus-plan';
import { openAIProviderManager } from '../packages/scripts/src/utils/ai-provider-manager';

if (!Element.prototype.replaceChildren)
	Element.prototype.replaceChildren = function (...nodes: (Node | string)[]) {
		while (this.firstChild) this.removeChild(this.firstChild);
		for (const node of nodes) this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
	};
const first = aiModelKey('offline', 'first');
const second = aiModelKey('offline', 'second');
const summary = aiModelKey('offline', 'summary');
const initial = (): AIConsensusSettings => ({
	mode: 'advanced',
	assignments: [
		{ key: first, threads: 2 },
		{ key: second, threads: 1 }
	],
	threshold: 75,
	confidenceEnabled: true,
	rule: 'confidence-then-summary',
	subjectiveRule: 'manual',
	summaryEnabled: true,
	summaryKey: summary,
	questionThreads: 2,
	sources: [
		{
			id: 'offline',
			name: '离线提供商',
			preset: 'openai',
			endpoint: 'https://offline.invalid/v1',
			timeoutSeconds: 10,
			catalog: [],
			models: ['first', 'second', 'summary'].map((id) => ({
				id,
				name: id,
				enabled: true,
				vision: false,
				extraBody: {}
			}))
		}
	]
});
let checks = 0;
async function test(name: string, run: () => void | Promise<void>) {
	await run();
	checks++;
	console.log('PASS ' + name);
}
const originalModal = $modal.simple;
let popup: HTMLDivElement | undefined;
($modal as any).simple = (options: any) => {
	popup = document.createElement('div');
	popup.append(options.content, options.footer);
	document.body.append(popup);
	return popup;
};
function click(text: string) {
	const button = [...popup!.querySelectorAll('button')].find((item) => item.textContent === text);
	assert.ok(button, 'button exists: ' + text);
	button.click();
}
function change(label: string, value: string | boolean) {
	const field = popup!.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
	assert.ok(field, 'field exists: ' + label);
	if (typeof value === 'boolean') (field as HTMLInputElement).checked = value;
	else field.value = value;
	field.onchange!({} as Event);
}
function modalFixture(state: AIConsensusSettings = initial()) {
	let value = state;
	const button = createAIConsensusSettingsButton({
		read: () => value,
		write: (patch) => {
			value = { ...value, ...patch };
		},
		observe: () => () => {}
	});
	document.body.append(button);
	button.click();
	return {
		read: () => value,
		button,
		cleanup: () => {
			popup?.remove();
			button.remove();
		}
	};
}

async function main() {
	await test('request preview includes base, possible summary and concurrent question scale', () => {
		const plan = describeAIConsensusPlan(initial());
		assert.equal(plan.basicRequests, 3);
		assert.equal(plan.summaryRequests, 1);
		assert.match(plan.requests, /基础 3 次请求.*额外 1 次.*最多 4 次/);
		assert.match(plan.concurrency, /同时处理 2 道题.*最多并发 6 次/);
		assert.match(plan.objective, /75% 一致率.*未达标或并列.*summary/);
		assert.match(plan.subjective, /原题填写后确认/);
	});
	await test('an enabled but unused summary model does not inflate the request count', () => {
		const plan = describeAIConsensusPlan({ ...initial(), rule: 'confidence' });
		assert.equal(plan.summaryRequests, 0);
		assert.match(plan.requests, /不额外调用总结模型/);
	});
	await test('subjective-only summary is counted independently of the objective rule', () => {
		const plan = describeAIConsensusPlan({ ...initial(), rule: 'manual', subjectiveRule: 'summary' });
		assert.equal(plan.summaryRequests, 1);
		assert.match(plan.objective, /人工处理并确认/);
		assert.match(plan.subjective, /summary.*汇总所有回答/);
	});
	await test('invalid per-model counts show a repair instruction rather than a fictitious scale', () => {
		const plan = describeAIConsensusPlan({ ...initial(), assignments: [{ key: first, threads: 1.5 }] });
		assert.equal(plan.basicRequests, undefined);
		assert.match(plan.requests, /1–8 的整数/);
		assert.doesNotMatch(plan.requests + plan.concurrency, /NaN|并发 3 次/);
	});
	await test('the selected subjective route names only a valid participating model', () => {
		const valid = describeAIConsensusPlan({ ...initial(), subjectiveRule: 'selected', subjectiveKey: second });
		assert.match(valid.subjective, /second.*首次回答.*失败时交给人工/);
		const invalid = describeAIConsensusPlan({ ...initial(), subjectiveRule: 'selected', subjectiveKey: summary });
		assert.match(invalid.subjective, /尚未指定有效的参与模型/);
	});
	await test('all six objective strategies have a readable execution plan', () => {
		for (const rule of [
			'manual',
			'unanimous',
			'confidence',
			'summary',
			'confidence-then-summary',
			'summary-then-confidence'
		] as const) {
			const plan = describeAIConsensusPlan({ ...initial(), rule });
			assert.match(plan.objective, /^客观题：/);
			assert.match(plan.objective, /人工/);
			assert.doesNotMatch(plan.objective, /undefined|置信度/);
		}
	});
	await test('the settings use consistency-rate terminology while retaining the stored confidence keys', () => {
		const value = initial();
		const root = createAIConsensusSettings({ read: () => value, write: () => {}, observe: () => () => {} });
		assert.ok(root.querySelector('[aria-label="启用一致率选择"]'));
		assert.ok(root.querySelector('[aria-label="一致率阈值"]'));
		assert.doesNotMatch(root.textContent!, /置信度/);
		assert.match(root.textContent!, /不代表实际正确概率/);
		assert.equal(value.confidenceEnabled, true);
	});
	await test('turning summary off visibly reports both dependent rule changes without saving them', () => {
		const fixture = modalFixture({ ...initial(), rule: 'summary', subjectiveRule: 'summary' });
		try {
			change('启用总结模型', false);
			assert.match(popup!.textContent!, /客观题由“每题由总结模型决定”改为“仅按一致率阈值”/);
			assert.match(popup!.textContent!, /主观题已改为“全部人工判断”/);
			assert.equal(popup!.querySelector<HTMLSelectElement>('[aria-label="主观题处理方式"]')!.value, 'manual');
			assert.match(popup!.querySelector('.ai-consensus-execution-plan')!.textContent!, /不额外调用总结模型/);
			assert.equal(fixture.read().rule, 'summary');
			assert.equal(fixture.read().subjectiveRule, 'summary');
			click('取消');
			assert.equal(fixture.read().summaryEnabled, true);
		} finally {
			fixture.cleanup();
		}
	});
	await test('turning consistency off reports the automatic fallback and reenabling it preserves the current rule', () => {
		const fixture = modalFixture();
		try {
			change('启用一致率选择', false);
			assert.match(popup!.textContent!, /已关闭一致率选择.*先一致率，未达标再总结.*每题由总结模型决定/);
			change('启用一致率选择', true);
			assert.match(popup!.textContent!, /已开启一致率选择。当前主客观题处理方式保持不变/);
			assert.equal(popup!.querySelector<HTMLSelectElement>('[aria-label="客观题决策方式"]')!.value, 'summary');
		} finally {
			fixture.cleanup();
		}
	});
	await test('the footer execution plan stays outside the settings scroll area and updates with edits', () => {
		const fixture = modalFixture();
		try {
			const scroll = popup!.querySelector('.ai-consensus-settings')!;
			const plan = popup!.querySelector('.ai-consensus-execution-plan')!;
			assert.equal(scroll.contains(plan), false);
			change('一致率阈值', '90');
			assert.match(plan.textContent!, /90% 一致率/);
			change('离线提供商 / first 同题并发数', '3');
			assert.match(plan.textContent!, /基础 4 次请求.*最多 5 次/);
			assert.match(plan.textContent!, /最多并发 8 次/);
		} finally {
			fixture.cleanup();
		}
	});
	await test('saving applies the previewed strategy and cancel keeps the original configuration', () => {
		const fixture = modalFixture();
		try {
			change('一致率阈值', '90');
			click('取消');
			assert.equal(fixture.read().threshold, 75);
			fixture.button.click();
			change('一致率阈值', '90');
			change('主观题处理方式', 'summary');
			click('保存高级设置');
			assert.equal(fixture.read().threshold, 90);
			assert.equal(fixture.read().subjectiveRule, 'summary');
			assert.equal(popup!.isConnected, false);
			fixture.button.click();
			assert.match(popup!.querySelector('.ai-consensus-execution-plan')!.textContent!, /90% 一致率/);
		} finally {
			fixture.cleanup();
		}
	});
	await test('invalid counts keep the modal open and expose an actionable validation error', () => {
		const fixture = modalFixture();
		try {
			change('离线提供商 / first 同题并发数', '0');
			click('保存高级设置');
			assert.equal(popup!.isConnected, true);
			assert.match(popup!.querySelector('[role="alert"]')!.textContent!, /1–8/);
			assert.equal(fixture.read().assignments[0].threads, 2);
		} finally {
			fixture.cleanup();
		}
	});
	await test('threshold validation speaks the same terminology as the settings', () => {
		const fixture = modalFixture();
		try {
			change('一致率阈值', '101');
			click('保存高级设置');
			assert.match(popup!.querySelector('[role="alert"]')!.textContent!, /一致率阈值.*50–100/);
			assert.doesNotMatch(popup!.querySelector('[role="alert"]')!.textContent!, /置信度/);
		} finally {
			fixture.cleanup();
		}
	});
	await test('unknown question-level parallelism is explained without inventing a numeric limit', () => {
		const plan = describeAIConsensusPlan({ ...initial(), questionThreads: undefined });
		assert.match(plan.concurrency, /共同决定/);
		assert.doesNotMatch(plan.concurrency, /同时处理 1/);
	});
	await test('provider actions explicitly identify the ordinary-mode model and never change assignments', async () => {
		const runtime = globalThis as any;
		const originalGet = runtime.GM_getValue;
		runtime.GM_getValue = () => '';
		let state = { sources: initial().sources, selection: first };
		const originalAssignments = initial().assignments;
		try {
			openAIProviderManager({
				read: () => state,
				write: (next) => {
					state = next;
				}
			});
			assert.match(popup!.textContent!, /普通模式选择一个模型；高级模式.*高级模式设置/);
			assert.ok([...popup!.querySelectorAll('button')].some((button) => button.textContent === '普通模式当前模型'));
			const select = [...popup!.querySelectorAll('button')].find(
				(button) => button.textContent === '设为普通模式模型'
			)!;
			select.click();
			await Promise.resolve();
			assert.equal(state.selection, second);
			assert.match(popup!.querySelector('.status')!.textContent!, /普通模式模型已切换.*高级模式参与模型/);
			assert.deepEqual(originalAssignments, [
				{ key: first, threads: 2 },
				{ key: second, threads: 1 }
			]);
			assert.equal(
				[...popup!.querySelectorAll('button')].some((button) => button.textContent === '用于答题'),
				false
			);
		} finally {
			runtime.GM_getValue = originalGet;
			popup?.remove();
		}
	});
	console.log(`AI settings UX: ${checks} scenarios passed.`);
}
main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		$modal.simple = originalModal;
		popup?.remove();
	});
