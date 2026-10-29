import type { QuestionRetryAdapter, QuestionTypes, RawElements, WorkContext } from '@ocsjs/core';
import { $ } from 'easy-us';

/** 超星整卷作业/考试与新版随堂练习的选中状态。 */
function selected(option: HTMLElement, layout: 'exam' | 'practice'): boolean {
	if (layout === 'practice') return option.classList.contains('active');
	const parent = option.parentElement;
	return !!(
		parent?.querySelector('[class*="check_answer"]') ||
		parent?.getAttribute('aria-checked') === 'true' ||
		parent?.querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')?.checked
	);
}

/** 只适配可见整页的标准四类题型，逐题跳转、连线/阅读等不注册入口。 */
export function createCXQuestionRetryAdapter<E extends RawElements>(options: {
	layout: 'exam' | 'practice';
	type: (ctx: WorkContext<E>) => QuestionTypes;
	optionText: (option: HTMLElement, index: number) => string;
}): QuestionRetryAdapter<E> {
	const editor = (option: HTMLElement) => option.querySelector<HTMLTextAreaElement>('textarea');
	const editorBody = (option: HTMLElement) => option.querySelector<HTMLIFrameElement>('iframe')?.contentDocument?.body;
	return {
		type: options.type,
		optionText: options.optionText,
		validate(ctx) {
			if (!options.type(ctx) || !ctx.elements.options?.length) throw new Error('当前题型或页面不支持单题重做。');
			for (const option of ctx.elements.options as HTMLElement[]) {
				if (
					option.closest('[aria-disabled="true"], [disabled]') ||
					option.querySelector('input:disabled, textarea:disabled, textarea[readonly]')
				) {
					throw new Error('当前题目不可编辑，无法重做。');
				}
				if (options.type(ctx) === 'completion' && !editor(option) && !editorBody(option)) {
					throw new Error('未找到本题可编辑的填空区域。');
				}
			}
		},
		async apply(answers, ctx, assertCurrent) {
			if (answers[0].type === 'completion') {
				for (const { option, answer } of answers) {
					assertCurrent();
					const text = editor(option);
					const body = editorBody(option);
					if (text) {
						text.value = answer;
						for (const name of ['input', 'change']) {
							const event = text.ownerDocument.createEvent('Event');
							event.initEvent(name, true, false);
							text.dispatchEvent(event);
						}
					}
					// 按文本写入，不把模型答案作为 HTML 执行。
					if (body) body.textContent = answer;
					const parent = option.parentElement?.parentElement;
					const saveScope = parent && ctx.root.contains(parent) ? parent : ctx.root;
					saveScope.querySelector<HTMLElement>('[onclick*=saveQuestion]')?.click();
					await $.sleep(500);
				}
				return;
			}
			const targets = new Set(answers.map((answer) => answer.option));
			const all = ctx.elements.options as HTMLElement[];
			if (answers[0].type === 'multiple') {
				for (const option of all) {
					assertCurrent();
					if (selected(option, options.layout) !== targets.has(option)) {
						option.click();
						await $.sleep(500);
					}
				}
			} else {
				const option = answers[0].option;
				assertCurrent();
				if (!selected(option, options.layout)) {
					option.click();
					await $.sleep(500);
				}
			}
			assertCurrent();
			if (all.some((option) => selected(option, options.layout) !== targets.has(option))) {
				throw new Error('已获得新答案，但页面选中状态未同步成功，请检查本题。');
			}
		}
	};
}
