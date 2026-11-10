import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { $ } from 'easy-us';
import { AnswerWrapperHandlerConfig as builtConfig } from '../packages/core';
import { AnswerWrapperHandlerConfig } from '../packages/core/src/core/answer-wrapper/answer.wrapper.handler';
import { StringUtils } from '../packages/core/src/utils/string';
import { createDefaultQuestionResolver } from '../packages/core/src/core/worker/question.resolver';
import { createCommonAnswerer, extractTextWithImages, removeRedundantWords } from '../packages/scripts/src/utils/work';
import { extractCxAIContent } from '../packages/scripts/src/utils/ai-cx-mathjax';
import { readCXQuestionTypeCode } from '../packages/scripts/src/utils/cx-question-type';
import { CommonProject } from '../packages/scripts/src/projects/common';

const source = fs.readFileSync('packages/scripts/src/projects/cx.ts', 'utf8');
const start = source.indexOf('const workOrExamQuestionTitleTransform =');
const end = source.indexOf('// 这里跟章节测试', start);
const file = ts.createSourceFile('cx.ts', source, ts.ScriptTarget.Latest, true);
const typeFunction = file.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'getQuestionType')!;
const dependencies = {
	createCommonAnswerer,
	extractCxAIContent,
	extractTextWithImages,
	removeRedundantWords,
	StringUtils,
	readCXQuestionTypeCode,
	ensureCxFontDecrypted: async () => {}
};
const factory = new Function(
	...Object.keys(dependencies),
	'answererWrappers',
	ts.transpileModule(
		"const redundanceWordsText = ''; const period = 0;" +
			typeFunction.getText(file) +
			source.slice(start, end) +
			'\nreturn answerQuestion;',
		{ compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }
	).outputText
);
const formula = (latex: string) => {
	const container = document.createElement('mjx-container');
	container.className = 'MathJax';
	container.innerHTML = '<svg><g data-mml-node="math"><g data-latex="WRONG-PART"></g></g></svg>';
	container.querySelector('g')!.setAttribute('data-latex', latex);
	return container.outerHTML;
};
const determinant =
	'\\begin{vmatrix}\n\\lambda-a & -1 & -1 \\\\\n-1 & \\lambda-a & 1 \\\\\n-1 & 1 & \\lambda-a\n\\end{vmatrix}=0';
const root = document.createElement('div');
root.innerHTML =
	'<h3>1.<span>(单选题)</span><div>若' + formula(determinant) + ',则' + formula('\\lambda=') + '____.</div></h3>';
const optionTexts = ['a+1,a+1,a-2', '1,1,-1', 'a,a+1,a-2', 'a+1,a-2,a-2'];
const options = optionTexts.map((text, i) => {
	const el = document.createElement('div');
	el.setAttribute('data', ['C', 'B', 'D', 'A'][i]);
	el.textContent = text;
	return el;
});
const type = document.createElement('input');
type.name = 'type123';
type.value = '0';
const elements = { title: [root.querySelector('h3')!], options, type: [type] };
const native: any = {
	name: 'native',
	url: 'https://mathjax.invalid/v1',
	ai: { endpoint: 'https://mathjax.invalid/v1', model: 'fixture', authMode: 'none' }
};
const bank: any = {
	name: 'bank',
	url: 'https://mathjax.invalid/bank',
	method: 'post',
	type: 'GM_xmlhttpRequest',
	headers: {},
	data: { title: '${title}', options: '${options}' },
	handler: 'return r => [r.question, r.answer]'
};
const runtime = globalThis as any;
const previous = {
	timeout: AnswerWrapperHandlerConfig.timeout_seconds,
	builtTimeout: builtConfig.timeout_seconds,
	sleep: $.sleep,
	get: runtime.GM_getValue,
	request: runtime.GM_xmlhttpRequest,
	optimize: CommonProject.scripts.settings.cfg.imageOptimize
};
let requests: any[] = [];
$.sleep = async () => {};
AnswerWrapperHandlerConfig.timeout_seconds = 0.2;
builtConfig.timeout_seconds = 0.2;
runtime.GM_getValue = () => '';
CommonProject.scripts.settings.cfg.imageOptimize = false;
runtime.GM_xmlhttpRequest = (req: any) => {
	assert.match(req.url, /^https:\/\/mathjax\.invalid\//);
	const body = JSON.parse(req.data);
	requests.push(body);
	const response = body.messages
		? {
				choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: ['A'], uncertain: false }) } }]
		  }
		: { question: body.title, answer: 'A' };
	req.onload({ status: 200, responseText: JSON.stringify(response) });
};
const run = async (wrappers: any[], input = elements) => {
	requests = [];
	const answerer = factory(...Object.values(dependencies), wrappers);
	return answerer(input, { elements: input, type: 'single' });
};
async function main() {
	try {
		const before = root.innerHTML;
		const info = await run([native]);
		const payload = JSON.parse(requests[0].messages[1].content);
		assert.ok(payload.question.includes(determinant));
		assert.ok(payload.question.includes('\\lambda='));
		assert.equal(payload.question.includes('WRONG-PART'), false);
		assert.deepEqual(
			payload.option_items.map((i: any) => i.text),
			optionTexts
		);
		let selected = -1;
		const result = await createDefaultQuestionResolver({} as any, (el) => el.textContent || '').single(
			info,
			options,
			async (_type, _answer, option) => {
				selected = options.indexOf(option);
			}
		);
		assert.equal(result.finish, true);
		assert.equal(selected, 0);
		assert.equal(root.innerHTML, before);
		console.log('PASS real CX extraction -> native request -> displayed A resolver (shuffled internal letters)');
		const mixed = await run([bank, native]);
		assert.deepEqual(
			mixed.map((i: any) => i.name),
			['bank', 'AI · fixture']
		);
		assert.equal(requests.find((b) => !b.messages).title, '若,则____.');
		assert.ok(JSON.parse(requests.find((b) => b.messages).messages[1].content).question.includes(determinant));
		console.log('PASS mixed bank/AI payload isolation and configured order');
		const missing = document.createElement('h3');
		missing.innerHTML =
			'1.<span>题型</span>若<mjx-container><svg><g data-latex="partial"/></svg></mjx-container>则____';
		const rejected = await run([native], { ...elements, title: [missing] });
		assert.equal(requests.length, 0);
		assert.match(rejected[0].error, /无法识别公式/);
		console.log('PASS unreadable formula cannot cause a paid request');
		const rich = document.createElement('div');
		rich.innerHTML = '前' + formula('x% comment\n+y') + '<img src="https://mathjax.invalid/a.png">后' + formula('z');
		const extracted = extractCxAIContent(rich);
		assert.ok(extracted.text.includes('x% comment\n+y'));
		assert.deepEqual(extracted.images, ['https://mathjax.invalid/a.png']);
		assert.ok(extracted.text.indexOf('$x') < extracted.text.indexOf('a.png'));
		assert.ok(extracted.text.indexOf('a.png') < extracted.text.indexOf('$z'));
		const nested = document.createElement('div');
		nested.innerHTML = '<mjx-container>' + formula('x') + '</mjx-container>';
		assert.equal(extractCxAIContent(nested).text.match(/\$x\$/g)?.length, 1);
		console.log('PASS source newlines, image ordering, nested wrapper deduplication');
		if (process.env.MATHJAX_TEST_HTML) {
			const saved = document.createElement('div');
			saved.innerHTML = fs.readFileSync(process.env.MATHJAX_TEST_HTML, 'utf8');
			const first = saved.querySelector('.questionLi')!;
			const realElements = {
				title: [first.querySelector('h3') as HTMLElement],
				options: Array.from(first.querySelectorAll('.answerBg .answer_p')) as HTMLElement[],
				type: Array.from(first.querySelectorAll('input[name^="type"]')) as HTMLInputElement[]
			};
			await run([native], realElements);
			const realPayload = JSON.parse(requests[0].messages[1].content);
			assert.ok(realPayload.question.includes('\\begin{vmatrix}'));
			assert.ok(realPayload.question.includes('\\lambda ='));
			assert.deepEqual(
				realPayload.option_items.map((item: any) => item.text),
				optionTexts
			);
			console.log('PASS user-supplied saved HTML first question retains both complete formulas');
		}
	} finally {
		AnswerWrapperHandlerConfig.timeout_seconds = previous.timeout;
		builtConfig.timeout_seconds = previous.builtTimeout;
		$.sleep = previous.sleep;
		runtime.GM_getValue = previous.get;
		runtime.GM_xmlhttpRequest = previous.request;
		CommonProject.scripts.settings.cfg.imageOptimize = previous.optimize;
	}
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
