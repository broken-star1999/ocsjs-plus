import { QuestionResolver, WorkContext } from './interface';
import { resolveSingle, resolveMultiple, resolveJudgement, resolveCompletion, isJudgementOptions } from './resolvers';
import type { SearchInformation } from '../answer-wrapper';
import { needsAIReview } from '../answer-wrapper/ai-ensemble';

/** Native AI answers keep their array boundaries; punctuation in code/formulas is never a separator. */
function nativeAIAnswers(infos: SearchInformation[]): string[] | undefined {
	for (const info of infos) {
		for (const result of info.results) {
			const data = result.extra_data as { ai_native?: boolean; answers?: unknown } | undefined;
			if (data?.ai_native) {
				return Array.isArray(data.answers) && data.answers.every((answer) => typeof answer === 'string')
					? data.answers
					: [];
			}
		}
	}
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
	const assertActive = async () => {
		await ctx.waitUntilActive?.();
		if (ctx.isClosed?.()) throw new Error('原答题任务已关闭，已停止填写。');
	};
	return {
		/**
		 * 单选题处理器
		 *
		 * 委托给 resolveSingle 纯函数，将 DOM 元素适配为字符串
		 */
		async single(infos, options, handler) {
			if (needsAIReview(infos)) return { finish: false };
			const optionTexts = options.map((o, i) => toText(o, i));
			// 选项具备判断题性质时，直接走判断题处理逻辑
			if (isJudgementOptions(optionTexts.map((o) => o.trim()))) {
				const answerGroups = infos.map((info) => info.results.map((res) => res.answer));
				const result = resolveJudgement(answerGroups, optionTexts);
				if (result.finish && result.option !== undefined) {
					const index = optionTexts.indexOf(result.option);
					const opt = index !== -1 ? options[index] : options[0];
					await assertActive();
					await handler('judgement', result.option, opt, ctx);
				}
				return result;
			}

			const ai = nativeAIAnswers(infos);
			const answers = ai ?? infos.map((info) => info.results.map((res) => res.answer)).flat();

			const result = resolveSingle(answers, optionTexts, ctx.answerSeparators, ai !== undefined);

			if (result.finish && result.option !== undefined) {
				const index = result.optionIndex ?? optionTexts.indexOf(result.option);
				const opt = index !== -1 ? options[index] : options[0];
				await assertActive();
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
			if (needsAIReview(infos)) return { finish: false };
			const ai = nativeAIAnswers(infos);
			const resultAnswers =
				ai === undefined ? infos.map((info) => info.results.map((res) => res.answer)).flat() : [ai.join('')];
			const optionTexts = options.map((o, i) => toText(o, i));

			const result = resolveMultiple(resultAnswers, optionTexts, ctx.answerSeparators, ai !== undefined);

			// 纯 ABCD 答案兜底走 plainOptions，普通匹配走 options
			const resolvedOptions = result.finish ? result.options ?? result.plainOptions : undefined;

			if (result.finish && resolvedOptions) {
				for (let i = 0; i < resolvedOptions.length; i++) {
					const optText = resolvedOptions[i];
					const index = result.plainOptionIndices?.[i] ?? optionTexts.indexOf(optText);
					const opt = index !== -1 ? options[index] : options[0];
					await assertActive();
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
			if (needsAIReview(infos)) return { finish: false };
			const answerGroups = infos.map((info) => info.results.map((res) => res.answer));
			const optionTexts = options.map((o, i) => toText(o, i));

			const result = resolveJudgement(answerGroups, optionTexts);

			if (result.finish && result.option !== undefined) {
				const index = optionTexts.indexOf(result.option);
				const opt = index !== -1 ? options[index] : options[0];
				await assertActive();
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
			if (needsAIReview(infos)) return { finish: false };
			const ai = nativeAIAnswers(infos);
			if (ai !== undefined) {
				if (ai.length !== options.length || ai.some((answer) => !answer.trim())) return { finish: false };
				for (let i = 0; i < ai.length; i++) {
					await assertActive();
					await handler('completion', ai[i], options[i], ctx);
				}
				return { finish: true, answers: ai };
			}
			const answerGroups = infos.map((info) => info.results.map((res) => res.answer));

			const result = resolveCompletion(answerGroups, options.length, ctx.answerSeparators);

			if (result.finish && result.answers) {
				for (let i = 0; i < result.answers.length; i++) {
					await assertActive();
					await handler('completion', result.answers[i], options[i], ctx);
				}
			}

			return result;
		}
	};
}
