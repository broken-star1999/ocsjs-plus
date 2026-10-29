import assert from 'node:assert/strict';
import { resolveAIQuestionType } from '../packages/core/src/core/answer-wrapper/ai-question-type';
import { buildAIRequest, searchAIAnswer, AIQuestion } from '../packages/core/src/core/answer-wrapper/ai';

const config = { endpoint: 'https://example.com/v1', model: 'test-model', vision: false };
let checks = 0;
async function test(name: string, action: () => void | Promise<void>) {
	await action();
	checks++;
	console.log('PASS ' + name);
}
const prompt = (question: AIQuestion) => String(buildAIRequest(config, question).messages[0].content);
const payload = (question: AIQuestion) => JSON.parse(String(buildAIRequest(config, question).messages[1].content));

async function main() {
	for (const type of ['single', 'multiple', 'judgement', 'completion'])
		await test('explicit platform type is preserved despite a conflicting leading label: ' + type, () => {
			const question = Object.freeze({ type, title: '多选题：题干包含单选题、判断题、填空题字样。' });
			assert.equal(resolveAIQuestionType(question), type);
			assert.equal(payload(question).type, type);
			assert.equal(question.type, type);
		});
	for (const [title, type] of [
		['1. (单选题, 7.0 分) 题干', 'single'],
		['一. 单选题（共 11 题）', 'single'],
		['【多选题】题干', 'multiple'],
		['3. （判断题，5 分）题干', 'judgement'],
		['填空题：题干', 'completion'],
		['简答题 题干', 'completion']
	])
		await test('only untyped selections use a leading explicit label: ' + title, () => {
			assert.equal(resolveAIQuestionType({ type: 'unknown', title }), type);
			assert.equal(resolveAIQuestionType({ title }), type);
			assert.equal(payload({ type: 'unknown', title }).type, type);
		});
	for (const title of ['请说明单选题与多选题的区别。', '判断题为什么也使用单选控件？', '公式中包含“判断题”这个词。'])
		await test('incidental type words never classify an untyped question: ' + title, () => {
			assert.equal(resolveAIQuestionType({ type: 'unknown', title }), 'unknown');
			assert.equal(payload({ type: 'unknown', title }).type, 'unknown');
		});
	await test('an unsupported explicit platform type does not get reclassified through its title', () => {
		assert.equal(payload({ type: 'line', title: '单选题：此标签与平台题型冲突' }).type, 'unknown');
	});
	for (const [type, ownRule, otherRules] of [
		['single', /本题为单选题/, /本题为多选题|本题为判断题|按网页空位顺序/],
		['multiple', /本题为多选题/, /本题为单选题|本题为判断题|按网页空位顺序/],
		['judgement', /值只能为“正确”或“错误”/, /本题为单选题|本题为多选题|按网页空位顺序/],
		['completion', /本题为填空或简答题/, /本题为单选题|本题为多选题|本题为判断题/]
	] as const)
		await test('typed prompt contains only its own answer contract: ' + type, () => {
			const text = prompt({ type, title: '题干' });
			assert.match(text, ownRule);
			assert.doesNotMatch(text, otherRules);
			assert.match(text, /type 字段由程序确定/);
			assert.match(text, /思考内容.*简体中文/);
		});
	await test('untyped prompt explicitly reports the missing type and allows uncertainty', () => {
		assert.match(prompt({ title: '未分类的内容' }), /未取得明确的网页题型/);
		assert.match(prompt({ title: '未分类的内容' }), /"uncertain":true/);
	});
	await test('summary receives the same judgement contract and no choice examples', () => {
		const question = { type: 'judgement', title: '题干', model_reports: [{ name: 'model', answers: ['A'] }] };
		assert.match(prompt(question), /总结核对/);
		assert.match(prompt(question), /值只能为“正确”或“错误”/);
		assert.doesNotMatch(prompt(question), /本题为单选题|本题为多选题/);
		assert.deepEqual(payload(question).model_reports, question.model_reports);
	});
	for (const model of ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed'])
		await test('documented official MiMo model enables JSON mode: ' + model, () => {
			assert.equal(
				buildAIRequest({ ...config, endpoint: 'https://api.xiaomimimo.com/v1', model }, { title: '题干' })
					.response_format?.type,
				'json_object'
			);
		});
	await test('JSON mode preserves explicit overrides and never assumes gateway/model support', () => {
		const question = { type: 'judgement', title: '题干' };
		assert.equal(buildAIRequest({ ...config, model: 'mimo-v2.6-flash' }, question).response_format, undefined);
		assert.equal(
			buildAIRequest({ ...config, endpoint: 'https://api.xiaomimimo.com/v1', model: 'unverified-model' }, question)
				.response_format,
			undefined
		);
		for (const endpoint of ['https://api.deepseek.com', 'https://api.xiaomimimo.com/v1'])
			assert.deepEqual(
				buildAIRequest(
					{ ...config, endpoint, model: 'mimo-v2.6-flash', extraBody: { response_format: { type: 'text' } } },
					question
				).response_format,
				{ type: 'text' }
			);
	});
	await test('request and parser use the same recovered type, while preserving the original selection', async () => {
		const runtime = globalThis as any;
		let sent: any;
		runtime.GM_getValue = () => 'test-only-key';
		runtime.GM_xmlhttpRequest = (request: any) => {
			sent = JSON.parse(request.data);
			request.onload({
				status: 200,
				responseText: JSON.stringify({
					choices: [{ finish_reason: 'stop', message: { content: '{"answers":["A"],"uncertain":false}' } }]
				})
			});
		};
		const question = Object.freeze({ type: 'unknown', title: '1. (判断题, 5 分) 题干', options: 'A. 错\nB. 对' });
		const info = await searchAIAnswer(config, question, 1000);
		assert.equal(JSON.parse(sent.messages[1].content).type, 'judgement');
		assert.match(sent.messages[0].content, /本题为判断题/);
		assert.equal(info.results[0].answer, '错误');
		assert.equal(question.type, 'unknown');
	});
	console.log(`AI question types: ${checks} scenarios passed.`);
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
