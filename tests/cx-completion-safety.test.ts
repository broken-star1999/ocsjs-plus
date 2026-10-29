import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as sourceCore from '../packages/core/src';

/**
 * Execute all three actual CX work callbacks without running platform startup,
 * navigation or upload logic. The AST exposes their original expressions inside
 * their original module imports; no production source file is rewritten.
 */
function loadCompletionWorkCallbacks(): any[] {
	const filename = path.resolve(__dirname, '../packages/scripts/src/projects/cx.ts');
	const source = fs.readFileSync(filename, 'utf8');
	const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
	const callbacks: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isNewExpression(node) && node.expression.getText(ast) === 'OCSWorker') {
			const options = node.arguments?.[0];
			assert.ok(options && ts.isObjectLiteralExpression(options), 'CX worker options must remain inspectable');
			const work = options.properties.find(
				(property) => ts.isPropertyAssignment(property) && property.name.getText(ast) === 'work'
			);
			assert.ok(work && ts.isPropertyAssignment(work), 'CX worker must provide its actual work callback');
			callbacks.push(work.initializer.getText(ast));
		}
		ts.forEachChild(node, visit);
	};
	visit(ast);
	assert.equal(callbacks.length, 3, 'cover work/exam, mobile practice, and chapter callbacks explicitly');
	const exposed = source + '\nexport const __completionWorkCallbacks = [' + callbacks.join(',\n') + '];\n';
	const compiled = ts.transpileModule(exposed, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
	}).outputText;
	const Module = require('node:module');
	const loaded = new Module(filename);
	loaded.filename = filename;
	loaded.paths = Module._nodeModulePaths(path.dirname(filename));
	const originalRequire = loaded.require.bind(loaded);
	// The callbacks use current source resolvers, independent of generated lib state.
	loaded.require = (name: string) => (name === '@ocsjs/core' ? sourceCore : originalRequire(name));
	loaded._compile(compiled, filename);
	return loaded.exports.__completionWorkCallbacks;
}

async function main() {
	const callbacks = loadCompletionWorkCallbacks();
	const originalSleep = sourceCore.$.sleep;
	sourceCore.$.sleep = async () => {};
	const samples = [
		'<img src=x onerror="globalThis.__cxCompletionProbe=1">',
		'<script>globalThis.__cxCompletionProbe=1</script><b>literal markup</b>',
		'if (a < b && c > 0) { return "C#;x,y"; }',
		'公式：x<y，∫₀¹ x² dx = 1/3\n第二行保留 & < > " 标点'
	];
	let checks = 0;
	try {
		for (const [index, work] of callbacks.entries()) {
			for (const [sample, answer] of samples.entries()) {
				const root = document.createElement('section');
				root.innerHTML =
					'<input type="hidden" name="type123" id="answertype123" value="4">' +
					'<div class="host"><div class="editor"><textarea>old</textarea><iframe></iframe></div>' +
					'<button onclick="saveQuestion()">save</button></div>';
				document.body.append(root);
				try {
					const editor = root.querySelector<HTMLElement>('.editor')!;
					const textarea = editor.querySelector('textarea')!;
					const body = editor.querySelector('iframe')!.contentDocument!.body;
					// Chapter's production option is a textarea; the other two use an editor container.
					const option = index === 2 ? textarea : editor;
					let saves = 0;
					root.querySelector('button')!.onclick = () => {
						saves++;
					};
					const answers = sourceCore.parseAIAnswers(
						JSON.stringify({ answers: [answer], uncertain: false }),
						'completion'
					)!;
					const info = {
						name: 'offline native AI',
						results: [{ question: 'local', answer, extra_data: { ai: true, ai_native: true, answers } }]
					};
					const ctx: any = {
						root,
						type: 'completion',
						elements: { type: [root.querySelector('input')], options: [option] },
						searchInfos: [info]
					};
					const result =
						typeof work === 'function'
							? await work(ctx)
							: await sourceCore
									.createDefaultQuestionResolver(ctx, (node) => node.textContent || '')
									.completion(ctx.searchInfos, ctx.elements.options, work.handler);
					assert.equal(result.finish, true);
					assert.equal(body.textContent, answer, 'rich text editor must retain literal model output');
					assert.equal(textarea.value, answer);
					assert.equal(body.querySelector('img, [onerror], script, b'), null, 'model text must not create elements');
					assert.equal(saves, 1, 'normal local save hook is still invoked');
					checks++;
					console.log(`PASS CX completion callback ${index + 1}, literal sample ${sample + 1}`);
				} finally {
					root.remove();
				}
			}
		}
	} finally {
		sourceCore.$.sleep = originalSleep;
	}
	console.log(`CX completion safety: ${checks} scenarios passed.`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
