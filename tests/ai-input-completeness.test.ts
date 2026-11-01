import assert from 'node:assert/strict';
import { AIAnswererConfig, AIQuestion, searchAIAnswer } from '../packages/core/src/core/answer-wrapper/ai';
import { AIEnsembleConfig, searchAIEnsemble } from '../packages/core/src/core/answer-wrapper/ai-ensemble';
import {
	AnswerWrapperHandlerConfig,
	defaultAnswerWrapperHandler
} from '../packages/core/src/core/answer-wrapper/answer.wrapper.handler';
import type { AnswererWrapper, SearchInformation } from '../packages/core/src/core/answer-wrapper/interface';
import { createDefaultQuestionResolver } from '../packages/core/src/core/worker/question.resolver';

const runtime = globalThis as any;
const previousGet = runtime.GM_getValue;
const previousRequest = runtime.GM_xmlhttpRequest;
const previousTimeout = AnswerWrapperHandlerConfig.timeout_seconds;
const model: AIAnswererConfig = {
	endpoint: 'https://input-completeness.invalid/v1',
	model: 'offline-input-check',
	vision: true,
	authMode: 'none'
};
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64pa';
const items = (texts: string[]) =>
	texts.map((text, index) => ({ label: String.fromCharCode(65 + index), text, image_refs: [] as string[] }));
let requests: any[] = [];
let checks = 0;
let responseAnswers = ['A'];
runtime.GM_getValue = () => '';
AnswerWrapperHandlerConfig.timeout_seconds = 0.2;
runtime.GM_xmlhttpRequest = (request: any) => {
	assert.match(request.url, /^https:\/\/input-completeness\.invalid\//, 'all transport stays in local fixtures');
	const body = request.data ? JSON.parse(request.data) : {};
	requests.push(body);
	const response = body.messages
		? {
				choices: [
					{
						finish_reason: 'stop',
						message: { content: JSON.stringify({ answers: responseAnswers, uncertain: false }) }
					}
				]
		  }
		: { question: 'legacy fixture', answer: 'A' };
	request.onload({ status: 200, responseText: JSON.stringify(response) });
};

async function test(name: string, run: () => Promise<void>) {
	requests = [];
	responseAnswers = ['A'];
	await run();
	checks++;
	console.log('PASS ' + name);
}

async function assertNoWrite(
	info: SearchInformation,
	type: 'single' | 'multiple' | 'judgement' | 'completion',
	texts: string[]
) {
	const options = texts.map((text) => {
		const element = document.createElement('div');
		element.textContent = text;
		return element;
	});
	let writes = 0;
	const resolver = createDefaultQuestionResolver({} as any, (element) => element.textContent || '')[type];
	const result = await resolver([info], options, async () => {
		writes++;
	});
	assert.equal(result.finish, false);
	assert.equal(writes, 0, 'a rejected question must not reach the page write handler');
}

async function rejected(question: AIQuestion, reason = /题目提取不完整/) {
	const info = await searchAIAnswer(model, question, 1000);
	assert.equal(requests.length, 0);
	assert.match(info.error || '', reason);
	assert.equal(info.results.length, 0);
	assert.equal(info.ai?.call.status, 'error');
	return info;
}

async function accepted(question: AIQuestion, answers = ['A']) {
	responseAnswers = answers;
	const info = await searchAIAnswer(model, question, 1000);
	assert.equal(requests.length, 1);
	assert.equal(info.error, undefined);
	assert.equal(info.results.length, 1);
	assert.deepEqual((info.results[0].extra_data as any).answers, answers);
	return info;
}

async function main() {
	await test('the reported blank stem and four empty groups make no request and cannot fill A', async () => {
		const info = await rejected({
			title: '_____。',
			type: 'single',
			option_count: 4,
			option_items: items(['', '', '', '']),
			question_image_refs: [],
			expected_image_count: 0,
			images: []
		});
		await assertNoWrite(info, 'single', ['', '', '', '']);
	});

	for (const title of ['', ' \n\u200b ', '____。', '（____）', '＿＿＿＿。', '[公式]', '[公式] ____。']) {
		await test('a missing or placeholder-only completion stem is rejected: ' + JSON.stringify(title), async () => {
			const info = await rejected({ title, type: 'completion', blank_count: 1 });
			await assertNoWrite(info, 'completion', ['']);
		});
	}

	for (const type of ['single', 'multiple', 'judgement'] as const) {
		await test(type + ' rejects all empty grouped options even when the stem is readable', async () => {
			const texts = ['', ' \n ', '____', '[公式]'];
			const info = await rejected({
				title: '请选择正确答案',
				type,
				option_count: texts.length,
				option_items: items(texts)
			});
			await assertNoWrite(info, type, texts);
		});
	}

	await test('validation uses the effective suggestion sent to the model rather than a stale readable stem', async () => {
		await rejected({ title: '旧题干', suggestion_title: '____。', type: 'completion', blank_count: 1 });
	});

	await test('images owned only by the options cannot replace a missing stem', async () => {
		await rejected({
			title: '____。',
			type: 'single',
			images: [image],
			expected_image_count: 1,
			question_image_refs: [],
			option_count: 2,
			option_items: [
				{ label: 'A', text: '[图片1]', image_refs: ['[图片1]'] },
				{ label: 'B', text: '另一个选项', image_refs: [] }
			]
		});
	});

	await test('empty strings in the uploaded image array are not treated as a usable question image', async () => {
		await rejected({ title: '', type: 'completion', blank_count: 1, images: [' '] });
	});

	for (const title of ['0', 'false', 'B', 'x', 'x=0', '[]', '()', '$x^2+y^2=0$', 'print(0)', '1+1=?']) {
		await test('short content and formulas remain usable: ' + title, async () => {
			await accepted({ title, type: 'completion', blank_count: 1 }, ['0']);
		});
	}

	await test('partial empty groups retain their positions and a normal native letter still fills the correct item', async () => {
		const texts = ['', '0', '', 'false'];
		const info = await accepted(
			{ title: '请选择为零的项', type: 'single', option_count: 4, option_items: items(texts) },
			['B']
		);
		const elements = texts.map((text) => {
			const element = document.createElement('div');
			element.textContent = text;
			return element;
		});
		let selected = -1;
		const result = await createDefaultQuestionResolver({} as any, (element) => element.textContent || '').single(
			[info],
			elements,
			async (_type, _answer, element) => {
				selected = elements.indexOf(element);
			}
		);
		assert.equal(result.finish, true);
		assert.equal(selected, 1);
	});

	await test('a pure image stem and multi-image options keep the submitted role mapping intact', async () => {
		const question: AIQuestion = {
			title: '[图片1][图片2]',
			type: 'single',
			images: Array.from({ length: 7 }, () => image),
			expected_image_count: 7,
			question_image_refs: ['[图片1]', '[图片2]'],
			option_count: 4,
			option_items: [
				{ label: 'A', text: '[图片3][图片4]', image_refs: ['[图片3]', '[图片4]'] },
				{ label: 'B', text: '[图片5]', image_refs: ['[图片5]'] },
				{ label: 'C', text: '0', image_refs: [] },
				{ label: 'D', text: '[图片6][图片7]', image_refs: ['[图片6]', '[图片7]'] }
			]
		};
		await accepted(question, ['D']);
		const parts = requests[0].messages[1].content;
		assert.equal(parts.filter((part: any) => part.type === 'image_url').length, 7);
		const payload = JSON.parse(parts[0].text);
		assert.deepEqual(payload.question_image_refs, question.question_image_refs);
		assert.deepEqual(payload.option_items, question.option_items);
	});

	await test('one stem screenshot may contain the whole question and its options', async () => {
		await accepted({
			title: '',
			type: 'single',
			images: [image],
			question_image_refs: ['[图片1]'],
			option_count: 4,
			option_items: items(['', '', '', ''])
		});
	});

	await test('legacy whole-question screenshots without ownership metadata stay compatible', async () => {
		await accepted({ title: '', type: 'single', images: [image] });
	});

	await test('legacy online selections may keep their entire options inside the title', async () => {
		await accepted({ title: '1+1=? A.1 B.2 C.3 D.4', type: 'single', options: '' }, ['B']);
	});

	await test('legacy flat options without grouped metadata stay compatible', async () => {
		await accepted({ title: '1+1=?', type: 'single', options: '1\n2\n3\n4', option_count: 4 }, ['B']);
	});

	await test('legacy completion words and unknown selected text do not require option groups', async () => {
		await accepted({ title: '解释这个词语：接口', type: 'unknown' }, ['程序之间约定的交互方式']);
	});

	for (const rule of ['confidence', 'confidence-then-summary', 'summary'] as const) {
		await test('advanced ' + rule + ' cannot pay participants or summary for incomplete input', async () => {
			const config: AIEnsembleConfig = {
				models: [model, { ...model, model: 'second' }],
				summary: { ...model, model: 'summary' },
				rule,
				threshold: 80
			};
			const info = await searchAIEnsemble(
				config,
				{
					title: '____。',
					type: 'single',
					option_count: 4,
					option_items: items(['', '', '', '']),
					images: [],
					expected_image_count: 0,
					question_image_refs: []
				},
				1000
			);
			assert.equal(requests.length, 0);
			assert.equal(info.ensemble?.status, 'review');
			assert.equal(info.results.length, 0);
			assert.ok(info.ensemble?.members.every((member) => /题目提取不完整/.test(member.error || '')));
			if (rule.includes('summary')) assert.match(info.ensemble?.summary?.error || '', /题目提取不完整/);
			await assertNoWrite(info, 'single', ['', '', '', '']);
		});
	}

	await test('advanced subjective selected cannot bypass the same empty-stem guard', async () => {
		const info = await searchAIEnsemble(
			{
				models: [model, { ...model, model: 'second' }],
				rule: 'confidence',
				subjectiveRule: 'selected',
				subjectiveModelIndex: 0
			},
			{ title: '____。', type: 'completion', blank_count: 1 },
			1000
		);
		assert.equal(requests.length, 0);
		assert.equal(info.ensemble?.status, 'review');
		await assertNoWrite(info, 'completion', ['']);
	});

	await test('the real wrapper dispatcher exposes a useful extraction error with no network or page write', async () => {
		const wrapper: AnswererWrapper = {
			name: 'native',
			url: model.endpoint,
			type: 'GM_xmlhttpRequest',
			method: 'post',
			headers: {},
			handler: '',
			ai: model
		};
		const infos = await defaultAnswerWrapperHandler([wrapper], {
			title: '____。',
			type: 'single',
			option_count: 4,
			option_items: items(['', '', '', '']),
			expected_image_count: 0
		});
		assert.equal(requests.length, 0);
		assert.match(infos[0].error || '', /题目提取不完整/);
		await assertNoWrite(infos[0], 'single', ['', '', '', '']);
	});

	await test('traditional question-bank requests are unaffected by the native AI guard', async () => {
		const wrapper: AnswererWrapper = {
			name: 'traditional',
			url: model.endpoint,
			type: 'GM_xmlhttpRequest',
			method: 'post',
			headers: {},
			data: { title: '${title}' },
			handler: 'return response => [response.question, response.answer]'
		};
		const infos = await defaultAnswerWrapperHandler([wrapper], { title: '____。', type: 'single', options: '' });
		assert.equal(requests.length, 1);
		assert.equal(infos[0].error, undefined);
		assert.equal(infos[0].results[0].answer, 'A');
	});

	console.log(`AI input completeness: ${checks} production scenarios passed.`);
}
main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		runtime.GM_getValue = previousGet;
		runtime.GM_xmlhttpRequest = previousRequest;
		AnswerWrapperHandlerConfig.timeout_seconds = previousTimeout;
	});
