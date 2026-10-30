import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { CommonProject } from '../packages/scripts/src/projects/common';
import { inspectAIWorkConfiguration } from '../packages/scripts/src/utils/ai-work-status';
import { aiModelKey } from '../packages/core/src/core/answer-wrapper/ai-providers';
import { getAIKeyStorage } from '../packages/core/src/core/answer-wrapper/ai';
import { OCSWorker, waitForWorkerActive } from '../packages/core/src/core/worker/worker';

const runtime = globalThis as any;
const stored = new Map<string, unknown>();
const oldGet = runtime.GM_getValue;
const oldSet = runtime.GM_setValue;
runtime.GM_getValue = (key: string, fallback: unknown) => (stored.has(key) ? stored.get(key) : fallback);
runtime.GM_setValue = (key: string, value: unknown) => stored.set(key, value);
let checks = 0;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function test(name: string, run: () => void | Promise<void>) {
	stored.clear();
	await run();
	checks++;
	console.log('PASS ' + name);
}
async function withSettings(patch: any, run: (settings: typeof CommonProject.scripts.settings) => void) {
	const settings = CommonProject.scripts.settings;
	const previous = { ...settings.cfg };
	try {
		Object.assign(
			settings.cfg,
			Object.fromEntries(
				Object.entries(settings.configs).map(([name, config]: any) => [
					name,
					config.defaultValue === undefined ? undefined : JSON.parse(JSON.stringify(config.defaultValue))
				])
			),
			patch
		);
		run(settings);
	} finally {
		Object.keys(settings.cfg).forEach((key) => delete (settings.cfg as any)[key]);
		Object.assign(settings.cfg, previous);
	}
}

/** Execute the actual chapter completion phase, not a copied implementation. */
function chapterTailSource(): string {
	const file = path.resolve(__dirname, '../packages/scripts/src/projects/cx.ts');
	const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
	let chapter: ts.MethodDeclaration | undefined;
	function visit(node: ts.Node) {
		if (ts.isMethodDeclaration(node) && node.name?.getText(ast) === 'chapter') chapter = node;
		ts.forEachChild(node, visit);
	}
	visit(ast);
	assert.ok(chapter?.body);
	const statements = chapter.body.statements;
	const start = statements.findIndex(
		(statement) =>
			ts.isVariableStatement(statement) &&
			statement.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === 'onChapterClose')
	);
	assert.ok(start >= 0, 'completion phase installs its close forwarding listener');
	return ts.transpileModule(
		'async function run(){' +
			statements
				.slice(start)
				.map((statement) => statement.getText(ast))
				.join('\n') +
			'}',
		{ compilerOptions: { target: ts.ScriptTarget.ES2020 } }
	).outputText;
}

function completionFixture(
	blockAt: number,
	upload: number | 'save' | 'nomove' = 80,
	throwAt?: 'work' | 'submit' | 'confirm' | 'save'
) {
	let release!: () => void;
	let entered!: () => void;
	const blocked = new Promise<void>((resolve) => (entered = resolve));
	const worker = new OCSWorker({
		root: [],
		elements: { title: 'h3', options: 'label' },
		answerer: async () => [],
		work: { type: 'single', handler: () => {} }
	});
	worker.on('close', () => (worker.isClose = true));
	worker.on('stop', () => (worker.isStop = true));
	worker.on('continuate', () => (worker.isStop = false));
	worker.doWork = async () => {
		if (throwAt === 'work') throw new Error('work fixture failure');
		return Array.from({ length: 5 }, (_, index) => ({
			ctx: { searchInfos: [] },
			result: { finish: index < (upload === 'save' ? 3 : 4) }
		})) as any;
	};
	const effects = { submit: 0, confirm: 0, save: 0, minimized: 0 };
	const states: string[] = [];
	let sleeps = 0;
	const context = vm.createContext({
		worker,
		upload,
		stopSecondWhenFinish: 1,
		visual_state: 'normal',
		waitForWorkerActive,
		BackgroundProject: { scripts: { dev: { cfg: {} }, render: { cfg: { visual: 'normal' } } } },
		CommonEvents: { emitWorkerStateChange: (state: string) => states.push(state) },
		$console: { info() {} },
		$message: { info() {}, success() {} },
		$: {
			sleep: async () => {
				sleeps++;
				if (sleeps === blockAt) {
					entered();
					await new Promise<void>((resolve) => (release = resolve));
				}
			}
		},
		frameWindow: {
			btnBlueSubmit: () => {
				if (throwAt === 'submit') throw new Error('submit fixture failure');
				effects.submit++;
			},
			submitCheckTimes: () => {
				if (throwAt === 'confirm') throw new Error('confirm fixture failure');
				effects.confirm++;
			},
			noSubmit: () => {
				if (throwAt === 'save') throw new Error('save fixture failure');
				effects.save++;
			}
		},
		top: { $: () => ({ hide() {} }) },
		CORSUtils: { panelMinimize: () => effects.minimized++ }
	});
	vm.runInContext(chapterTailSource(), context);
	let settled = false;
	const task: Promise<void> = context.run().then(() => (settled = true));
	return { worker, effects, states, blocked, release: () => release(), task, settled: () => settled };
}

async function main() {
	await test('legacy selected model and unscoped credential migrate once without changing submission preferences', () => {
		const endpoint = 'https://api.deepseek.com/v1';
		stored.set(getAIKeyStorage(endpoint), 'legacy-fixture-key');
		return withSettings({ aiEndpoint: endpoint, aiModel: 'legacy-model', upload: 'save' }, (settings) => {
			const options = settings.methods.getWorkOptions();
			assert.equal(options.upload, 'save');
			assert.equal(options.aiSelectedModel, aiModelKey('migrated-default', 'legacy-model'));
			assert.equal(stored.get(getAIKeyStorage(endpoint, 'migrated-default')), 'legacy-fixture-key');
			assert.equal(inspectAIWorkConfiguration(options).ready, true);
			stored.set(getAIKeyStorage(endpoint), 'obsolete-later-value');
			settings.methods.ensureAIProviders();
			assert.equal(stored.get(getAIKeyStorage(endpoint, 'migrated-default')), 'legacy-fixture-key');
		});
	});
	await test('already migrated provider state wins over stale legacy settings and work options are independent snapshots', () =>
		withSettings(
			{
				aiProvidersMigrated: true,
				aiEndpoint: 'https://old.invalid/v1',
				aiModel: 'obsolete',
				aiProviders: [
					{
						id: 'current',
						name: 'current',
						preset: 'openai',
						endpoint: 'https://current.invalid/v1',
						authMode: 'none',
						timeoutSeconds: 20,
						catalog: [],
						models: [{ id: 'm', name: 'm', enabled: true, vision: false, extraBody: {} }]
					}
				],
				aiSelectedModel: aiModelKey('current', 'm')
			},
			(settings) => {
				const options = settings.methods.getWorkOptions();
				assert.equal(options.answererWrappers[0].ai!.endpoint, 'https://current.invalid/v1');
				options.aiProviders[0].models[0].enabled = false;
				options.answererWrappers[0].ai!.endpoint = 'https://mutated.invalid';
				assert.equal(settings.cfg.aiProviders[0].models[0].enabled, true);
				assert.equal(settings.cfg.aiProviders[0].endpoint, 'https://current.invalid/v1');
			}
		));
	for (const policy of [80, 'save'] as const) {
		for (const point of [1, 2]) {
			await test(`closing before chapter ${
				policy === 'save' ? 'save' : 'submit'
			} at countdown ${point} prevents side effects`, async () => {
				const fixture = completionFixture(point, policy);
				await fixture.blocked;
				assert.deepEqual(fixture.states, []);
				fixture.worker.emit('close');
				fixture.release();
				await fixture.task;
				assert.deepEqual(fixture.effects, { submit: 0, confirm: 0, save: 0, minimized: 0 });
				assert.deepEqual(fixture.states, ['close']);
			});
			await test(`pausing chapter ${
				policy === 'save' ? 'save' : 'submit'
			} at countdown ${point} waits and resumes without early done`, async () => {
				const fixture = completionFixture(point, policy);
				await fixture.blocked;
				fixture.worker.emit('stop');
				fixture.release();
				await delay(35);
				assert.equal(fixture.settled(), false);
				assert.deepEqual(fixture.effects, { submit: 0, confirm: 0, save: 0, minimized: 0 });
				assert.deepEqual(fixture.states, []);
				fixture.worker.emit('continuate');
				await fixture.task;
				assert.deepEqual(fixture.effects, {
					submit: policy === 80 ? 1 : 0,
					confirm: policy === 80 ? 1 : 0,
					save: policy === 'save' ? 1 : 0,
					minimized: 0
				});
				assert.deepEqual(fixture.states, ['done']);
				fixture.worker.emit('close');
				assert.deepEqual(fixture.states, ['done'], 'finished worker cannot reset a later task status');
			});
		}
	}
	await test('closing after first submit click prevents final confirmation without claiming the first click can be undone', async () => {
		const fixture = completionFixture(3);
		await fixture.blocked;
		assert.equal(fixture.effects.submit, 1);
		fixture.worker.emit('close');
		fixture.release();
		await fixture.task;
		assert.equal(fixture.effects.submit, 1);
		assert.equal(fixture.effects.confirm, 0);
		assert.deepEqual(fixture.states, ['close']);
	});
	await test('pausing between submit click and final confirmation waits until resumed', async () => {
		const fixture = completionFixture(3);
		await fixture.blocked;
		fixture.worker.emit('stop');
		fixture.release();
		await delay(35);
		assert.equal(fixture.effects.submit, 1);
		assert.equal(fixture.effects.confirm, 0);
		assert.equal(fixture.settled(), false);
		fixture.worker.emit('continuate');
		await fixture.task;
		assert.equal(fixture.effects.confirm, 1);
		assert.deepEqual(fixture.states, ['done']);
	});
	await test('no-save policy completes with no form side effects and removes its stale close listener', async () => {
		const fixture = completionFixture(0, 'nomove');
		await fixture.task;
		assert.deepEqual(fixture.effects, { submit: 0, confirm: 0, save: 0, minimized: 0 });
		fixture.worker.emit('close');
		assert.deepEqual(fixture.states, ['done']);
	});
	for (const phase of ['work', 'submit', 'confirm', 'save'] as const) {
		await test(`chapter ${phase} exception leaves no running status or stale close forwarding listener`, async () => {
			const fixture = completionFixture(0, phase === 'save' ? 'save' : 80, phase);
			await assert.rejects(fixture.task, /fixture failure/);
			assert.deepEqual(fixture.states, ['close']);
			assert.deepEqual(fixture.effects, { submit: phase === 'confirm' ? 1 : 0, confirm: 0, save: 0, minimized: 0 });
			fixture.worker.emit('close');
			assert.deepEqual(fixture.states, ['close']);
		});
	}
	await test('an already closed failing chapter does not broadcast close twice', async () => {
		const fixture = completionFixture(0, 80, 'work');
		fixture.worker.emit('close');
		await assert.rejects(fixture.task, /fixture failure/);
		assert.deepEqual(fixture.states, ['close']);
	});
	await test('generated install and metadata headers agree on Plus version, update endpoints and full-domain connect grants', () => {
		const root = path.resolve(__dirname, '..');
		const output = path.resolve(root, 'scripts', process.env.BUILD_PATH || '../dist');
		const metadata = (file: string) => {
			const text = fs.readFileSync(path.join(output, file), 'utf8').split('// ==/UserScript==')[0];
			const result = new Map<string, string[]>();
			for (const match of text.matchAll(/^\/\/ @(\S+)\s+(.+)$/gm))
				result.set(match[1], [...(result.get(match[1]) || []), match[2].trim()]);
			return result;
		};
		const script = metadata('ocs.user.js');
		const meta = metadata('ocs.meta.js');
		const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
		for (const field of ['version', 'namespace', 'updateURL', 'downloadURL', 'connect', 'grant'])
			assert.deepEqual(script.get(field), meta.get(field));
		assert.deepEqual(meta.get('version'), [version]);
		assert.deepEqual(meta.get('namespace'), ['https://github.com/broken-star1999/ocsjs-plus']);
		assert.deepEqual(meta.get('updateURL'), [
			'https://github.com/broken-star1999/ocsjs-plus/releases/latest/download/ocs.meta.js'
		]);
		assert.deepEqual(meta.get('downloadURL'), [
			'https://github.com/broken-star1999/ocsjs-plus/releases/latest/download/ocs.user.js'
		]);
		assert.ok(meta.get('connect')!.includes('*'));
		for (const grant of [
			'GM_xmlhttpRequest',
			'GM_getValue',
			'GM_setValue',
			'GM_deleteValue',
			'GM_addValueChangeListener'
		])
			assert.ok(meta.get('grant')!.includes(grant));
	});
	console.log(`Configuration and chapter completion acceptance: ${checks} scenarios passed.`);
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		runtime.GM_getValue = oldGet;
		runtime.GM_setValue = oldSet;
	});
