import type { DefaultWork, RawElements, RemotePage } from '@ocsjs/core';
import { $ } from 'easy-us';
import { waitFor } from './study';

type ChoiceStyle = 'native' | 'element' | 'icon' | 'component' | 'training';
type TextControl = { read: () => string; write: (answer: string, assertCurrent: () => void) => void | Promise<void> };
type TextControlFor = (option: HTMLElement) => TextControl | undefined;

const choiceInput = 'input[type="radio"],input[type="checkbox"]';
const elementChoice = '.el-radio__input,.el-checkbox__input';
const checkedChoice = '.el-radio__input.is-checked,.el-checkbox__input.is-checked,[aria-checked="true"]';
const choiceFailure = '填写失败，页面未确认所需选项。请定位原题核对。';
const textFailure = '填写失败，页面未保留填写内容。请定位原题核对。';
const lockedTextFailure = '填写失败，当前输入框或编辑器不可编辑。请定位原题核对。';

function findControl<T extends HTMLElement>(option: HTMLElement, selector: string) {
	return option.matches(selector) ? (option as T) : option.querySelector<T>(selector);
}

function readChoice(option: HTMLElement, style: ChoiceStyle) {
	switch (style) {
		case 'native': {
			const input = findControl<HTMLInputElement>(option, choiceInput);
			return { target: input && option, selected: !!input?.checked };
		}
		case 'element':
		case 'icon': {
			const input = findControl(option, elementChoice);
			const icon = style === 'icon' ? option.querySelector<HTMLElement>('i.iconfont') : undefined;
			return {
				target: input || icon,
				selected: !!findControl(option, checkedChoice) || !!icon?.classList.contains('checkedIcon')
			};
		}
		case 'component':
			return { target: option, selected: !!findControl(option, 'div.bg-mainBg,[aria-checked="true"]') };
		case 'training': {
			const control = option.closest<HTMLElement>('.option-item') || option;
			return {
				target: option,
				selected:
					!!findControl(control, checkedChoice) || !!findControl<HTMLInputElement>(control, choiceInput)?.checked
			};
		}
	}
}

const comparable = (answer: string) =>
	answer
		.replace(/\r\n?/g, '\n')
		.replace(/\u00a0/g, ' ')
		.trim();

function notifyInput(element: HTMLElement) {
	const InputEventType = element.ownerDocument.defaultView?.Event ?? Event;
	element.dispatchEvent(new InputEventType('input', { bubbles: true }));
}

function isAvailableForWriting(element: HTMLElement) {
	return !element.closest('[hidden],[aria-disabled="true"],[aria-readonly="true"]');
}

export function zhsFormText(selector: string, remotePage?: RemotePage): TextControlFor {
	const fieldSelector = `:is(${selector}):not(input[type="hidden"],[hidden],[hidden] *)`;
	return (option) => {
		const input = findControl<HTMLInputElement | HTMLTextAreaElement>(option, fieldSelector);
		if (!input) return;
		const assertWritable = () => {
			if (!option.contains(input) || !input.matches(fieldSelector)) throw new Error(textFailure);
			if (input.readOnly || input.matches(':disabled') || !isAvailableForWriting(input)) {
				throw new Error(lockedTextFailure);
			}
		};
		return {
			read: () => input.value,
			async write(answer, assertCurrent) {
				assertCurrent();
				assertWritable();
				if (remotePage) {
					await remotePage.click(input);
					assertCurrent();
					assertWritable();
					input.value = '';
					await remotePage['keyboard.type'](answer, { delay: Math.floor(Math.random() * 100) });
				} else {
					input.focus({ preventScroll: true });
					assertCurrent();
					assertWritable();
					input.value = answer;
					notifyInput(input);
					input.blur();
				}
			}
		};
	};
}

export function zhsExamText(option: HTMLElement): TextControl | undefined {
	if (!option.classList.contains('real-editor')) return zhsFormText('input')(option);
	const editor = Reflect.get(option, 'ckeditorInstance');
	const data = editor?.data;
	if (typeof data?.get !== 'function' || typeof data?.set !== 'function') return;
	return {
		read() {
			const template = option.ownerDocument.createElement('template');
			template.innerHTML = data.get();
			return template.content.textContent || '';
		},
		write(answer, assertCurrent) {
			assertCurrent();
			if (editor.isReadOnly === true || !isAvailableForWriting(option)) throw new Error(lockedTextFailure);
			const paragraph = option.ownerDocument.createElement('p');
			paragraph.textContent = answer;
			data.set(paragraph.outerHTML);
		}
	};
}

export function zhsTrainingText(option: HTMLElement): TextControl | undefined {
	const editor = findControl(option, '.vditor-reset[contenteditable]') || findControl(option, '.vditor-reset');
	if (!editor) return;
	return {
		read: () => editor.textContent || '',
		write(answer, assertCurrent) {
			assertCurrent();
			// Resolve the explicit editing state in DOM environments without isContentEditable.
			const editingHost = editor.closest(
				'[contenteditable=""],[contenteditable="true" i],[contenteditable="plaintext-only" i],[contenteditable="false" i]'
			);
			const editable =
				editor.isContentEditable ??
				(!!editingHost && editingHost.getAttribute('contenteditable')?.toLowerCase() !== 'false');
			if (!editable || !isAvailableForWriting(editor)) throw new Error(lockedTextFailure);
			const paragraph = editor.ownerDocument.createElement('p');
			paragraph.dataset.block = '0';
			paragraph.textContent = answer;
			editor.textContent = '';
			editor.appendChild(paragraph);
			notifyInput(editor);
		}
	};
}

export function createZhsAnswerFill(
	style: ChoiceStyle,
	remotePage?: RemotePage,
	textControlFor?: TextControlFor
): Pick<DefaultWork<RawElements>, 'handler' | 'verifyFilled'> {
	const hasText = (option: HTMLElement, answer: string) => {
		const text = textControlFor?.(option)?.read();
		return text !== undefined && comparable(text) === comparable(answer);
	};
	const waitForFill = async (check: () => boolean, message: string) => {
		await $.sleep(200);
		await waitFor(check, { check_period_ms: 50, timeout_seconds: 1, timeout_message: message });
	};
	return {
		async handler(type, answer, option, ctx) {
			const failure = type === 'completion' ? textFailure : choiceFailure;
			const assertCurrent = () => {
				if (ctx.isClosed?.() || !ctx.root.isConnected || !option?.isConnected || !ctx.root.contains(option)) {
					throw new Error(failure);
				}
			};
			assertCurrent();
			if (type === 'completion') {
				const control = textControlFor?.(option);
				if (!control || !answer.trim()) throw new Error(textFailure);
				await control.write(answer, assertCurrent);
				await waitForFill(() => option.isConnected && hasText(option, answer), textFailure);
			} else {
				const choice = readChoice(option, style);
				if (choice.selected) return;
				if (!choice.target) throw new Error(choiceFailure);
				if (remotePage) await remotePage.click(choice.target);
				else choice.target.click();
				await waitForFill(() => option.isConnected && readChoice(option, style).selected, choiceFailure);
			}
		},
		verifyFilled(ctx, fills) {
			if (fills.length === 0) throw new Error(ctx.type === 'completion' ? textFailure : choiceFailure);
			if (ctx.type === 'completion') {
				if (
					!fills.every(
						({ option, answer }) => ctx.root.contains(option) && option.isConnected && hasText(option, answer)
					)
				) {
					throw new Error(textFailure);
				}
				return;
			}

			const selected = new Set(fills.map(({ option }) => option));
			if (
				fills.some(
					({ option }) => !option.isConnected || !ctx.root.contains(option) || !readChoice(option, style).selected
				)
			) {
				throw new Error(choiceFailure);
			}
			if (ctx.elements.options?.some((option) => option && !ctx.root.contains(option))) throw new Error(choiceFailure);
			if (
				ctx.elements.options?.some((option) => option && !selected.has(option) && readChoice(option, style).selected)
			) {
				throw new Error('填写失败，页面仍有其他已选项。请定位原题核对。');
			}
		}
	};
}
