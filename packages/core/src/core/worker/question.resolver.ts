import { QuestionResolver, WorkContext } from './interface';
import { resolveSingle, resolveMultiple, resolveJudgement, resolveCompletion, isJudgementOptions } from './resolvers';
import type { SearchInformation } from '../answer-wrapper';
import type { NativeAIAnswerData } from '../answer-wrapper/ai';

/** Native AI answers keep their array boundaries; punctuation in code/formulas is never a separator. */
function nativeAIAnswers(infos: SearchInformation[]): NativeAIAnswerData | undefined {
	for (const info of infos) {
		for (const result of info.results) {
			const data = result.extra_data as NativeAIAnswerData | undefined;
			if (data?.ai_native) {
				return Array.isArray(data.answers) && data.answers.every((answer) => typeof answer === 'string')
					? data
					: { ai: true, ai_native: true, answers: [] };
			}
		}
	}
}

const normalizeAIOption = (text: string) =>
	text
		.trim()
		.replace(/^[A-Z][.．、)）]\s*/, '')
		.replace(/\s+/g, '');

/** Only match an exact option (apart from whitespace and a displayed option letter). */
function matchAIOptions(answers: string[], options: string[]): number[] | undefined {
	const indices: number[] = [];
	for (const answer of answers) {
		const matches = options
			.map((option, index) => ({ option, index }))
			.filter(({ option }) => normalizeAIOption(option) === normalizeAIOption(answer));
		if (matches.length !== 1 || indices.includes(matches[0].index)) return;
		indices.push(matches[0].index);
	}
	return indices.length ? indices : undefined;
}

/** Positions are bound to the original option list, not line numbers or image placeholders. */
function resolveAIOptions(data: NativeAIAnswerData, options: string[]): number[] | undefined {
	if (data.option_indices === undefined) return matchAIOptions(data.answers, options);
	const indices = data.option_indices;
	const snapshot = data.option_texts;
	if (
		!Array.isArray(indices) ||
		!indices.length ||
		indices.length !== data.answers.length ||
		new Set(indices).size !== indices.length ||
		!indices.every((i) => Number.isInteger(i) && i >= 0 && i < options.length) ||
		!Array.isArray(snapshot) ||
		snapshot.length !== options.length ||
		!snapshot.every((text, i) => typeof text === 'string' && normalizeAIOption(text) === normalizeAIOption(options[i]))
	)
		return;
	// A formula transcribed from an image need not match its URL. If text does identify
	// another option, however, reject the contradiction before invoking any click handler.
	for (let i = 0; i < data.answers.length; i++) {
		const matches = options
			.map((text, index) => ({ text, index }))
			.filter(({ text }) => normalizeAIOption(text) === normalizeAIOption(data.answers[i]));
		if (matches.length && !matches.some(({ index }) => index === indices[i])) return;
	}
	return indices;
}

/** 默认答案题目处理器 */
export function createDefaultQuestionResolver<E>(
	ctx: WorkContext<E>,
	/**
	 * 选项文本提供器：替代 `o.innerText`。
	 * 图片题等场景下 innerText 无法获取 img 的 URL，需由调用方通过 DOM 遍历提供。
	 * 不传则回退到 `o.innerText`，旧调用方零影响。
	 */
	optionText?: (el: HTMLElement, i: number) => string
): Record<'single' | 'multiple' | 'completion' | 'judgement', QuestionResolver<E>> {
	const toText = (o: HTMLElement, i: number) => (optionText ? optionText(o, i) : o.innerText);
	return {
		/**
		 * 单选题处理器
		 *
		 * 委托给 resolveSingle 纯函数，将 DOM 元素适配为字符串
		 */
		async single(infos, options, handler) {
			const optionTexts = options.map((o, i) => toText(o, i));
			const ai = nativeAIAnswers(infos);
			if (
				ai !== undefined &&
				(ai.option_indices !== undefined || !isJudgementOptions(optionTexts.map((o) => o.trim())))
			) {
				const indices = ai.answers.length === 1 ? resolveAIOptions(ai, optionTexts) : undefined;
				if (!indices) return { finish: false };
				const index = indices[0];
				await handler('single', ai.answers[0], options[index], ctx);
				return { finish: true, option: optionTexts[index] };
			}

			// 选项具备判断题性质时，直接走判断题处理逻辑
			if (isJudgementOptions(optionTexts.map((o) => o.trim()))) {
				const answerGroups = infos.map((info) => info.results.map((res) => res.answer));
				const result = resolveJudgement(answerGroups, optionTexts);
				if (result.finish && result.option !== undefined) {
					const index = optionTexts.indexOf(result.option);
					const opt = index !== -1 ? options[index] : options[0];
					await handler('judgement', result.option, opt, ctx);
				}
				return result;
			}

			const answers = infos.map((info) => info.results.map((res) => res.answer)).flat();

			const result = resolveSingle(answers, optionTexts, ctx.answerSeparators);

			if (result.finish && result.option !== undefined) {
				const index = optionTexts.indexOf(result.option);
				const opt = index !== -1 ? options[index] : options[0];
				await handler('single', result.option, opt, ctx);
			}

			return result;
		},
		/**
		 * 多选题处理器
		 *
		 * 委托给 resolveMultiple 纯函数，将 DOM 元素适配为字符串
		 */
		async multiple(infos, options, handler) {
			const ai = nativeAIAnswers(infos);
			if (ai !== undefined) {
				const optionTexts = options.map((o, i) => toText(o, i));
				const indices = resolveAIOptions(ai, optionTexts);
				if (!indices) return { finish: false };
				for (const index of indices) await handler('multiple', optionTexts[index], options[index], ctx);
				return { finish: true, options: indices.map((index) => optionTexts[index]) };
			}
			const resultAnswers = infos.map((info) => info.results.map((res) => res.answer)).flat();
			const optionTexts = options.map((o, i) => toText(o, i));

			const result = resolveMultiple(resultAnswers, optionTexts, ctx.answerSeparators);

			// 纯 ABCD 答案兜底走 plainOptions，普通匹配走 options
			const resolvedOptions = result.finish ? result.options ?? result.plainOptions : undefined;

			if (result.finish && resolvedOptions) {
				for (const optText of resolvedOptions) {
					const index = optionTexts.indexOf(optText);
					const opt = index !== -1 ? options[index] : options[0];
					await handler('multiple', optText, opt, ctx);
				}
			}

			return result;
		},
		/**
		 * 判断题处理器
		 *
		 * 委托给 resolveJudgement 纯函数
		 */
		async judgement(infos, options, handler) {
			const answerGroups = infos.map((info) => info.results.map((res) => res.answer));
			const optionTexts = options.map((o, i) => toText(o, i));

			const result = resolveJudgement(answerGroups, optionTexts);

			if (result.finish && result.option !== undefined) {
				const index = optionTexts.indexOf(result.option);
				const opt = index !== -1 ? options[index] : options[0];
				await handler('judgement', result.option, opt, ctx);
			}

			return result;
		},
		/**
		 * 填空题处理器
		 *
		 * 委托给 resolveCompletion 纯函数
		 */
		async completion(infos, options, handler) {
			const ai = nativeAIAnswers(infos);
			if (ai !== undefined) {
				if (ai.answers.length !== options.length || ai.answers.some((answer) => !answer.trim()))
					return { finish: false };
				for (let i = 0; i < ai.answers.length; i++) await handler('completion', ai.answers[i], options[i], ctx);
				return { finish: true, answers: ai.answers };
			}
			const answerGroups = infos.map((info) => info.results.map((res) => res.answer));

			const result = resolveCompletion(answerGroups, options.length, ctx.answerSeparators);

			if (result.finish && result.answers) {
				for (let i = 0; i < result.answers.length; i++) {
					await handler('completion', result.answers[i], options[i], ctx);
				}
			}

			return result;
		}
	};
}
