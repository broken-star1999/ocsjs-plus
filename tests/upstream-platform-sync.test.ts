import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

/** Execute the real merged helpers without starting a platform, navigating, or sending requests. */
function sourceFile(relative: string) {
	const filename = path.resolve(__dirname, relative);
	return ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
}

function declaration(file: ts.SourceFile, name: string, kind: 'function' | 'variable' | 'class') {
	let found: string | undefined;
	const visit = (node: ts.Node) => {
		if (kind === 'function' && ts.isFunctionDeclaration(node) && node.name?.text === name)
			found = node.getText(file).replace(/^export\s+/, '');
		if (kind === 'class' && ts.isClassDeclaration(node) && node.name?.text === name)
			found = node.getText(file).replace(/^export\s+/, '');
		if (kind === 'variable' && ts.isVariableDeclaration(node) && node.name.getText(file) === name)
			found = `const ${name} = ${node.initializer!.getText(file)};`;
		ts.forEachChild(node, visit);
	};
	visit(file);
	assert.ok(found, `production declaration remains available: ${name}`);
	return found;
}

const ykt = sourceFile('../packages/scripts/src/projects/yuketang.ts');
const work = sourceFile('../packages/scripts/src/utils/work.ts');
const study = sourceFile('../packages/scripts/src/utils/study.ts');
const strings = sourceFile('../packages/core/src/utils/string.ts');
const source = [
	declaration(strings, 'StringUtils', 'class'),
	declaration(work, 'extractTextWithImages', 'function'),
	declaration(work, 'removeRedundantWords', 'function'),
	declaration(ykt, 'YKT_BLANK_INPUT_SELECTOR', 'variable'),
	declaration(ykt, 'cloneYktForTextExtract', 'function'),
	declaration(ykt, 'extractYktTitleText', 'function'),
	declaration(ykt, 'optionExtract', 'variable'),
	declaration(ykt, 'parseYktQuestionType', 'function'),
	declaration(study, 'waitFor', 'function'),
	declaration(study, 'waitForElement', 'function'),
	'globalThis.helpers = { cloneYktForTextExtract, extractYktTitleText, optionExtract, parseYktQuestionType, waitFor, waitForElement };'
].join('\n');
const context: any = { Node, document, setInterval, clearInterval, setTimeout, clearTimeout };
vm.runInNewContext(
	ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } })
		.outputText,
	context
);
const helpers = context.helpers;
let checks = 0;

/** Expose only the real iframe callbacks; mock the transport, media, and navigation around them. */
function zhsVideoCallbacks() {
	const file = sourceFile('../packages/scripts/src/projects/zhs.ts');
	let oncomplete: string | undefined;
	let iframeBranch: string | undefined;
	const visit = (node: ts.Node) => {
		if (
			ts.isPropertyAssignment(node) &&
			node.name.getText(file) === 'hike_polymas_video' &&
			ts.isNewExpression(node.initializer)
		) {
			const options = node.initializer.arguments?.[0];
			assert.ok(options && ts.isObjectLiteralExpression(options));
			const handler = options.properties.find((property) => property.name?.getText(file) === 'oncomplete');
			assert.ok(handler);
			oncomplete = handler.getText(file);
		}
		if (ts.isIfStatement(node) && node.expression.getText(file) === 'isIframeVideoJob')
			iframeBranch = node.thenStatement.getText(file);
		ts.forEachChild(node, visit);
	};
	visit(file);
	assert.ok(oncomplete && iframeBranch, 'both sides of the iframe completion protocol must remain inspectable');
	return ts.transpileModule(`globalThis.child = {${oncomplete}}; globalThis.parent = async () => ${iframeBranch};`, {
		compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
	}).outputText;
}

const zhsCallbacks = zhsVideoCallbacks();

function zhsProbe(duration: string, mediaFails = false, signalTimesOut = false) {
	const store = new Map<string, string>([
		['hikev2_polymas_video_duration', duration],
		['hikev2_polymas_video', 'end']
	]);
	const waits: { timeout_seconds: number; timeout_message: string }[] = [];
	const warnings: string[] = [];
	let nextCount = 0;
	let videoActions: any;
	const probe: any = {
		$store: { get: (key: string) => store.get(key), set: (key: string, value: string) => store.set(key, value) },
		waitFor: async (predicate: () => unknown, options: { timeout_seconds: number; timeout_message: string }) => {
			waits.push(options);
			if (signalTimesOut) throw new Error(options.timeout_message);
			return predicate();
		},
		waitForMedia: () =>
			mediaFails ? Promise.reject(new Error('local media failure')) : Promise.resolve({ duration: 120 }),
		watch: (_processor: unknown, _options: unknown, actions: unknown) => {
			videoActions = actions;
		},
		ZHSProject: { scripts: { hike_v2: { cfg: {} } } },
		$message: { info: () => {}, warn: (message: string) => warnings.push(message) },
		$: { sleep: async () => {} },
		next: async () => {
			nextCount++;
		},
		location: { reload: () => assert.fail('the fixture must not navigate') }
	};
	vm.runInNewContext(zhsCallbacks, probe);
	return { probe, store, waits, warnings, nextCount: () => nextCount, videoActions: () => videoActions };
}

async function test(name: string, action: () => void | Promise<void>) {
	await action();
	checks++;
	console.log('PASS ' + name);
}

function element(html: string) {
	const node = document.createElement('div');
	node.innerHTML = html;
	return node;
}

async function main() {
	await test('LaTeX-only title keeps its source formula without altering the page', () => {
		const title = element('<img class="kfformula" src="data:image/png;base64,Zm9ybXVsYQ==">');
		title.querySelector('img')!.setAttribute('data-latex', '\\frac{1}{2}');
		const before = title.outerHTML;
		assert.equal(helpers.extractYktTitleText(title).trim(), '$\\frac{1}{2}$');
		assert.equal(title.outerHTML, before);
	});
	await test('escaped LaTeX fallback and blank positions remain readable', () => {
		const title = element('<img class="kfformula"><input class="blank-item-dynamic">');
		title.querySelector('img')!.setAttribute('data-slatex', '\\\\alpha+1');
		const result = helpers.extractYktTitleText(title);
		assert.ok(result.includes('$\\alpha+1$'));
		assert.ok(result.includes('____'));
	});
	await test('a mixed formula and ordinary-image option keeps its image in the same group', () => {
		const option = element(
			'<span class="radioText">表达式<img class="kfformula"><img src="https://fixture.invalid/figure.png"></span>'
		);
		option.querySelector('.kfformula')!.setAttribute('data-latex', 'x^2');
		const before = option.outerHTML;
		const result = helpers.optionExtract(option);
		assert.ok(result.text.includes('表达式 $x^2$'));
		assert.deepEqual(Array.from(result.images), ['https://fixture.invalid/figure.png']);
		assert.equal(option.outerHTML, before);
	});
	await test('four image-only option groups retain their own multiple-image order', () => {
		const outputs = [0, 1, 2, 3].map((index) =>
			helpers.optionExtract(
				element(
					`<span class="checkboxText"><img src="https://fixture.invalid/${index}-a.png"><img src="https://fixture.invalid/${index}-b.png"></span>`
				)
			)
		);
		assert.equal(outputs.length, 4);
		for (const [index, output] of outputs.entries())
			assert.deepEqual(Array.from(output.images), [
				`https://fixture.invalid/${index}-a.png`,
				`https://fixture.invalid/${index}-b.png`
			]);
	});
	await test('judgement icons retain their semantic values without inventing images', () => {
		for (const [value, expected] of [
			['true', '对'],
			['false', '错']
		]) {
			const result = helpers.optionExtract(element(`<input value="${value}"><svg></svg>`));
			assert.equal(result.text, expected);
			assert.equal(result.images.length, 0);
		}
	});
	await test('unsupported page type remains unsupported instead of guessing an answer type', () => {
		assert.equal(helpers.parseYktQuestionType('未知题型'), undefined);
		assert.equal(helpers.parseYktQuestionType('4.单选题(1分)'), 'single');
		assert.equal(helpers.parseYktQuestionType('判断题'), 'judgement');
	});
	await test('waitFor resolves immediate success and rejects a predicate error', async () => {
		assert.equal(await helpers.waitFor(() => 'ready', { timeout_seconds: 0.1 }), 'ready');
		await assert.rejects(
			helpers.waitFor(() => Promise.reject(new Error('predicate failed'))),
			/predicate failed/
		);
	});
	await test('async waitFor predicates never overlap', async () => {
		let calls = 0;
		let active = 0;
		let peak = 0;
		const result = await helpers.waitFor(
			async () => {
				calls++;
				active++;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 3));
				active--;
				return calls === 3 ? 'settled' : '';
			},
			{ check_period_ms: 1, timeout_seconds: 1 }
		);
		assert.equal(result, 'settled');
		assert.equal(peak, 1);
	});
	await test('waitFor rejects with a useful timeout message', async () => {
		await assert.rejects(
			helpers.waitFor(() => false, { check_period_ms: 1, timeout_seconds: 0.01, timeout_message: 'local timeout' }),
			/local timeout/
		);
	});
	await test('waitForElement uses the supplied callback document', async () => {
		const frameDocument = document.implementation.createHTMLDocument('local frame');
		const target = frameDocument.createElement('div');
		target.className = 'ready';
		frameDocument.body.append(target);
		const result = await helpers.waitForElement(() => frameDocument.querySelector('.ready'), {
			timeout_seconds: 0.1
		});
		assert.equal(result, target);
	});
	await test('failed iframe media emits the same completion key that the parent awaits', async () => {
		const { probe, store } = zhsProbe('120', true);
		await probe.child.oncomplete();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(store.get('hikev2_polymas_video'), 'end');
		assert.equal(store.has('hike_polymas_video'), false);
	});
	await test('normal iframe media reports seconds and completion through the shared protocol', async () => {
		const { probe, store, videoActions } = zhsProbe('120');
		await probe.child.oncomplete();
		await new Promise((resolve) => setImmediate(resolve));
		videoActions().onplay();
		assert.equal(store.get('hikev2_polymas_video_duration'), '120');
		videoActions().onended();
		assert.equal(store.get('hikev2_polymas_video'), 'end');
		assert.equal(store.get('hikev2_polymas_video_duration'), '');
	});
	await test('parent iframe signal and playback waits use seconds rather than milliseconds', async () => {
		const { probe, waits, nextCount } = zhsProbe('120');
		await probe.parent();
		assert.deepEqual(
			waits.map((wait) => wait.timeout_seconds),
			[10, 120]
		);
		assert.equal(nextCount(), 1);
	});
	await test('invalid iframe media durations retain a bounded fallback', async () => {
		for (const duration of ['Infinity', 'NaN', '-5', '0']) {
			const { probe, waits } = zhsProbe(duration);
			await probe.parent();
			assert.equal(waits[1].timeout_seconds, 3);
		}
	});
	await test('missing iframe duration signal warns and continues once after its bounded timeout', async () => {
		const { probe, waits, warnings, nextCount } = zhsProbe('', false, true);
		await probe.parent();
		assert.equal(waits.length, 1);
		assert.equal(waits[0].timeout_seconds, 10);
		assert.equal(warnings.length, 1);
		assert.equal(nextCount(), 1);
	});
	console.log(`Upstream platform integration: ${checks} scenarios passed.`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
