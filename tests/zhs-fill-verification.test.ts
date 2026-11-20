import assert from 'node:assert/strict';
import { OCSWorker } from '../packages/core/src/core/worker/worker';
import type { QuestionTypes } from '../packages/core/src/core/worker/interface';
import type { RemotePage } from '../packages/core/src/utils/playwright';
import {
	createZhsAnswerFill,
	zhsExamText,
	zhsFormText,
	zhsTrainingText
} from '../packages/scripts/src/utils/zhs-answer-fill';

type Fixture = {
	type: NonNullable<QuestionTypes>;
	answer: string;
	markup: string;
	controls: ReturnType<typeof createZhsAnswerFill>;
	setup?: (root: HTMLElement) => void;
	inspect: (root: HTMLElement) => void;
	finished: boolean;
	error?: RegExp;
};

async function exercise(name: string, fixture: Fixture) {
	const root = document.createElement('section');
	root.innerHTML = `<h3>模拟题干</h3>${fixture.markup}`;
	document.body.append(root);
	const worker = new OCSWorker({
		root: [root],
		elements: { title: 'h3', options: '.answer-target' },
		answerSeparators: ['#'],
		answerer: async () => [{ name: '离线题库', results: [{ question: '模拟题干', answer: fixture.answer }] }],
		work: {
			type: fixture.type,
			optionText: (option) => option.textContent || '',
			...fixture.controls
		}
	});
	try {
		fixture.setup?.(root);
		const [result] = await worker.doWork();
		assert.equal(result.resolved, true);
		assert.equal(result.result?.finish, fixture.finished, result.error || name);
		if (fixture.error) assert.match(result.error || '', fixture.error);
		else assert.equal(result.error, undefined);
		fixture.inspect(root);
		console.log('PASS ' + name);
	} finally {
		worker.emit('close');
		root.remove();
	}
}

function markedChoices(root: HTMLElement) {
	return Array.from(root.querySelectorAll('.is-checked'), (option) => option.textContent);
}

function elementOptions(choices: readonly string[], checked: readonly string[] = []) {
	return choices
		.map(
			(choice) =>
				`<label class="answer-target"><span class="el-checkbox__input${
					checked.includes(choice) ? ' is-checked' : ''
				}">${choice}</span></label>`
		)
		.join('');
}

function reflectClicks(root: HTMLElement) {
	root.querySelectorAll('.el-checkbox__input').forEach((control) => {
		control.addEventListener('click', () => control.classList.toggle('is-checked'));
	});
}

async function main() {
	let clicks = 0;
	await exercise('element click that never changes DOM remains unfinished', {
		type: 'single',
		answer: '甲',
		markup: elementOptions(['甲', '乙']),
		controls: createZhsAnswerFill('element'),
		finished: false,
		error: /填写失败，页面未确认所需选项/,
		setup: (root) => root.querySelector('.el-checkbox__input')!.addEventListener('click', () => clicks++),
		inspect(root) {
			assert.equal(clicks, 1);
			assert.deepEqual(markedChoices(root), []);
		}
	});

	await exercise('already checked verified option is accepted without toggling it', {
		type: 'single',
		answer: '甲',
		markup: elementOptions(['甲', '乙'], ['甲']),
		controls: createZhsAnswerFill('element'),
		finished: true,
		setup: reflectClicks,
		inspect: (root) => assert.deepEqual(markedChoices(root), ['甲'])
	});

	await exercise('native judgement whose label changes checked state finishes', {
		type: 'judgement',
		answer: '错',
		markup:
			'<label class="answer-target"><input type="radio" name="fixture">对</label><label class="answer-target"><input type="radio" name="fixture">错</label>',
		controls: createZhsAnswerFill('native'),
		finished: true,
		inspect: (root) => assert.equal(root.querySelector('input:checked')?.parentElement?.textContent, '错')
	});

	await exercise('multiple choice finishes once the requested set is confirmed', {
		type: 'multiple',
		answer: '甲#丙',
		markup: elementOptions(['甲', '乙', '丙']),
		controls: createZhsAnswerFill('element'),
		finished: true,
		setup: reflectClicks,
		inspect: (root) => assert.deepEqual(markedChoices(root), ['甲', '丙'])
	});

	await exercise('multiple choice cannot be complete while a previous extra answer remains selected', {
		type: 'multiple',
		answer: '甲#丙',
		markup: elementOptions(['甲', '乙', '丙'], ['乙']),
		controls: createZhsAnswerFill('element'),
		finished: false,
		error: /填写失败，页面仍有其他已选项/,
		setup: reflectClicks,
		inspect: (root) => assert.deepEqual(markedChoices(root), ['甲', '乙', '丙'])
	});

	await exercise('multiple choice detects a later click clearing an earlier verified option', {
		type: 'multiple',
		answer: '甲#丙',
		markup: elementOptions(['甲', '乙', '丙']),
		controls: createZhsAnswerFill('element'),
		finished: false,
		error: /填写失败，页面未确认所需选项/,
		setup(root) {
			const [first, , last] = Array.from(root.querySelectorAll('.el-checkbox__input'));
			reflectClicks(root);
			last.addEventListener('click', () => first.classList.remove('is-checked'));
		},
		inspect: (root) => assert.deepEqual(markedChoices(root), ['丙'])
	});

	const textFixture = {
		type: 'completion',
		answer: '应保留的文本',
		markup: '<textarea class="answer-target"></textarea>',
		controls: createZhsAnswerFill('native', undefined, zhsFormText('textarea'))
	} as const;
	function mountTextInput(root: HTMLElement) {
		const input = root.querySelector('textarea')!;
		// browser-env's older jsdom focus implementation fails when dispatching through the window.
		input.focus = () => {};
		input.blur = () => {};
		return input;
	}

	await exercise('a plain text field retains the written value', {
		...textFixture,
		finished: true,
		setup: mountTextInput,
		inspect: (root) => assert.equal(root.querySelector('textarea')?.value, textFixture.answer)
	});

	await exercise('controlled form input reverting the change remains unfinished', {
		...textFixture,
		finished: false,
		error: /填写失败，页面未保留填写内容/,
		setup(root) {
			const input = mountTextInput(root);
			input.addEventListener('input', () => (input.value = ''));
		},
		inspect: (root) => assert.equal(root.querySelector('textarea')?.value, '')
	});

	for (const [name, markup] of [
		['readonly', '<textarea class="answer-target" readonly>原答案</textarea>'],
		['disabled', '<textarea class="answer-target" disabled>原答案</textarea>'],
		['disabled fieldset', '<fieldset disabled><textarea class="answer-target">原答案</textarea></fieldset>']
	]) {
		await exercise(`${name} keeps the original answer and remains unfinished`, {
			...textFixture,
			markup,
			finished: false,
			error: /不可编辑/,
			setup(root) {
				const input = mountTextInput(root);
				input.focus = () => assert.fail('locked input must not be focused');
			},
			inspect: (root) => assert.equal(root.querySelector('textarea')?.value, '原答案')
		});
	}

	await exercise('a field locked by its focus handler is left unchanged', {
		...textFixture,
		markup: '<textarea class="answer-target">原答案</textarea>',
		finished: false,
		error: /不可编辑/,
		setup(root) {
			const input = mountTextInput(root);
			input.focus = () => (input.readOnly = true);
		},
		inspect: (root) => assert.equal(root.querySelector('textarea')?.value, '原答案')
	});

	await exercise('a field locked after writing still passes read-back', {
		...textFixture,
		finished: true,
		setup(root) {
			const input = mountTextInput(root);
			input.addEventListener('input', () => (input.disabled = true));
		},
		inspect(root) {
			const input = root.querySelector('textarea')!;
			assert.equal(input.disabled, true);
			assert.equal(input.value, textFixture.answer);
		}
	});

	let remoteClicks = 0;
	const remote = {
		async click(input: HTMLInputElement) {
			remoteClicks++;
			input.disabled = true;
		},
		async 'keyboard.type'() {
			assert.fail('remote typing must not run after the input locks');
		}
	} as unknown as RemotePage;
	await exercise('a field locked during the remote click keeps its old value', {
		...textFixture,
		markup: '<label class="answer-target"><input value="原答案"></label>',
		controls: createZhsAnswerFill('icon', remote, zhsFormText('input', remote)),
		finished: false,
		error: /不可编辑/,
		inspect(root) {
			assert.equal(remoteClicks, 1);
			assert.equal(root.querySelector('input')?.value, '原答案');
		}
	});

	await exercise('the smart exam fallback fills the visible input and leaves hidden data untouched', {
		...textFixture,
		markup: '<label class="answer-target"><input type="hidden" value="原数据"><input type="text"></label>',
		controls: createZhsAnswerFill('component', undefined, zhsExamText),
		finished: true,
		setup(root) {
			const input = root.querySelector<HTMLInputElement>('input[type="text"]')!;
			input.focus = () => {};
			input.blur = () => {};
		},
		inspect(root) {
			assert.equal(root.querySelector<HTMLInputElement>('input[type="hidden"]')?.value, '原数据');
			assert.equal(root.querySelector<HTMLInputElement>('input[type="text"]')?.value, textFixture.answer);
		}
	});

	const text = '<b>保留原始符号</b>';
	await exercise('smart exam editor round-trips literal text through its data interface', {
		type: 'completion',
		answer: text,
		markup: '<div class="answer-target real-editor"></div>',
		controls: createZhsAnswerFill('component', undefined, zhsExamText),
		finished: true,
		setup(root) {
			const editor = root.querySelector('.real-editor')!;
			const instance = {
				isReadOnly: false,
				data: {
					get: () => editor.innerHTML,
					set(html: string) {
						editor.innerHTML = html;
						instance.isReadOnly = true;
					}
				}
			};
			Reflect.set(editor, 'ckeditorInstance', instance);
		},
		inspect(root) {
			assert.equal(root.querySelector('.real-editor')?.textContent, text);
			assert.equal(root.querySelector('.real-editor b'), null);
		}
	});

	await exercise('a locked smart exam editor is never written', {
		...textFixture,
		markup: '<div class="answer-target real-editor">原答案</div>',
		controls: createZhsAnswerFill('component', undefined, zhsExamText),
		finished: false,
		error: /不可编辑/,
		setup(root) {
			const editor = root.querySelector('.real-editor')!;
			Reflect.set(editor, 'ckeditorInstance', {
				isReadOnly: true,
				data: { get: () => editor.innerHTML, set: () => assert.fail('locked editor must not be written') }
			});
		},
		inspect: (root) => assert.equal(root.querySelector('.real-editor')?.textContent, '原答案')
	});

	await exercise('training editor writes text into an editable surface', {
		type: 'completion',
		answer: text,
		markup: '<div class="answer-target"><div class="vditor-reset" contenteditable="true"></div></div>',
		controls: createZhsAnswerFill('training', undefined, zhsTrainingText),
		finished: true,
		setup(root) {
			const editor = root.querySelector('.vditor-reset')!;
			editor.addEventListener('input', () => editor.setAttribute('contenteditable', 'false'));
		},
		inspect(root) {
			assert.equal(root.querySelector('.vditor-reset')?.textContent, text);
			assert.equal(root.querySelector('.vditor-reset b'), null);
		}
	});

	await exercise('a training editor inheriting a locked state keeps its previous text', {
		...textFixture,
		markup:
			'<div class="answer-target" contenteditable="false"><div class="vditor-reset" contenteditable="invalid">原答案</div></div>',
		controls: createZhsAnswerFill('training', undefined, zhsTrainingText),
		finished: false,
		error: /不可编辑/,
		inspect: (root) => assert.equal(root.querySelector('.vditor-reset')?.textContent, '原答案')
	});
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
