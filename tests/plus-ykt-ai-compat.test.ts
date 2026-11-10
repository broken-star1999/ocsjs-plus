import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { $, $$el } from 'easy-us';
import { AnswerWrapperHandlerConfig as builtHandlerConfig } from '../packages/core';
import { OCSWorker } from '../packages/core/src/core/worker/worker';
import { StringUtils } from '../packages/core/src/utils/string';
import { defaultWorkTypeResolver } from '../packages/core/src/core/worker/utils';
import { createDefaultQuestionResolver } from '../packages/core/src/core/worker/question.resolver';
import { domSearchAll } from '../packages/core/src/core/utils/dom';
import { AnswerWrapperHandlerConfig } from '../packages/core/src/core/answer-wrapper/answer.wrapper.handler';
import type { AnswererWrapper } from '../packages/core/src/core/answer-wrapper/interface';
import { createCommonAnswerer, extractTextWithImages, removeRedundantWords } from '../packages/scripts/src/utils/work';
import { extractYktAIContent } from '../packages/scripts/src/utils/ai-ykt-content';
import { CommonProject } from '../packages/scripts/src/projects/common';

/** Real private YKT factory, environment builder, native requests and resolver.
 * Only DOM pages, PNG dimensions, transport and panel rendering are fixtures.
 */
const filename = path.resolve(__dirname, '../packages/scripts/src/projects/yuketang.ts');
const file = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	for (const node of file.statements) {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) return node.getText(file);
		if (ts.isVariableStatement(node)) {
			const item = node.declarationList.declarations.find((value) => value.name.getText(file) === name);
			if (item?.initializer) return 'const ' + name + ' = ' + item.initializer.getText(file) + ';';
		}
	}
	throw new Error('Missing production declaration: ' + name);
}
const source = [
	'YKT_BLANK_INPUT_SELECTOR',
	'cloneYktForTextExtract',
	'extractYktTitleText',
	'parseYktQuestionType',
	'createYktAnswerWorker'
]
	.map(declaration)
	.join('\n');
const dependencies = {
	OCSWorker,
	StringUtils,
	defaultWorkTypeResolver,
	createDefaultQuestionResolver,
	$,
	$$el,
	createCommonAnswerer,
	extractTextWithImages,
	removeRedundantWords,
	extractYktAIContent,
	CommonProject,
	Event: window.Event,
	updateDynamicResult: () => {},
	fillYktUEditor: () => assert.fail('no editor iframe is used in this fixture')
};
const createWorker = new Function(
	...Object.keys(dependencies),
	ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } })
		.outputText + '\nreturn createYktAnswerWorker;'
)(...Object.values(dependencies));
const runtime = globalThis as any;
const previous = {
	request: runtime.GM_xmlhttpRequest,
	get: runtime.GM_getValue,
	sleep: $.sleep,
	optimize: CommonProject.scripts.settings.cfg.imageOptimize,
	timeout: AnswerWrapperHandlerConfig.timeout_seconds,
	builtTimeout: builtHandlerConfig.timeout_seconds
};
let checks = 0,
	sequence = 0;
let answer = ['B'];
let requests: { url: string; body: any; payload?: any }[] = [];
let delays: Record<string, number> = {};
runtime.GM_getValue = () => '';
$.sleep = async () => {};
AnswerWrapperHandlerConfig.timeout_seconds = 0.2;
builtHandlerConfig.timeout_seconds = 0.2;
CommonProject.scripts.settings.cfg.imageOptimize = true;
runtime.GM_xmlhttpRequest = (request: any) => {
	assert.match(request.url, /^https:\/\/ykt-compat\.invalid\//, 'no external service may be contacted');
	const body = request.data ? JSON.parse(request.data) : {};
	const content = body.messages?.[1]?.content;
	requests.push({
		url: request.url,
		body,
		...(body.messages ? { payload: JSON.parse(typeof content === 'string' ? content : content[0].text) } : {})
	});
	const response = body.messages
		? {
				choices: [
					{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: answer, uncertain: false }) } }
				]
		  }
		: { question: body.title, answer: answer.join('#') };
	const done = () => request.onload({ status: 200, responseText: JSON.stringify(response) });
	const delay = delays[body.model || request.url] || 0;
	if (delay) setTimeout(done, delay);
	else done();
};
const native = (name = 'native-one'): AnswererWrapper => ({
	name,
	url: 'https://ykt-compat.invalid/v1',
	method: 'post',
	type: 'GM_xmlhttpRequest',
	headers: {},
	handler: '',
	ai: { endpoint: 'https://ykt-compat.invalid/v1', authMode: 'none', model: name, label: name, vision: true }
});
const envField = (name: string) => '$' + '{' + name + '}';
const bank = (name = 'bank-one'): AnswererWrapper => ({
	name,
	url: 'https://ykt-compat.invalid/bank/' + name,
	method: 'post',
	type: 'GM_xmlhttpRequest',
	headers: {},
	data: {
		title: envField('title'),
		options: envField('options'),
		images: envField('images'),
		suggestion_title: envField('suggestion_title')
	},
	handler: 'return response => [response.question, response.answer]'
});
function png(index: number): string {
	const bytes = Buffer.alloc(26);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	bytes.writeUInt32BE(20 + index, 16);
	bytes.writeUInt32BE(20, 20);
	bytes[24] = 8;
	bytes[25] = 6;
	return 'data:image/png;base64,' + bytes.toString('base64');
}
function formula(index: number, latex?: string, alternate?: string): string {
	const node = document.createElement('img');
	node.className = 'kfformula';
	node.src = png(index);
	if (latex !== undefined) node.setAttribute('data-latex', latex);
	if (alternate !== undefined) node.setAttribute('data-slatex', alternate);
	return node.outerHTML;
}
async function test(name: string, run: () => Promise<void>) {
	requests = [];
	answer = ['B'];
	delays = {};
	await run();
	checks++;
	console.log('PASS ' + name);
}
async function query(
	stem: string,
	optionContent: string[],
	wrappers: AnswererWrapper[] = [native()],
	type = '单选题',
	inputValues?: string[]
) {
	const root = document.createElement('section');
	const radioName = 'ykt-compat-' + ++sequence;
	root.innerHTML =
		'<div class="item-type">' +
		type +
		'</div><div class="problem-body">' +
		stem +
		'</div>' +
		(optionContent.length
			? '<ul class="list-unstyled">' +
			  optionContent
					.map(
						(html, index) =>
							'<li><label><input type="radio" name="' +
							radioName +
							'" value="' +
							(inputValues?.[index] || String.fromCharCode(65 + index)) +
							'"><span class="radioText">' +
							html +
							'</span></label></li>'
					)
					.join('') +
			  '</ul>'
			: '');
	document.body.append(root);
	const initial = root.innerHTML;
	const { worker, questionRootRef } = createWorker({
		answererWrappers: wrappers,
		period: 0,
		thread: 1,
		redundanceWordsText: '',
		answerSeparators: '#'
	});
	questionRootRef.push(root);
	const ctx: any = { root, elements: domSearchAll(worker.opts.elements, root), searchInfos: [] };
	let clicks = 0;
	const labels = [...root.querySelectorAll('label')];
	labels.forEach((label) => {
		label.onclick = (event) => {
			if (event.target !== label) return;
			clicks++;
			labels.forEach((other) => {
				other.querySelector('input')!.checked = other === label;
			});
		};
	});
	try {
		const infos = await worker.opts.answerer(ctx.elements, ctx);
		ctx.searchInfos = infos;
		assert.equal(root.innerHTML, initial, 'extraction must not mutate source formula images or editable fields');
		return {
			root,
			ctx,
			infos,
			worker,
			initial,
			clicks: () => clicks,
			resolve: () => worker.opts.work(ctx),
			cleanup: () => {
				worker.emit('close');
				root.remove();
			}
		};
	} catch (error) {
		worker.emit('close');
		root.remove();
		throw error;
	}
}
const nativeRequests = () => requests.filter((request) => request.body.messages);
const bankRequests = () => requests.filter((request) => !request.body.messages);

async function main() {
	await test('native factory retains no-metadata title images and four multi-image option groups', async () => {
		const page = await query('题干 ' + formula(0) + formula(1), [
			formula(2) + formula(3),
			formula(4),
			'0',
			formula(5) + formula(6)
		]);
		try {
			const request = nativeRequests()[0];
			assert.equal(nativeRequests().length, 1);
			assert.equal(request.body.messages[1].content.filter((part: any) => part.type === 'image_url').length, 7);
			assert.deepEqual(request.payload.question_image_refs, ['[图片1]', '[图片2]']);
			assert.deepEqual(
				request.payload.option_items.map((item: any) => item.label),
				['A', 'B', 'C', 'D']
			);
			assert.deepEqual(
				request.payload.option_items.map((item: any) => item.image_refs),
				[['[图片3]', '[图片4]'], ['[图片5]'], [], ['[图片6]', '[图片7]']]
			);
			assert.equal(request.payload.option_items[2].text, '0');
			assert.equal((await page.resolve()).finish, true);
			assert.equal(page.root.querySelectorAll('input')[1].checked, true);
			assert.equal(page.clicks(), 1);
		} finally {
			page.cleanup();
		}
	});
	await test('native factory uses valid LaTeX without uploading redundant formula images', async () => {
		const page = await query(formula(0, '\\frac{1}{2}'), [formula(1, '1'), formula(2, '2')]);
		try {
			const request = nativeRequests()[0];
			assert.equal(typeof request.body.messages[1].content, 'string');
			assert.equal(request.payload.question, '$\\frac{1}{2}$');
			assert.deepEqual(
				request.payload.option_items.map((item: any) => item.text),
				[' $1$ ', ' $2$ ']
			);
			assert.deepEqual(request.payload.question_image_refs, []);
			assert.deepEqual(
				request.payload.option_items.map((item: any) => item.image_refs),
				[[], []]
			);
		} finally {
			page.cleanup();
		}
	});
	await test('native factory uses escaped fallback metadata when data-latex is blank', async () => {
		const page = await query(formula(0, '  ', '\\\\alpha+1'), ['甲', '乙']);
		try {
			assert.equal(nativeRequests()[0].payload.question, '$\\alpha+1$');
		} finally {
			page.cleanup();
		}
	});
	await test('native factory keeps ordinary images beside valid formulas in the same option group', async () => {
		const page = await query('选择正确结果', [formula(1, 'x^2') + '<img src="' + png(2) + '">', '0']);
		try {
			const request = nativeRequests()[0];
			assert.equal(request.body.messages[1].content.filter((part: any) => part.type === 'image_url').length, 1);
			assert.match(request.payload.option_items[0].text, /\$x\^2\$/);
			assert.deepEqual(request.payload.option_items[0].image_refs, ['[图片1]']);
			assert.deepEqual(request.payload.question_image_refs, []);
		} finally {
			page.cleanup();
		}
	});
	await test('judgement icons retain true/false semantics and fill the matching option', async () => {
		answer = ['正确'];
		const page = await query(
			'1+1=2',
			['<i class="wrong-icon"></i>', '<i class="right-icon"></i>'],
			[native()],
			'判断题',
			['false', 'true']
		);
		try {
			const request = nativeRequests()[0];
			assert.equal(request.payload.type, 'judgement');
			assert.deepEqual(
				request.payload.option_items.map((item: any) => item.text),
				['错', '对']
			);
			assert.equal((await page.resolve()).finish, true);
			assert.equal(page.root.querySelectorAll('input')[1].checked, true);
		} finally {
			page.cleanup();
		}
	});
	await test('completion sends actual writable count rather than repeated illustrative underscores', async () => {
		answer = ['26'];
		const page = await query(
			'range(____,-4,-2)执行15次，初值为____。<input class="blank-item-dynamic" placeholder="输入答案">',
			[],
			[native()],
			'填空题'
		);
		try {
			const payload = nativeRequests()[0].payload;
			assert.equal(payload.type, 'completion');
			assert.equal(payload.blank_count, 1);
			assert.equal(payload.option_items, undefined);
			assert.equal((await page.resolve()).finish, true);
			assert.equal(page.root.querySelector<HTMLInputElement>('.blank-item-dynamic')!.value, '26');
		} finally {
			page.cleanup();
		}
	});
	await test('traditional factory preserves upstream placeholders and actual request body', async () => {
		const page = await query(formula(0), [formula(1), formula(2)], [bank()]);
		try {
			assert.equal(nativeRequests().length, 0);
			assert.equal(bankRequests().length, 1);
			assert.equal(bankRequests()[0].body.title, '[公式]');
			assert.equal(bankRequests()[0].body.options, ' [公式] \n [公式] ');
			assert.equal(bankRequests()[0].body.images, '');
			assert.equal(bankRequests()[0].body.suggestion_title, '');
		} finally {
			page.cleanup();
		}
	});
	await test('traditional whitespace-metadata fallback semantics stay unchanged', async () => {
		const page = await query(formula(0, ' ', '\\\\alpha+1'), ['甲', '乙'], [bank()]);
		try {
			assert.equal(bankRequests()[0].body.title, '[公式]');
		} finally {
			page.cleanup();
		}
	});
	await test('advanced participants receive the same recovered formula image mapping', async () => {
		const first = native('first').ai!;
		const wrapper: AnswererWrapper = {
			name: 'advanced',
			url: '',
			method: 'post',
			type: 'GM_xmlhttpRequest',
			headers: {},
			handler: '',
			aiEnsemble: { models: [first, { ...first, model: 'second' }], rule: 'confidence', threshold: 100 }
		};
		const page = await query(formula(0), [formula(1), formula(2)], [wrapper]);
		try {
			assert.equal(nativeRequests().length, 2);
			assert.deepEqual(nativeRequests()[0].payload, nativeRequests()[1].payload);
			assert.equal(page.infos[0].ensemble.status, 'agreed');
			assert.equal((await page.resolve()).finish, true);
			assert.equal(page.root.querySelectorAll('input')[1].checked, true);
		} finally {
			page.cleanup();
		}
	});
	await test('mixed native and bank payloads stay isolated and results retain configured order', async () => {
		delays = {
			'https://ykt-compat.invalid/bank/bank-one': 15,
			'https://ykt-compat.invalid/bank/bank-two': 1,
			'native-one': 25
		};
		const page = await query(
			formula(0),
			[formula(1), formula(2)],
			[bank('bank-one'), native('native-one'), bank('bank-two'), native('native-two')]
		);
		try {
			assert.equal(requests.length, 4);
			for (const request of bankRequests()) {
				assert.equal(request.body.title, '[公式]');
				assert.equal(request.body.options, ' [公式] \n [公式] ');
				assert.equal(request.body.images, '');
			}
			for (const request of nativeRequests()) {
				assert.equal(request.body.messages[1].content.filter((part: any) => part.type === 'image_url').length, 3);
				assert.deepEqual(request.payload.question_image_refs, ['[图片1]']);
				assert.deepEqual(
					request.payload.option_items.map((item: any) => item.image_refs),
					[['[图片2]'], ['[图片3]']]
				);
			}
			assert.deepEqual(
				page.infos.map((info: any) => info.name),
				['bank-one', 'native-one', 'bank-two', 'native-two']
			);
		} finally {
			page.cleanup();
		}
	});
	console.log('Plus YKT AI compatibility: ' + checks + ' production factory scenarios passed.');
}
main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		runtime.GM_xmlhttpRequest = previous.request;
		runtime.GM_getValue = previous.get;
		$.sleep = previous.sleep;
		CommonProject.scripts.settings.cfg.imageOptimize = previous.optimize;
		AnswerWrapperHandlerConfig.timeout_seconds = previous.timeout;
		builtHandlerConfig.timeout_seconds = previous.builtTimeout;
	});
