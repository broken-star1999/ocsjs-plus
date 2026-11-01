import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { $ } from 'easy-us';
import { OCSWorker } from '../packages/core/src/core/worker/worker';
import { enableSingleQuestionRetry } from '../packages/core/src/core/worker/single-question-retry';
import type { WorkContext, WorkResult } from '../packages/core/src/core/worker/interface';
import { StringUtils } from '../packages/core/src/utils/string';
import { createCXQuestionRetryAdapter } from '../packages/scripts/src/utils/cx-question-retry';
import { createCommonAnswerer, extractTextWithImages, removeRedundantWords } from '../packages/scripts/src/utils/work';
import { CommonProject } from '../packages/scripts/src/projects/common';
import { decryptElements } from '../packages/scripts/src/utils/font-decrypt/bitmap';

// Intentionally mix source core/retry with the scripts package's compiled @ocsjs/core import.
// The preparation handshake belongs to the local context, not a module-specific registry.
const runtime = globalThis as any;
const oldRequest = runtime.GM_xmlhttpRequest;
const oldOptimize = CommonProject.scripts.settings.cfg.imageOptimize;
const oldSleep = $.sleep;
$.sleep = async () => {};
CommonProject.scripts.settings.cfg.imageOptimize = false;
let requests: string[] = [];
let checks = 0;
const responseCounts = new Map<string, number>();
runtime.GM_xmlhttpRequest = (request: any) => {
	assert.equal(request.url, 'https://retry-prepare.invalid/v1/chat/completions');
	const body = JSON.parse(request.data);
	const question = JSON.parse(body.messages[1].content).question;
	requests.push(question);
	const count = (responseCounts.get(question) || 0) + 1;
	responseCounts.set(question, count);
	request.onload({
		status: 200,
		responseText: JSON.stringify({
			choices: [
				{
					finish_reason: 'stop',
					message: { content: JSON.stringify({ answers: [count === 1 ? 'A' : 'B'], uncertain: false }) }
				}
			]
		})
	});
};

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => (resolve = done));
	return { promise, resolve };
}

function fixture(options?: {
	count?: number;
	encrypted?: boolean;
	beforeSearch?: (ctx: WorkContext<any>, host: HTMLElement) => void | Promise<void>;
}) {
	const host = document.createElement('main');
	document.body.append(host);
	const roots: HTMLElement[] = [];
	for (let index = 0; index < (options?.count ?? 1); index++) {
		const root = document.createElement('section');
		root.innerHTML = `<h3 class="title${options?.encrypted ? ' font-cxsecret' : ''}">${
			options?.encrypted ? '甲' : '普通'
		}题干${index}</h3><input type="hidden" value="0"><div class="option">第一项</div><div class="option">第二项</div>`;
		for (const option of Array.from(root.querySelectorAll<HTMLElement>('.option'))) {
			option.onclick = () => {
				root.querySelectorAll('.option').forEach((other) => other.classList.remove('active'));
				option.classList.add('active');
			};
		}
		host.append(root);
		roots.push(root);
	}
	const type = (ctx: WorkContext<any>) =>
		ctx.root.querySelector<HTMLInputElement>('input[type="hidden"]')?.value === '1' ? 'multiple' : 'single';
	const adapter = createCXQuestionRetryAdapter<any>({
		layout: 'practice',
		type,
		optionText: (option) => option.textContent || ''
	});
	const worker = new OCSWorker<any>({
		root: roots,
		elements: { title: '.title', options: '.option', type: 'input[type="hidden"]' },
		thread: 1,
		answerer: createCommonAnswerer({
			period: 0,
			answererWrappers: [
				{
					name: 'Offline preparation',
					url: '',
					method: 'post',
					type: 'GM_xmlhttpRequest',
					headers: {},
					handler: '',
					ai: { endpoint: 'https://retry-prepare.invalid/v1', model: 'fixture', authMode: 'none', vision: false }
				}
			],
			beforeSearch: options?.beforeSearch ? (ctx) => options.beforeSearch!(ctx, host) : undefined,
			titleTransform: (elements) => extractTextWithImages(elements.title[0])
		}),
		work: { type, optionText: adapter.optionText, handler: (_kind, _answer, option) => option.click() }
	});
	enableSingleQuestionRetry(worker, adapter);
	return {
		worker,
		host,
		roots,
		run: () => worker.doWork(),
		close() {
			worker.emit('close');
			host.remove();
		}
	};
}

function decryptPage(_ctx: WorkContext<any>, host: HTMLElement) {
	for (const title of Array.from(host.querySelectorAll('.font-cxsecret'))) {
		const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		while (walker.nextNode()) nodes.push(walker.currentNode as Text);
		for (const node of nodes) node.nodeValue = node.nodeValue!.replace(/甲/g, '乙');
		title.classList.remove('font-cxsecret');
	}
}

async function test(name: string, run: () => Promise<void>) {
	requests = [];
	responseCounts.clear();
	const originalHash = document.location.hash;
	try {
		await run();
		checks++;
		console.log('PASS ' + name);
	} finally {
		document.location.hash = originalHash;
	}
}

async function main() {
	await test('one full-page decryption prepares all questions and each question can be retried', async () => {
		const f = fixture({ count: 2, encrypted: true, beforeSearch: decryptPage });
		try {
			const results = await f.run();
			assert.equal(results.length, 2);
			assert.ok(
				results.every((result) => result.result?.finish),
				JSON.stringify(
					results.map((result) => ({ error: result.error, result: result.result, infos: result.ctx?.searchInfos }))
				)
			);
			assert.deepEqual(requests, ['乙题干0', '乙题干1']);
			for (const result of results) await result.retry!();
			assert.deepEqual(requests, ['乙题干0', '乙题干1', '乙题干0', '乙题干1']);
			assert.ok(f.roots.every((root) => root.querySelector('.option.active')?.textContent === '第二项'));
		} finally {
			f.close();
		}
	});
	for (const change of ['text', 'image', 'option', 'type', 'url'] as const) {
		await test(`a real ${change} change after preparation still rejects retry before a request`, async () => {
			const f = fixture({ encrypted: true, beforeSearch: decryptPage });
			try {
				const [result] = await f.run();
				assert.equal(result.result?.finish, true);
				if (change === 'text') f.roots[0].querySelector('.title')!.textContent = '真正换题';
				if (change === 'image') {
					const image = document.createElement('img');
					image.src = 'https://fixture.invalid/new.png';
					f.roots[0].querySelector('.title')!.append(image);
				}
				if (change === 'option') {
					const replacement = document.createElement('div');
					replacement.className = 'option';
					replacement.textContent = '第一项';
					f.roots[0].querySelector('.option')!.replaceWith(replacement);
				}
				if (change === 'type') f.roots[0].querySelector<HTMLInputElement>('input')!.value = '1';
				if (change === 'url') document.location.hash = '#different-question';
				await assert.rejects(result.retry!(), /变化/);
				assert.equal(requests.length, 1);
			} finally {
				f.close();
			}
		});
	}
	for (const change of ['image', 'option', 'type', 'url', 'close'] as const) {
		await test(`a ${change} change during the first async preparation is rejected before the model call`, async () => {
			const entered = deferred();
			const resume = deferred();
			const f = fixture({
				encrypted: true,
				beforeSearch: async (ctx, host) => {
					entered.resolve();
					await resume.promise;
					decryptPage(ctx, host);
				}
			});
			try {
				const task = f.run();
				await entered.promise;
				if (change === 'image')
					f.roots[0].querySelector('.title')!.innerHTML += '<img src="https://fixture.invalid/new.png">';
				if (change === 'option') f.roots[0].querySelector('.option')!.remove();
				if (change === 'type') f.roots[0].querySelector<HTMLInputElement>('input')!.value = '1';
				if (change === 'url') document.location.hash = '#during-preparation';
				if (change === 'close') f.worker.emit('close');
				resume.resolve();
				const [result] = await task;
				if (change === 'close') {
					assert.equal(f.worker.isClose, true);
					assert.equal(result.requested, false);
					assert.notEqual(result.result?.finish, true);
				} else {
					assert.match(
						result.error || '',
						/变化|失效|关闭/,
						JSON.stringify({
							change,
							error: result.error,
							result: result.result,
							requested: result.requested,
							requests
						})
					);
				}
				assert.equal(requests.length, 0);
			} finally {
				resume.resolve();
				f.close();
			}
		});
	}
	await test('a failing first guard remains a per-question failure and unchanged content can retry', async () => {
		let failFirst = true;
		const f = fixture({
			count: 2,
			beforeSearch: (ctx) => {
				if (failFirst && ctx.root === f.roots[0]) throw new Error('font fixture unavailable');
			}
		});
		try {
			const results = await f.run();
			assert.match(results[0].error || '', /font fixture unavailable/);
			assert.equal(results[1].result?.finish, true);
			assert.deepEqual(requests, ['普通题干1']);
			failFirst = false;
			await results[0].retry!();
			assert.equal(results[0].result?.finish, true);
			assert.deepEqual(requests, ['普通题干1', '普通题干0']);
		} finally {
			f.close();
		}
	});
	await test('a guard that changes text and then fails never blesses the changed baseline', async () => {
		const f = fixture({
			encrypted: true,
			beforeSearch: (ctx, host) => {
				decryptPage(ctx, host);
				throw new Error('failed after partial decryption');
			}
		});
		try {
			const [result] = await f.run();
			assert.match(result.error || '', /failed after partial decryption/);
			await assert.rejects(result.retry!(), /变化/);
			assert.equal(requests.length, 0);
		} finally {
			f.close();
		}
	});
	await test('retry clones and repeated preparation calls cannot reset the accepted question signature', async () => {
		const f = fixture({ encrypted: true, beforeSearch: decryptPage });
		try {
			const [result] = await f.run();
			const clone = { ...result.ctx!, forceSearch: true };
			await clone.prepareForRetry!(() => {
				f.roots[0].querySelector('.title')!.textContent = '真正换题';
			});
			await assert.rejects(result.retry!(), /变化/);
			assert.equal(requests.length, 1);
		} finally {
			f.close();
		}
	});
	await test('a later preparation call cannot bless text changed after the initial accepted preparation', async () => {
		const f = fixture({ encrypted: true, beforeSearch: decryptPage });
		try {
			const [result] = await f.run();
			await assert.rejects(
				result.ctx!.prepareForRetry!(() => {
					f.roots[0].querySelector('.title')!.textContent = '真正换题';
				}),
				/变化/
			);
			await assert.rejects(result.retry!(), /变化/);
			assert.equal(requests.length, 1);
		} finally {
			f.close();
		}
	});
	await test('answerers without preprocessing retain ordinary retry behavior', async () => {
		const f = fixture();
		try {
			const [result] = await f.run();
			await result.retry!();
			assert.equal(result.result?.finish, true);
			assert.equal(requests.length, 2);
		} finally {
			f.close();
		}
	});
	await test('the actual encrypted mobilelearn factory can fill and retry the same question', async () => {
		const filename = path.resolve(__dirname, '../packages/scripts/src/projects/cx.ts');
		const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
		const declaration = (name: string) => {
			const node = source.statements.find(
				(statement): statement is ts.FunctionDeclaration =>
					ts.isFunctionDeclaration(statement) && statement.name?.text === name
			);
			assert.ok(node, `production factory remains available: ${name}`);
			return node.getText(source);
		};
		const analyses = source.statements
			.filter(ts.isVariableStatement)
			.flatMap((statement) => [...statement.declarationList.declarations])
			.find((statement) => statement.name.getText(source) === 'CXAnalyses')?.initializer;
		assert.ok(analyses && ts.isObjectLiteralExpression(analyses));
		const getSecretFont = analyses.properties.find((member) => member.name?.getText(source) === 'getSecretFont');
		assert.ok(getSecretFont);
		class CapturingWorker extends OCSWorker<any> {
			auditResults: WorkResult<any>[] = [];
			async doWork(options?: Parameters<OCSWorker<any>['doWork']>[0]) {
				this.auditResults = await super.doWork(options);
				return this.auditResults;
			}
		}
		const noop = () => {};
		const code = `const CXAnalyses={${getSecretFont.getText(source)}};
			let cxFontCrackFailed=false, cxFontCrackJob, cxFontMap={'甲':'乙'};
			async function crackCxFontOnce(){throw new Error('Cached font fixture must not access a font service')}
			${declaration('ensureCxFontDecrypted')}
			${declaration('mobilelearn')}
			mobilelearn;`;
		const factory = vm.runInNewContext(
			ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } })
				.outputText,
			{
				document,
				OCSWorker: CapturingWorker,
				$,
				StringUtils,
				$message: { info: noop, error: noop },
				CommonProject: {
					scripts: { workResults: { methods: { init: noop, fillAll: async () => {}, update: async () => {} } } }
				},
				BackgroundProject: { scripts: { dev: { cfg: { enable_answerer_debug: false } } } },
				removeRedundantWords,
				extractTextWithImages,
				createCommonAnswerer,
				simplifyWorkResult: () => ({}),
				enableSingleQuestionRetry,
				createCXQuestionRetryAdapter,
				decryptElements
			}
		);
		const originalInnerText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
		Object.defineProperty(HTMLElement.prototype, 'innerText', {
			configurable: true,
			get() {
				return this.textContent;
			}
		});
		const root = document.createElement('section');
		root.className = 'question-item single-choice';
		root.innerHTML =
			'<div class="question-name"><div class="html-content-box font-cxsecret">甲题</div></div><div class="option-result">选项一</div><div class="option-result">选项二</div>';
		document.body.append(root);
		for (const option of Array.from(root.querySelectorAll<HTMLElement>('.option-result')))
			option.onclick = () => {
				root.querySelectorAll('.option-result').forEach((item) => item.classList.remove('active'));
				option.classList.add('active');
			};
		let worker: CapturingWorker | undefined;
		try {
			worker = factory({
				thread: 1,
				period: 0,
				redundanceWordsText: '',
				answerSeparators: '#',
				answererWrappers: [
					{
						name: 'Offline mobilelearn',
						url: '',
						method: 'post',
						type: 'GM_xmlhttpRequest',
						headers: {},
						handler: '',
						ai: { endpoint: 'https://retry-prepare.invalid/v1', model: 'fixture', authMode: 'none', vision: false }
					}
				]
			});
			await new Promise<void>((resolve, reject) => {
				worker!.once('done', resolve);
				setTimeout(() => reject(new Error('Mobilelearn fixture timed out')), 3000).unref();
			});
			const result = worker!.auditResults[0];
			assert.equal(result.result?.finish, true);
			assert.equal(root.querySelector('.html-content-box')!.textContent, '乙题');
			assert.equal(root.querySelector('.option-result.active')!.textContent, '选项一');
			await result.retry!();
			assert.equal(result.result?.finish, true);
			assert.equal(root.querySelector('.option-result.active')!.textContent, '选项二');
			assert.deepEqual(requests, ['乙题', '乙题']);
		} finally {
			worker?.emit('close');
			root.remove();
			if (originalInnerText) Object.defineProperty(HTMLElement.prototype, 'innerText', originalInnerText);
			else delete (HTMLElement.prototype as any).innerText;
		}
	});
	console.log(`Retry/decryption compatibility: ${checks} production scenarios passed.`);
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		$.sleep = oldSleep;
		CommonProject.scripts.settings.cfg.imageOptimize = oldOptimize;
		runtime.GM_xmlhttpRequest = oldRequest;
	});
