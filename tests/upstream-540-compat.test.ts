import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { $, $$el } from 'easy-us';
import { StringUtils } from '../packages/core/src/utils/string';
import { createDefaultQuestionResolver } from '../packages/core/src/core/worker/question.resolver';
import { AnswerWrapperHandlerConfig as builtConfig } from '../packages/core';
import { AnswerWrapperHandlerConfig } from '../packages/core/src/core/answer-wrapper/answer.wrapper.handler';
import {
	createCommonAnswerer,
	extractTextWithImages,
	extractMathJaxText,
	removeRedundantWords
} from '../packages/scripts/src/utils/work';
import { extractYktAIContent } from '../packages/scripts/src/utils/ai-ykt-content';
import { CommonProject } from '../packages/scripts/src/projects/common';
import { OCSWorker } from '../packages/core/src/core/worker/worker';

function declaration(path: string, name: string) {
	const file = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
	for (const node of file.statements) {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) return node.getText(file).replace(/^export\s+/, '');
		if (ts.isVariableStatement(node)) {
			const value = node.declarationList.declarations.find((item) => item.name.getText(file) === name);
			if (value?.initializer) return `const ${name} = ${value.initializer.getText(file)};`;
		}
	}
	throw new Error('Missing production declaration ' + name);
}
const yktPath = 'packages/scripts/src/projects/yuketang.ts';
class CaptureWorker {
	constructor(public opts: any) {}
	doWork() {
		return Promise.resolve();
	}
	emit() {}
}
const noop = () => {};
const displayedTitles: string[] = [];
const deps = {
	OCSWorker: CaptureWorker,
	$,
	$$el,
	StringUtils,
	createCommonAnswerer,
	extractTextWithImages,
	extractYktAIContent,
	removeRedundantWords,
	createDefaultQuestionResolver,
	$message: { info: noop, error: noop },
	CommonProject: { scripts: { workResults: { methods: { init: noop, fillAll: noop, update: noop } } } },
	BackgroundProject: { scripts: { dev: { cfg: { enable_answerer_debug: false } } } },
	simplifyWorkResult: (value: any, transform: (titles: HTMLElement[]) => string) => {
		const question = transform(value.ctx?.elements.title || []);
		displayedTitles.push(question);
		return { question };
	},
	resolveJudgement: () => assert.fail('native judgement must use native provenance'),
	fillYktUEditor: noop,
	Event: window.Event
};
const factorySource = ts.transpileModule(
	['YKT_BLANK_INPUT_SELECTOR', 'cloneYktForTextExtract', 'extractYktTitleText', 'parseYktQuestionType', 'examination']
		.map((name) => declaration(yktPath, name))
		.join('\n') + '\nreturn examination;',
	{ compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }
).outputText;
const factory = new Function(...Object.keys(deps), factorySource)(...Object.values(deps));
const runtime = globalThis as any;
const old = {
	request: runtime.GM_xmlhttpRequest,
	sleep: $.sleep,
	optimize: CommonProject.scripts.settings.cfg.imageOptimize,
	timeout: AnswerWrapperHandlerConfig.timeout_seconds,
	builtTimeout: builtConfig.timeout_seconds
};
let payload: any;
let answer = ['B'];
let checks = 0;
let holdResponse = false;
let pendingReplies: (() => void)[] = [];
let requestCount = 0;
runtime.GM_xmlhttpRequest = (request: any) => {
	requestCount++;
	assert.equal(request.url, 'https://sync-540.invalid/v1/chat/completions');
	const body = JSON.parse(request.data);
	const content = body.messages[1].content;
	payload = JSON.parse(typeof content === 'string' ? content : content[0].text);
	const reply = () =>
		request.onload({
			status: 200,
			responseText: JSON.stringify({
				choices: [
					{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: answer, uncertain: false }) } }
				]
			})
		});
	if (holdResponse) pendingReplies.push(reply);
	else reply();
};
$.sleep = async () => {};
AnswerWrapperHandlerConfig.timeout_seconds = builtConfig.timeout_seconds = 0.2;
CommonProject.scripts.settings.cfg.imageOptimize = true;
const wrapper = {
	name: 'Offline new exam',
	method: 'post',
	type: 'GM_xmlhttpRequest',
	url: '',
	headers: {},
	handler: '',
	ai: { endpoint: 'https://sync-540.invalid/v1', model: 'fixture', authMode: 'none', vision: true }
};
async function test(name: string, run: () => any) {
	await run();
	checks++;
	console.log('PASS ' + name);
}
async function exam(type: string, options: string[], expected: string[], stem = '网页题干', blanks = 0) {
	answer = expected;
	const root = document.createElement('section');
	root.innerHTML =
		`<div class="item-type">${type}</div><h3>${stem}</h3>` +
		options.map((text) => `<label>${text}</label>`).join('') +
		'<input>'.repeat(blanks);
	const elements = {
		title: [root.querySelector('h3')],
		type: [root.querySelector('.item-type')],
		options: [...root.querySelectorAll('label')],
		textareas: [...root.querySelectorAll('input')]
	};
	const clicks: number[] = [];
	elements.options.forEach(
		(node, index) =>
			(node.onclick = () => {
				clicks.push(index);
			})
	);
	const worker = factory({
		answererWrappers: [wrapper],
		period: 0,
		thread: 1,
		answerSeparators: '#',
		redundanceWordsText: ''
	});
	const ctx: any = { root, elements, searchInfos: [], type: undefined };
	ctx.searchInfos = await worker.opts.answerer(elements, ctx);
	assert.equal(ctx.searchInfos[0].error, undefined);
	const result = await worker.opts.work(ctx);
	return { result, ctx, clicks, elements, payload, worker };
}
async function navigation(mode: string, finalTab: boolean) {
	const calls: string[] = [];
	const cxPath = 'packages/scripts/src/projects/cx.ts';
	const context: any = {
		top: { document, PCount: { next: () => calls.push('PCount.next') } },
		$gm: { unsafeWindow: { attachments: [] } },
		$: { sleep: async () => {} },
		$el: () => ({ value: 'fixture' }),
		$$el: () => [1],
		$store: { getTab: async () => ({}), setTab: async () => {} },
		CXProject: { scripts: { study: { cfg: { mode } } } },
		CXAnalyses: {
			isInFinalChapter: () => false,
			isStuckInBreakingMode: async () => false,
			isInFinalTab: () => finalTab,
			getChapterInfos: () => [
				{ unFinishCount: 0, element: { parentElement: { classList: { contains: () => true } } } },
				{
					unFinishCount: 1,
					element: { click: () => calls.push('chapterClick'), parentElement: { classList: { contains: () => false } } }
				}
			],
			scrollToActiveChapter: noop
		},
		searchJob: () => undefined,
		$message: { info: noop, success: noop, warn: noop },
		$msgwc: { info: noop },
		$console: { info: noop, warn: noop, error: noop },
		$modal: { alert: noop },
		setTimeout: (fn: () => void) => {
			fn();
			return 1;
		},
		clearTimeout: noop
	};
	vm.runInNewContext(
		ts.transpileModule(declaration(cxPath, 'study') + '\nglobalThis.run = study;', {
			compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
		}).outputText,
		context
	);
	await context.run({ backToFirstWhenFinish: false });
	return calls;
}
class LifecycleWorker extends OCSWorker<any> {
	auditResults: any[] = [];
	auditTask!: ReturnType<OCSWorker<any>['doWork']>;
	doWork(options?: Parameters<OCSWorker<any>['doWork']>[0]) {
		const update = this.opts.onResultsUpdate;
		this.opts.onResultsUpdate = async (current, index, results) => {
			this.auditResults = results;
			await update?.(current, index, results);
		};
		return (this.auditTask = super.doWork(options));
	}
}
const lifecycleFactory = new Function(...Object.keys(deps), factorySource)(
	...Object.values({ ...deps, OCSWorker: LifecycleWorker })
);
async function until(predicate: () => unknown) {
	const end = Date.now() + 2500;
	while (!predicate()) {
		if (Date.now() > end) throw new Error('Lifecycle fixture timed out');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
function lifecycle(type = '单选题', wrappers: any[] = [wrapper]) {
	const host = document.createElement('section');
	host.className = 'exam-main--content';
	host.innerHTML = `<section class="subject-item"><div class="item-type">${type}</div><div class="clearfix exam-font"><div class="custom_ueditor_cn_body">完整任务题干</div></div><ul class="list-unstyled"><li><div class="custom_ueditor_cn_body">B</div></li><li><div class="custom_ueditor_cn_body">正确选项</div></li></ul></section>`;
	document.body.append(host);
	const clicks: number[] = [];
	host.querySelectorAll<HTMLElement>('li .custom_ueditor_cn_body').forEach(
		(node, index) =>
			(node.onclick = () => {
				clicks.push(index);
			})
	);
	answer = ['B'];
	const worker: LifecycleWorker = lifecycleFactory({
		answererWrappers: wrappers,
		period: 0,
		thread: 1,
		answerSeparators: '#',
		redundanceWordsText: ''
	});
	return {
		worker,
		clicks,
		cleanup: () => {
			worker.emit('close');
			host.remove();
			holdResponse = false;
			pendingReplies = [];
		}
	};
}
async function main() {
	await test('new YKT exam full worker fills the DOM-selected B and finishes its actual task', async () => {
		const page = lifecycle();
		try {
			const results = await page.worker.auditTask;
			assert.equal(results[0].result?.finish, true);
			assert.deepEqual(page.clicks, [1]);
		} finally {
			page.cleanup();
		}
	});
	await test('new YKT exam pauses a returned answer until continued', async () => {
		holdResponse = true;
		const page = lifecycle();
		try {
			await until(() => pendingReplies.length === 1);
			page.worker.emit('stop');
			pendingReplies.shift()!();
			await until(() => page.worker.auditResults[0]?.requested);
			assert.deepEqual(page.clicks, []);
			page.worker.emit('continuate');
			await page.worker.auditTask;
			assert.deepEqual(page.clicks, [1]);
		} finally {
			page.cleanup();
		}
	});
	await test('new YKT exam closing in-flight prevents late DOM writes', async () => {
		holdResponse = true;
		const page = lifecycle();
		try {
			await until(() => pendingReplies.length === 1);
			page.worker.emit('close');
			pendingReplies.shift()!();
			await page.worker.auditTask;
			assert.deepEqual(page.clicks, []);
		} finally {
			page.cleanup();
		}
	});
	await test('new YKT exam manual ensemble waits for confirmation and never auto-clicks', async () => {
		const page = lifecycle('单选题', [
			{
				...wrapper,
				ai: undefined,
				aiEnsemble: {
					models: [wrapper.ai, { ...wrapper.ai, model: 'second-fixture' }],
					rule: 'manual',
					threshold: 100
				}
			}
		]);
		try {
			await until(() => !!page.worker.auditResults[0]?.confirmReview);
			assert.deepEqual(page.clicks, []);
			assert.equal(page.worker.isRunning, true);
			await page.worker.auditResults[0].confirmReview();
			const results = await page.worker.auditTask;
			assert.equal(results[0].result?.manual, true);
			assert.deepEqual(page.clicks, []);
		} finally {
			page.cleanup();
		}
	});
	await test('new YKT exam unknown page type never guesses a native choice', async () => {
		const before = requestCount;
		const page = lifecycle('未标注题型');
		try {
			const results = await page.worker.auditTask;
			assert.equal(results[0].result?.finish, false);
			assert.deepEqual(page.clicks, []);
			assert.equal(requestCount, before + 1);
			assert.equal(payload.type, 'unknown');
		} finally {
			page.cleanup();
		}
	});
	await test('upstream MOOC configuration migration preserves new values and is idempotent', () => {
		const path = 'packages/scripts/src/utils/config-migrate.ts';
		const values = new Map<string, any>([
			['icourse.study-v1.volume', 0],
			['icourse.study-v2.playbackRate', 2],
			['icourse.study.playbackRate', 1.5],
			['common.settings.aiEnabled', true]
		]);
		const context: any = {
			$store: {
				list: () => [...values.keys()],
				get: (key: string) => values.get(key),
				set: (key: string, value: any) => values.set(key, value),
				delete: (key: string) => values.delete(key)
			}
		};
		vm.runInNewContext(
			ts.transpileModule(
				['legacyIcourseStudyNamespaces', 'icourseStudyNamespace', 'migrateNamespace', 'migrateIcourseStudyConfigs']
					.map((name) => declaration(path, name))
					.join('\n') + '\nglobalThis.run = migrateIcourseStudyConfigs;',
				{ compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }
			).outputText,
			context
		);
		context.run();
		context.run();
		assert.deepEqual(
			[...values],
			[
				['icourse.study.playbackRate', 1.5],
				['common.settings.aiEnabled', true],
				['icourse.study.volume', 0]
			]
		);
	});
	await test('new ZHS formula option transforms retain per-option images for AI and upstream bank text', () => {
		const path = 'packages/scripts/src/projects/zhs.ts';
		for (const name of ['fusioncourseWork', 'hikeHomework']) {
			const file = ts.createSourceFile(path, declaration(path, name), ts.ScriptTarget.Latest, true);
			let transform = '';
			const visit = (node: ts.Node) => {
				if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'optionsTransform')
					transform = node.initializer.getText(file);
				ts.forEachChild(node, visit);
			};
			visit(file);
			assert.ok(transform);
			const create = new Function(
				'extractTextWithImages',
				'answererWrappers',
				ts.transpileModule('return ' + transform, {
					compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
				}).outputText
			);
			const options = [
				'<img src="https://image.invalid/one.png"><img src="https://image.invalid/two.png">',
				'文本'
			].map((html) => {
				const node = document.createElement('label');
				node.innerHTML = html;
				return node;
			});
			const ai = create(extractTextWithImages, [wrapper])({ options });
			assert.deepEqual(
				ai.items.map((item: any) => item.images.length),
				[2, 0]
			);
			const bank = create(extractTextWithImages, [{}])({ options });
			assert.equal(bank, ai.text);
		}
	});
	await test('new YKT exam sends page single type and fills B even when option A text is B', async () => {
		const value = await exam('单选题', ['B', '正确内容'], ['B']);
		assert.equal(value.payload.type, 'single');
		assert.deepEqual(value.clicks, [1]);
		assert.equal(value.result.finish, true);
	});
	await test('new YKT exam multiple answers retain native letter priority', async () => {
		const value = await exam('多选题', ['B', 'A', 'C'], ['AC']);
		assert.equal(value.payload.type, 'multiple');
		assert.deepEqual(value.clicks, [0, 2]);
	});
	await test('new YKT exam judgement does not enter the traditional text-only matcher', async () => {
		const value = await exam('判断题', ['对', '错'], ['错']);
		assert.equal(value.payload.type, 'judgement');
		assert.deepEqual(value.clicks, [1]);
	});
	await test('new YKT exam completion uses one actual input for two illustrative underscores', async () => {
		const value = await exam('填空题', [], ['26'], 'range(__,-4,-2) 初值为__', 1);
		assert.equal(value.payload.type, 'completion');
		assert.equal(value.payload.blank_count, 1);
		assert.equal(value.elements.textareas[0].value, '26');
		assert.equal(value.result.finish, true);
	});
	await test('new YKT exam preserves a pure formula-image stem using its LaTeX', async () => {
		const value = await exam('单选题', ['一', '二'], ['A'], '<img class="kfformula" data-latex="x^2=1">');
		assert.match(value.payload.question, /x\^2=1/);
		assert.equal(value.result.finish, true);
		displayedTitles.length = 0;
		await value.worker.opts.onResultsInit(undefined, 0, [{ ctx: value.ctx }]);
		await value.worker.opts.onResultsUpdate({ ctx: value.ctx }, 0, []);
		assert.equal(displayedTitles.length, 2);
		assert.ok(displayedTitles.every((title) => title.includes('x^2=1')));
	});
	await test('new YKT exam retains multiple images in the stem and the same option', async () => {
		const png = (index: number) => {
			const bytes = Buffer.alloc(26);
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
			bytes.writeUInt32BE(20 + index, 16);
			bytes.writeUInt32BE(20, 20);
			bytes[24] = 8;
			bytes[25] = 6;
			return `<img src="data:image/png;base64,${bytes.toString('base64')}">`;
		};
		const value = await exam('单选题', [png(3) + png(4), png(5)], ['B'], png(1) + png(2));
		assert.deepEqual(value.payload.question_image_refs, ['[图片1]', '[图片2]']);
		assert.deepEqual(
			value.payload.option_items.map((item: any) => item.image_refs),
			[['[图片3]', '[图片4]'], ['[图片5]']]
		);
		assert.deepEqual(value.clicks, [1]);
	});
	await test('upstream smart final-tab navigation no longer invokes two navigation mechanisms', async () => {
		assert.deepEqual(await navigation('job', true), ['chapterClick']);
	});
	await test('upstream smart non-final-tab and sequential modes retain PCount navigation', async () => {
		assert.deepEqual(await navigation('job', false), ['PCount.next']);
		assert.deepEqual(await navigation('all', true), ['PCount.next']);
	});
	await test('upstream MathJax text extraction preserves fraction and sign in shared extractor', () => {
		const node = document.createElement('section');
		node.innerHTML =
			'<mjx-container><svg><g data-mml-node="math"><g data-mml-node="mfrac"><g data-mml-node="mn"><path data-c="32"></path></g><g data-mml-node="mn"><path data-c="37"></path></g></g><g data-mml-node="mo"><path data-c="2212"></path></g><g data-mml-node="mi"><path data-c="78"></path></g></g></svg></mjx-container>';
		assert.equal(extractMathJaxText(node.firstElementChild!), '(2)/(7)-x');
		assert.equal(extractTextWithImages(node).text.trim(), '(2)/(7)-x');
	});
	console.log(`Upstream 5.4.0 / Plus integration: ${checks} scenarios passed (offline).`);
}
main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		runtime.GM_xmlhttpRequest = old.request;
		$.sleep = old.sleep;
		CommonProject.scripts.settings.cfg.imageOptimize = old.optimize;
		AnswerWrapperHandlerConfig.timeout_seconds = old.timeout;
		builtConfig.timeout_seconds = old.builtTimeout;
	});
