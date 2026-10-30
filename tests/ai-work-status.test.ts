import assert from 'node:assert/strict';
import {
	createAIAnswererWrappers,
	aiModelKey,
	AIProviderState
} from '../packages/core/src/core/answer-wrapper/ai-providers';
import { createAIWorkSummary, inspectAIWorkConfiguration } from '../packages/scripts/src/utils/ai-work-status';

const state: AIProviderState = {
	selection: aiModelKey('test', 'a'),
	sources: [
		{
			id: 'test',
			name: '测试服务',
			preset: 'openai',
			authMode: 'none',
			endpoint: 'https://test.invalid/v1',
			timeoutSeconds: 10,
			catalog: [],
			models: ['a', 'b'].map((id) => ({ id, name: '模型 ' + id, enabled: true, vision: true, extraBody: {} }))
		}
	]
};
const assignments = [
	{ key: aiModelKey('test', 'a'), threads: 3 },
	{ key: aiModelKey('test', 'b'), threads: 1 }
];
let checks = 0;
function test(name: string, run: () => void) {
	run();
	checks++;
	console.log('PASS ' + name);
}
if (!Element.prototype.replaceChildren)
	Element.prototype.replaceChildren = function (...nodes: (Node | string)[]) {
		while (this.firstChild) this.removeChild(this.firstChild);
		for (const node of nodes) this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
	};

test('unconfigured basic AI is blocked before a task starts', () => {
	const result = inspectAIWorkConfiguration({ aiEnabled: true, answererWrappers: [] });
	assert.equal(result.ready, false);
	assert.match(result.error, /普通模式模型|高级模式配置/);
});
test('empty advanced assignments cannot masquerade as a configured wrapper', () => {
	const wrappers = createAIAnswererWrappers(state, true, []);
	assert.equal(wrappers.length, 1);
	assert.equal(
		inspectAIWorkConfiguration({ aiEnabled: true, aiAnswerMode: 'advanced', answererWrappers: wrappers }).ready,
		false
	);
});
test('deleted participant is a global readiness error', () => {
	const wrappers = createAIAnswererWrappers({ ...state, sources: [] }, true, assignments);
	assert.match(inspectAIWorkConfiguration({ answererWrappers: wrappers }).error, /删除|停用/);
});
test('basic readiness identifies its provider/model and one request', () => {
	const result = inspectAIWorkConfiguration({
		aiEnabled: true,
		answererWrappers: createAIAnswererWrappers(state),
		thread: 2
	});
	assert.equal(result.ready, true);
	assert.deepEqual(result.names, ['测试服务 / 模型 a']);
	assert.equal(result.baseCalls, 1);
	assert.equal(result.maxRequests, 2);
});
test('advanced request scale combines question threads and per-question invocations', () => {
	const result = inspectAIWorkConfiguration({
		answererWrappers: createAIAnswererWrappers(state, true, assignments),
		thread: 3
	});
	assert.equal(result.ready, true);
	assert.equal(result.baseCalls, 4);
	assert.equal(result.maxRequests, 12);
	assert.equal(result.names.length, 2);
});
test('summary budget is additional per-question work and does not inflate concurrent member count', () => {
	const wrappers = createAIAnswererWrappers(state, true, assignments, {
		confidenceEnabled: true,
		rule: 'summary-then-confidence',
		summaryEnabled: true,
		summarySelection: state.selection
	});
	const result = inspectAIWorkConfiguration({ answererWrappers: wrappers, thread: 3 });
	assert.equal(result.summaryCalls, 1);
	assert.equal(result.maxRequests, 12);
});
test('missing subjective summary is visible without blocking independent objective work', () => {
	const wrappers = createAIAnswererWrappers(state, true, assignments, {
		confidenceEnabled: true,
		rule: 'confidence',
		summaryEnabled: true,
		summarySelection: 'removed',
		subjectiveRule: 'summary'
	});
	const result = inspectAIWorkConfiguration({ answererWrappers: wrappers });
	assert.equal(result.ready, true);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /总结/);
});
test('an unselected subjective model is explicitly reported as a manual route', () => {
	const wrappers = createAIAnswererWrappers(state, true, assignments, { rule: 'manual', subjectiveRule: 'selected' });
	const result = inspectAIWorkConfiguration({ answererWrappers: wrappers });
	assert.equal(result.ready, true);
	assert.match(result.warnings.join(''), /主观题.*人工/);
});
test('invalid endpoint blocks work without sending credentials anywhere', () => {
	const wrappers = createAIAnswererWrappers(state);
	wrappers[0].ai!.endpoint = 'javascript:bad';
	assert.match(inspectAIWorkConfiguration({ answererWrappers: wrappers }).error, /接口地址无效/);
});
test('legacy mode requires a wrapper but not AI metadata', () => {
	assert.equal(inspectAIWorkConfiguration({ aiEnabled: false, answererWrappers: [] }).ready, false);
	const wrapper = { name: 'legacy', url: 'https://bank.invalid', method: 'get' } as any;
	const result = inspectAIWorkConfiguration({ aiEnabled: false, answererWrappers: [wrapper] });
	assert.equal(result.ready, true);
	assert.equal(result.isAI, false);
});
test('summary component follows configuration changes without overwriting settings', () => {
	let options = { aiEnabled: true, answererWrappers: createAIAnswererWrappers(state), thread: 1 };
	let update = () => {};
	let stopped = false;
	const root = createAIWorkSummary({
		read: () => options,
		observe: (callback) => {
			update = callback;
			return () => {
				stopped = true;
			};
		}
	});
	document.body.append(root);
	assert.match(root.textContent!, /普通模式 · 已就绪/);
	options = { ...options, answererWrappers: createAIAnswererWrappers(state, true, assignments), thread: 3 };
	update();
	assert.match(root.textContent!, /高级模式 · 已就绪/);
	assert.match(root.textContent!, /12 个在途/);
	options = { ...options, answererWrappers: createAIAnswererWrappers(state, true, []) };
	update();
	assert.match(root.textContent!, /尚未就绪/);
	root.remove();
	update();
	assert.equal(stopped, true);
});
console.log(`AI work readiness: ${checks} scenarios passed.`);
