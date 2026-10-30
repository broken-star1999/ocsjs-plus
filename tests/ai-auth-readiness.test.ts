import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { $modal } from 'easy-us';
import { CommonProject } from '../packages/scripts/src/projects/common';
import { inspectAIWorkConfiguration } from '../packages/scripts/src/utils/ai-work-status';
import { openAIProviderManager } from '../packages/scripts/src/utils/ai-provider-manager';
import {
	AIProviderSource,
	AIProviderState,
	aiModelKey,
	createAIAnswererWrappers,
	migrateAIProviders
} from '../packages/core/src/core/answer-wrapper/ai-providers';
import { getAIKeyStorage, listAIModels, searchAIAnswer } from '../packages/core/src/core/answer-wrapper/ai';
import { searchAIEnsemble } from '../packages/core/src/core/answer-wrapper/ai-ensemble';

const runtime = globalThis as any;
const stored = new Map<string, unknown>();
let requests: any[] = [];
let checks = 0;
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const source = (id = 'first', authMode: 'api-key' | 'none' = 'api-key'): AIProviderSource => ({
	id,
	name: id,
	preset: 'openai',
	endpoint: 'https://auth-test.invalid/v1',
	authMode,
	timeoutSeconds: 10,
	catalog: [],
	models: [{ id: 'fixture', name: 'fixture', enabled: true, vision: false, extraBody: {} }]
});
const state = (...sources: AIProviderSource[]): AIProviderState => ({
	sources,
	selection: sources.length ? aiModelKey(sources[0].id, 'fixture') : ''
});
const key = (provider: AIProviderSource, value = 'offline-fixture-key') =>
	stored.set(getAIKeyStorage(provider.endpoint, provider.id), value);
const question = { title: '1 + 1?', type: 'single', option_count: 2, options: '2\n3' };
if (!Element.prototype.replaceChildren)
	Element.prototype.replaceChildren = function (...nodes: (Node | string)[]) {
		while (this.firstChild) this.removeChild(this.firstChild);
		for (const node of nodes) this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
	};

async function test(name: string, run: () => void | Promise<void>) {
	stored.clear();
	requests = [];
	await run();
	checks++;
	console.log('PASS ' + name);
}

function providerManagerFixture(initial: AIProviderState) {
	const originalModal = $modal.simple;
	const modals: HTMLElement[] = [];
	let current = clone(initial);
	let credentialsChanged = 0;
	let popup!: HTMLElement;
	($modal as any).simple = (options: any) => {
		popup = document.createElement('div');
		popup.append(options.content, options.footer);
		document.body.append(popup);
		modals.push(popup);
		return popup;
	};
	const open = () =>
		openAIProviderManager({
			read: () => current,
			write: (next) => {
				current = next;
			},
			onCredentialsChange: () => credentialsChanged++
		});
	open();
	return {
		read: () => current,
		root: () => popup,
		changed: () => credentialsChanged,
		open,
		async press(text: string) {
			const button = [...popup.querySelectorAll('button')].find((node) => node.textContent === text);
			assert.ok(button, 'provider button exists: ' + text);
			await button.onclick!(new MouseEvent('click'));
		},
		mode(value: 'api-key' | 'none') {
			const field = popup.querySelector<HTMLInputElement>('[role="switch"][aria-label="无需 API Key"]');
			assert.ok(field, 'provider no-key switch is accessible');
			field.checked = value === 'none';
			field.onchange!(new Event('change'));
		},
		typeKey(value: string) {
			const field = popup.querySelector<HTMLInputElement>('input[type="password"]')!;
			field.value = value;
			field.oninput!(new Event('input'));
		},
		cleanup() {
			$modal.simple = originalModal;
			modals.forEach((modal) => modal.remove());
		}
	};
}

/** Run the actual chapter dispatcher and study loop with local iframe DOM only. */
async function studyFixture(workOptions: any, mode: 'manually' | 'next' = 'manually') {
	const filename = path.resolve(__dirname, '../packages/scripts/src/projects/cx.ts');
	const text = fs.readFileSync(filename, 'utf8');
	const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
	const names = ['study', 'searchIFrame', 'searchJob'];
	const functions = ast.statements.filter(
		(node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || '')
	);
	assert.equal(functions.length, names.length, 'execute all original dispatcher functions');
	const declarations = functions.map((node) => node.getText(ast).replace(/^export\s+/, '')).join('\n');
	const compiled = ts.transpileModule(declarations, {
		compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
	}).outputText;
	const host = document.createElement('section');
	document.body.append(host);
	let chapters = 0;
	let videos = 0;
	let submits = 0;
	let nextCalls = 0;
	const messages: string[] = [];
	const opts = { mode, enableChapterTest: true, enableMedia: true, restudy: false, forceLearn: false };
	const attachments = ['quiz', 'video'].map((id) => ({
		jobid: id,
		job: true,
		property: { mid: id, name: id }
	}));
	for (const [index, attachment] of attachments.entries()) {
		const iframe = document.createElement('iframe');
		iframe.setAttribute('data', JSON.stringify({ jobid: attachment.jobid }));
		host.append(iframe);
		iframe.contentDocument!.body.innerHTML =
			index === 0 ? '<div class="TiMu">fixture quiz</div><button>submit</button>' : '<div id="video"></div>';
		if (index === 0) iframe.contentDocument!.querySelector('button')!.onclick = () => submits++;
	}
	const topDocument = document.implementation.createHTMLDocument('local navigation fixture');
	topDocument.body.innerHTML =
		'<input id="curCourseId" value="course"><input id="curChapterId" value="chapter">' +
		'<input id="curClazzId" value="class"><div id="prev_tab"><ul class="prev_ul"><li></li></ul></div>';
	const show = (input: any) => messages.push(typeof input === 'string' ? input : String(input.content));
	const context: any = {
		$gm: { unsafeWindow: { document: host, attachments } },
		$: { sleep: async () => {} },
		setTimeout: (callback: () => void) => callback(),
		CommonProject: {
			scripts: { settings: { cfg: { 'work-when-no-job': false }, methods: { getWorkOptions: () => workOptions } } }
		},
		CXProject: { scripts: { study: { cfg: opts } } },
		inspectAIWorkConfiguration,
		$message: { info: show, warn: show, success: show },
		$console: { log: () => {}, info: () => {}, warn: () => {}, error: (...args: any[]) => assert.fail(String(args)) },
		$modal: { alert: () => assert.fail('ordinary local fixture must not alert') },
		top: { document: topDocument, PCount: { next: () => nextCalls++ } },
		$el: (selector: string, root: Document) => root.querySelector(selector),
		$$el: (selector: string, root: Document) => [...root.querySelectorAll(selector)],
		CXAnalyses: {
			isInFinalTab: () => false,
			isInFinalChapter: () => false,
			scrollToActiveChapter: () => {}
		},
		domSearch: (selectors: Record<string, string>, root: Document) =>
			Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name, root.querySelector(selector)])),
		JobRunner: {
			chapter: async () => {
				chapters++;
			},
			media: async (_options: unknown, root: Document) => {
				assert.ok(root.querySelector('#video'));
				videos++;
			}
		}
	};
	try {
		vm.runInNewContext(compiled + '\nthis.runStudy = study;', context, { filename });
		await context.runStudy(opts);
		// study() initiates next() without awaiting it; let its awaited sleep settle.
		await Promise.resolve();
		await Promise.resolve();
		return { chapters, videos, submits, nextCalls, messages };
	} finally {
		host.remove();
	}
}

async function main() {
	runtime.GM_getValue = (storage: string, fallback: unknown) => (stored.has(storage) ? stored.get(storage) : fallback);
	runtime.GM_setValue = (storage: string, value: unknown) => stored.set(storage, value);
	runtime.GM_deleteValue = (storage: string) => stored.delete(storage);
	runtime.GM_listValues = () => [...stored.keys()];
	runtime.GM_xmlhttpRequest = (request: any) => {
		requests.push(request);
		request.onload({
			status: 200,
			responseText: JSON.stringify(
				request.method === 'GET'
					? { data: [{ id: 'fixture' }] }
					: { choices: [{ finish_reason: 'stop', message: { content: '{"answers":["A"],"uncertain":false}' } }] }
			)
		});
	};
	await test('fresh default AI without a selected model skips its quiz and continues the later video', async () => {
		const migrated = migrateAIProviders({ endpoint: 'https://api.deepseek.com', model: '', vision: false, models: [] });
		const wrappers = createAIAnswererWrappers(migrated);
		assert.equal(CommonProject.scripts.settings.configs.aiEnabled.defaultValue, true);
		assert.equal(wrappers.length, 0);
		const result = await studyFixture({ aiEnabled: true, answererWrappers: wrappers });
		assert.deepEqual([result.chapters, result.videos, result.submits, requests.length], [0, 1, 0, 0]);
		assert.equal(result.messages.filter((message) => /普通模式模型|高级模式配置/.test(message)).length, 1);
	});
	await test('a selected key-required model without a key takes the original skipped-quiz path', async () => {
		const wrappers = createAIAnswererWrappers(state(source()));
		const readiness = inspectAIWorkConfiguration({ aiEnabled: true, answererWrappers: wrappers });
		assert.equal(readiness.ready, false);
		assert.match(readiness.error, /Key|密钥/);
		const result = await studyFixture({ aiEnabled: true, answererWrappers: wrappers });
		assert.deepEqual([result.chapters, result.videos, result.submits, requests.length], [0, 1, 0, 0]);
		assert.equal(result.messages.filter((message) => /Key|密钥/.test(message)).length, 1);
	});
	await test('skipping an unconfigured quiz preserves the configured next-section attempt after the video', async () => {
		const result = await studyFixture({ aiEnabled: true, answererWrappers: [] }, 'next');
		assert.deepEqual(
			[result.chapters, result.videos, result.submits, result.nextCalls, requests.length],
			[0, 1, 0, 1, 0]
		);
	});
	await test('a whitespace key and another source key do not satisfy the selected provider', () => {
		const first = source();
		const second = source('second');
		key(first, ' \n\t ');
		key(second);
		const result = inspectAIWorkConfiguration({ answererWrappers: createAIAnswererWrappers(state(first, second)) });
		assert.equal(result.ready, false);
		assert.match(result.error, /Key|密钥/);
		assert.equal(requests.length, 0);
	});
	await test('a scoped saved key permits normal model inference without entering result metadata', async () => {
		const provider = source();
		key(provider);
		const wrappers = createAIAnswererWrappers(state(provider));
		assert.equal(inspectAIWorkConfiguration({ answererWrappers: wrappers }).ready, true);
		const info = await searchAIAnswer(wrappers[0].ai!, question, 1000);
		assert.equal(info.results[0].answer, 'A');
		assert.equal(requests.length, 1);
		assert.equal(requests[0].headers.Authorization, 'Bearer offline-fixture-key');
		assert.ok(!JSON.stringify(wrappers).includes('offline-fixture-key'));
		assert.ok(!JSON.stringify(info).includes('offline-fixture-key'));
	});
	await test('a key removed after readiness is blocked again before any inference request', async () => {
		const provider = source();
		key(provider);
		const wrappers = createAIAnswererWrappers(state(provider));
		assert.equal(inspectAIWorkConfiguration({ answererWrappers: wrappers }).ready, true);
		stored.clear();
		const info = await searchAIAnswer(wrappers[0].ai!, question, 1000);
		assert.equal(info.results.length, 0);
		assert.match(info.error || '', /Key|密钥/);
		assert.equal(requests.length, 0);
	});
	await test('explicit unauthenticated custom endpoints support discovery and inference with an empty key', async () => {
		const provider = source('local', 'none');
		provider.endpoint = 'http://127.0.0.1:1234/v1';
		const wrappers = createAIAnswererWrappers(state(provider));
		assert.equal(inspectAIWorkConfiguration({ answererWrappers: wrappers }).ready, true);
		assert.equal((await listAIModels(provider.endpoint, provider.id, provider.authMode))[0].id, 'fixture');
		const info = await searchAIAnswer(wrappers[0].ai!, question, 1000);
		assert.equal(info.results[0].answer, 'A');
		assert.equal(requests.length, 2);
		assert.ok(requests.every((request) => request.headers.Authorization === undefined));
		const run = await studyFixture({ aiEnabled: true, answererWrappers: wrappers });
		assert.deepEqual([run.chapters, run.videos], [1, 1]);
	});
	await test('advanced mode with one missing participant key skips before starting any member', async () => {
		const first = source();
		const second = source('second');
		key(first);
		const wrappers = createAIAnswererWrappers(state(first, second), true, [
			{ key: aiModelKey(first.id, 'fixture'), threads: 1 },
			{ key: aiModelKey(second.id, 'fixture'), threads: 1 }
		]);
		assert.equal(inspectAIWorkConfiguration({ answererWrappers: wrappers }).ready, false);
		const run = await studyFixture({ aiEnabled: true, aiAnswerMode: 'advanced', answererWrappers: wrappers });
		assert.deepEqual([run.chapters, run.videos, run.submits, requests.length], [0, 1, 0, 0]);
	});
	await test('a participant key removed after readiness blocks all concurrent ensemble requests', async () => {
		const first = source();
		const second = source('second');
		key(first);
		key(second);
		const wrappers = createAIAnswererWrappers(
			state(first, second),
			true,
			[
				{ key: aiModelKey(first.id, 'fixture'), threads: 1 },
				{ key: aiModelKey(second.id, 'fixture'), threads: 1 }
			],
			{ rule: 'confidence', confidenceEnabled: true }
		);
		assert.equal(inspectAIWorkConfiguration({ answererWrappers: wrappers }).ready, true);
		stored.delete(getAIKeyStorage(second.endpoint, second.id));
		const info = await searchAIEnsemble(wrappers[0].aiEnsemble!, question, 1000);
		assert.equal(info.results.length, 0);
		assert.match(info.error || '', /Key|密钥/);
		assert.equal(requests.length, 0, 'valid participants must not start before the full auth check completes');
	});
	await test('a required summary missing its key is rejected before any participant or quiz starts', async () => {
		const member = source('member');
		const summary = source('summary');
		key(member);
		const wrappers = createAIAnswererWrappers(
			state(member, summary),
			true,
			[{ key: aiModelKey(member.id, 'fixture'), threads: 2 }],
			{
				confidenceEnabled: true,
				rule: 'confidence-then-summary',
				summaryEnabled: true,
				summarySelection: aiModelKey(summary.id, 'fixture')
			}
		);
		assert.equal(inspectAIWorkConfiguration({ answererWrappers: wrappers }).ready, false);
		const run = await studyFixture({ aiEnabled: true, answererWrappers: wrappers });
		assert.deepEqual([run.chapters, run.videos, run.submits, requests.length], [0, 1, 0, 0]);
	});
	await test('direct ensemble search checks an active summary key before spending participant requests', async () => {
		const member = source('member');
		const summary = source('summary');
		key(member);
		const wrappers = createAIAnswererWrappers(
			state(member, summary),
			true,
			[{ key: aiModelKey(member.id, 'fixture'), threads: 2 }],
			{
				confidenceEnabled: true,
				rule: 'confidence-then-summary',
				summaryEnabled: true,
				summarySelection: aiModelKey(summary.id, 'fixture')
			}
		);
		const info = await searchAIEnsemble(wrappers[0].aiEnsemble!, question, 1000);
		assert.equal(info.results.length, 0);
		assert.match(info.error || '', /Key|密钥/);
		assert.equal(requests.length, 0);
	});
	await test('an enabled but unused summary without a key does not block independent participants', () => {
		const member = source('member');
		const summary = source('summary');
		key(member);
		const wrappers = createAIAnswererWrappers(
			state(member, summary),
			true,
			[{ key: aiModelKey(member.id, 'fixture'), threads: 2 }],
			{
				confidenceEnabled: true,
				rule: 'confidence',
				subjectiveRule: 'manual',
				summaryEnabled: true,
				summarySelection: aiModelKey(summary.id, 'fixture')
			}
		);
		assert.equal(inspectAIWorkConfiguration({ answererWrappers: wrappers }).ready, true);
		assert.equal(requests.length, 0);
	});
	await test('no-auth ensemble participants agree without consulting an unused key-required summary', async () => {
		const member = source('member', 'none');
		const summary = source('summary');
		const wrappers = createAIAnswererWrappers(
			state(member),
			true,
			[{ key: aiModelKey(member.id, 'fixture'), threads: 2 }],
			{ rule: 'confidence', confidenceEnabled: true, subjectiveRule: 'manual' }
		);
		// Direct callers can retain a summary object even when this rule does not use it.
		const config = {
			...wrappers[0].aiEnsemble!,
			summary: createAIAnswererWrappers(state(summary))[0].ai
		};
		const info = await searchAIEnsemble(config, question, 1000);
		assert.equal(info.results[0].answer, 'A');
		assert.equal(info.ensemble?.status, 'agreed');
		assert.equal(requests.length, 2);
		assert.ok(requests.every((request) => request.headers.Authorization === undefined));
	});
	await test('required model-list discovery without a key fails locally instead of sending an unauthenticated request', async () => {
		const provider = source();
		await assert.rejects(listAIModels(provider.endpoint, provider.id, 'api-key'), /Key|密钥/);
		assert.equal(requests.length, 0);
	});
	await test('official cloud endpoints require authentication even if stored metadata says no auth', async () => {
		for (const endpoint of ['https://api.deepseek.com', 'https://api.xiaomimimo.com/v1', 'https://api.openai.com/v1']) {
			const provider = source('official', 'none');
			provider.endpoint = endpoint;
			const wrappers = createAIAnswererWrappers(state(provider));
			assert.equal(inspectAIWorkConfiguration({ answererWrappers: wrappers }).ready, false);
			const info = await searchAIAnswer(wrappers[0].ai!, question, 1000);
			assert.equal(info.results.length, 0);
			assert.match(info.error || '', /Key|密钥/);
		}
		assert.equal(requests.length, 0);
	});
	await test('deleted or disabled selected models stay unconfigured even when an old key exists', () => {
		const provider = source();
		key(provider);
		provider.models[0].enabled = false;
		assert.equal(createAIAnswererWrappers(state(provider)).length, 0);
		assert.equal(
			inspectAIWorkConfiguration({ answererWrappers: createAIAnswererWrappers(state(provider)) }).ready,
			false
		);
		assert.equal(
			inspectAIWorkConfiguration({ answererWrappers: createAIAnswererWrappers({ ...state(provider), sources: [] }) })
				.ready,
			false
		);
		assert.equal(requests.length, 0);
	});
	await test('AI unconfigured state does not silently fall back to a configured legacy question bank', () => {
		const settings = CommonProject.scripts.settings;
		const previous = { ...settings.cfg };
		try {
			Object.assign(
				settings.cfg,
				Object.fromEntries(
					Object.entries(settings.configs).map(([name, config]: any) => [name, clone(config.defaultValue)])
				)
			);
			settings.cfg.answererWrappers = [{ name: 'legacy fixture', url: 'https://bank.invalid', method: 'get' }] as any;
			assert.equal(settings.methods.getWorkOptions().answererWrappers.length, 0);
			settings.cfg.aiEnabled = false;
			assert.equal(settings.methods.getWorkOptions().answererWrappers[0].name, 'legacy fixture');
			assert.equal(requests.length, 0);
		} finally {
			Object.keys(settings.cfg).forEach((name) => delete (settings.cfg as any)[name]);
			Object.assign(settings.cfg, previous);
		}
	});
	await test('provider no-auth selection saves and reopens while preserving a previously stored key', async () => {
		const provider = source('custom');
		key(provider);
		const fixture = providerManagerFixture(state(provider));
		try {
			fixture.mode('none');
			assert.equal(fixture.root().querySelector<HTMLInputElement>('input[type="password"]')!.disabled, true);
			await fixture.press('保存配置');
			assert.equal(fixture.read().sources[0].authMode, 'none');
			assert.equal(stored.get(getAIKeyStorage(provider.endpoint, provider.id)), 'offline-fixture-key');
			fixture.root().remove();
			fixture.open();
			assert.equal(fixture.root().querySelector<HTMLInputElement>('[role="switch"]')!.checked, true);
			assert.equal(fixture.root().querySelector('[role="switch"]')!.getAttribute('aria-checked'), 'true');
			assert.match(fixture.root().textContent || '', /不携带鉴权头/);
			await fixture.press('保存并获取模型');
			assert.equal(requests.length, 1);
			assert.equal(requests[0].headers.Authorization, undefined, 'none must not send a retained old key');
			fixture.mode('api-key');
			assert.equal(fixture.root().querySelector<HTMLInputElement>('input[type="password"]')!.disabled, false);
			await fixture.press('保存配置');
			assert.equal(fixture.read().sources[0].authMode, 'api-key');
			assert.equal(stored.get(getAIKeyStorage(provider.endpoint, provider.id)), 'offline-fixture-key');
			fixture.root().remove();
			fixture.open();
			assert.equal(fixture.root().querySelector<HTMLInputElement>('[role="switch"]')!.checked, false);
		} finally {
			fixture.cleanup();
		}
	});
	await test('provider key-only saves and clears notify readiness while missing-key discovery stays local', async () => {
		const provider = source('custom');
		const fixture = providerManagerFixture(state(provider));
		try {
			await fixture.press('保存并获取模型');
			assert.equal(requests.length, 0);
			assert.match(fixture.root().querySelector('.status')!.textContent || '', /Key|密钥/);
			fixture.typeKey('new-offline-fixture-key');
			await fixture.press('保存配置');
			assert.equal(fixture.changed(), 1);
			assert.equal(stored.get(getAIKeyStorage(provider.endpoint, provider.id)), 'new-offline-fixture-key');
			await fixture.press('清除密钥');
			assert.equal(stored.get(getAIKeyStorage(provider.endpoint, provider.id)), 'new-offline-fixture-key');
			await fixture.press('保存配置');
			assert.equal(fixture.changed(), 2);
			assert.equal(stored.has(getAIKeyStorage(provider.endpoint, provider.id)), false);
			assert.match(fixture.root().textContent || '', /自动答题将跳过/);
		} finally {
			fixture.cleanup();
		}
	});
	await test('official provider UI forces API Key mode and prevents selecting no authentication', () => {
		const provider = source('official', 'none');
		provider.endpoint = 'https://api.deepseek.com';
		const fixture = providerManagerFixture(state(provider));
		try {
			const toggle = fixture.root().querySelector<HTMLInputElement>('[role="switch"]')!;
			assert.equal(toggle.checked, false);
			assert.equal(toggle.disabled, true);
			fixture.mode('none');
			assert.equal(toggle.checked, false);
			assert.equal(toggle.getAttribute('aria-checked'), 'false');
			assert.equal(fixture.root().querySelector<HTMLInputElement>('input[type="password"]')!.disabled, false);
		} finally {
			fixture.cleanup();
		}
	});
	console.log(`AI auth readiness and chapter skip: ${checks} scenarios passed.`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
