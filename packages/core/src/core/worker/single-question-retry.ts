import { OCSWorker, createWorkProgressReporter } from './worker';
import { createDefaultQuestionResolver } from './question.resolver';
import { domSearchAll } from '../utils/dom';
import { QuestionTypes, RawElements, WorkContext, WorkResult } from './interface';
import { needsAIReview, requireAIReview } from '../answer-wrapper/ai-ensemble';

// 同一 DOM 被一个新任务接管后，即使旧 worker 没有收到 close，也不能再写回旧结果。
const owners = new WeakMap<HTMLElement, object>();

export interface RetryAnswer {
	type: QuestionTypes;
	answer: string;
	option: HTMLElement;
}

/** 平台必须明确提供替换答案的方法；不会猜测页面上的点击/选中规则。 */
export interface QuestionRetryAdapter<E extends RawElements> {
	type(ctx: WorkContext<E>): QuestionTypes;
	optionText?: (option: HTMLElement, index: number) => string;
	validate(ctx: WorkContext<E>): void;
	apply(answers: RetryAnswer[], ctx: WorkContext<E>, assertCurrent: () => void): Promise<void>;
}

/** 不含答案值或选中样式，仍能检测文字、图片、题型以及元素顺序发生变化。 */
function contentSignature<E>(ctx: WorkContext<E>): string {
	const textWithoutAnswer = (element: HTMLElement) => {
		const selector = 'textarea, input, iframe, [contenteditable="true"]';
		if (element.matches(selector)) return '';
		const clone = element.cloneNode(true) as HTMLElement;
		clone.querySelectorAll(selector).forEach((editor) => editor.remove());
		return clone.textContent;
	};
	return JSON.stringify(
		['title', 'options', 'type'].map((key) =>
			((ctx.elements as any)[key] || []).map((element: HTMLElement) => [
				textWithoutAnswer(element),
				element.tagName === 'IMG' ? element.getAttribute('src') : '',
				...Array.from(element.querySelectorAll('img')).map((image) => image.getAttribute('src')),
				element.tagName === 'INPUT' && (element as HTMLInputElement).type === 'hidden'
					? (element as HTMLInputElement).value
					: ''
			])
		)
	);
}

/**
 * 为整页答题提供单题重做。只复用查询与解析，不运行整卷完成/保存/提交回调。
 * 先完整解析出填写计划，确认有效后才替换旧答案；失败不会先清空页面答案。
 */
export function enableSingleQuestionRetry<E extends RawElements>(
	worker: OCSWorker<E>,
	adapter: QuestionRetryAdapter<E>
) {
	let results: WorkResult<E>[] = [];
	let busy = false;
	let closed = false;
	let generation = 0;
	const owner = {};
	worker.on('close', () => {
		closed = true;
	});
	const originalInit = worker.opts.onResultsInit;
	const originalUpdate = worker.opts.onResultsUpdate;
	worker.opts.onResultsInit = async (current, index, all) => {
		results = all;
		const currentGeneration = ++generation;
		for (const [questionIndex, result] of all.entries()) {
			const original = result.ctx;
			if (!original || !adapter.type(original)) continue;
			owners.set(original.root, owner);
			const questionType = adapter.type(original);
			const pageUrl = original.root.ownerDocument.location?.href;
			const signature = contentSignature(original);
			const run = async (candidate?: string[]) => {
				if (closed || worker.isClose || currentGeneration !== generation || owners.get(original.root) !== owner)
					throw new Error('原答题任务已失效，请重新开始答题。');
				const previousInfos = result.ctx?.searchInfos || [];
				const previousReview = result.confirmReview?.pending?.() ? result.confirmReview : undefined;
				if (busy || (worker.isRunning && !previousReview) || results.some((item) => !item.resolved)) {
					throw new Error('请等待当前答题任务或单题重做结束后再操作。');
				}
				if (candidate) {
					if (!needsAIReview(previousInfos)) throw new Error('本题当前没有待人工处理的候选回答。');
					const exists = previousInfos.some((info) =>
						[...(info.ensemble?.members || []), ...(info.ensemble?.summary ? [info.ensemble.summary] : [])].some(
							(member) => !member.error && JSON.stringify(member.answers) === JSON.stringify(candidate)
						)
					);
					if (!candidate.length || candidate.some((answer) => typeof answer !== 'string' || !answer.trim()) || !exists)
						throw new Error('候选回答已变化或不可用，请刷新结果后重新选择。');
				}
				const assertCurrent = () => {
					if (closed || worker.isClose || currentGeneration !== generation || owners.get(original.root) !== owner)
						throw new Error('原答题任务已失效，已停止填写。');
					if (!original.root.isConnected) throw new Error('这道题已离开当前页面，请返回题目并重新开始答题。');
					if (original.root.ownerDocument.location?.href !== pageUrl || adapter.type(original) !== questionType) {
						throw new Error('页面地址或题型已变化，本次重做已停止。');
					}
					const fresh = domSearchAll(worker.opts.elements, original.root);
					for (const key of ['title', 'options', 'type']) {
						const before: HTMLElement[] = ((original.elements as any)[key] || []).filter(Boolean);
						const after: HTMLElement[] = ((fresh as any)[key] || []).filter(Boolean);
						if (
							before.length !== after.length ||
							before.some((element, i) => element !== after[i] || !element.isConnected)
						) {
							throw new Error('题目元素已变化，请重新开始答题后再重做。');
						}
					}
					if (contentSignature(original) !== signature) throw new Error('题干、选项或图片已变化，本次重做已停止。');
					adapter.validate(original);
				};
				assertCurrent();
				busy = true;
				const ctx: WorkContext<E> = {
					...original,
					searchInfos: candidate ? previousInfos : [],
					type: adapter.type(original),
					forceSearch: true
				};
				let succeeded = false;
				let finalStoreError: unknown;
				result.retrying = true;
				result.searching = !candidate;
				result.requested = !!candidate;
				result.resolved = false;
				result.result = undefined;
				result.confirmReview = previousReview;
				result.error = undefined;
				result.ctx = ctx;
				try {
					await originalUpdate?.(result, questionIndex, results);
					assertCurrent();
					if (!candidate) {
						const progress = createWorkProgressReporter(
							result,
							ctx,
							() => originalUpdate?.(result, questionIndex, results),
							() => closed || worker.isClose || currentGeneration !== generation || owners.get(original.root) !== owner
						);
						ctx.onSearchProgress = progress.report;
						let finalInfos;
						try {
							finalInfos = (await worker.opts.answerer(ctx.elements, ctx)) || [];
						} finally {
							await progress.finish();
						}
						ctx.searchInfos = finalInfos;
					}
					result.searching = false;
					result.requested = true;
					assertCurrent();
					const plan: RetryAnswer[] = [];
					const resolver = createDefaultQuestionResolver(ctx, adapter.optionText)[ctx.type!];
					const resolved = await resolver(
						candidate
							? [
									{
										name: '人工采用候选',
										results: [
											{ question: '', answer: candidate.join('#'), extra_data: { ai_native: true, answers: candidate } }
										]
									}
							  ]
							: ctx.searchInfos,
						ctx.elements.options as HTMLElement[],
						(type, answer, option) => {
							plan.push({ type, answer, option });
						}
					);
					if (!resolved.finish || !plan.length) {
						if (ctx.searchInfos.some((info) => info.ensemble)) {
							if (!needsAIReview(ctx.searchInfos))
								requireAIReview(ctx.searchInfos, '模型答案一致，但无法匹配页面，等待人工评判。');
							let confirmed = false;
							const confirm = async () => {
								assertCurrent();
								if (result.retrying || busy || confirmed) throw new Error('本次人工确认已失效或仍在处理。');
								const infosNow = result.ctx?.searchInfos || [];
								const previous = { result: result.result, error: result.error };
								const infos = infosNow
									.filter((info) => info.ensemble)
									.map((info) => ({ info, reason: info.ensemble!.reason, error: info.error }));
								for (const info of infosNow)
									if (info.ensemble) {
										info.ensemble.status = 'confirmed';
										info.ensemble.reason = '用户已在原题人工处理并确认。';
										info.error = undefined;
									}
								confirmed = true;
								result.result = { finish: true, manual: true };
								result.error = undefined;
								busy = true;
								try {
									await originalUpdate?.(result, questionIndex, results);
								} catch (error) {
									confirmed = false;
									Object.assign(result, previous);
									for (const entry of infos) {
										entry.info.ensemble!.status = 'review';
										entry.info.ensemble!.reason = entry.reason;
										entry.info.error = entry.error;
									}
									throw error;
								} finally {
									busy = false;
								}
							};
							result.confirmReview =
								previousReview ||
								Object.assign(confirm, {
									complete: () => {
										confirmed = true;
									},
									pending: () => !confirmed && !closed && !worker.isClose && !busy
								});
						}
						throw new Error(
							ctx.searchInfos
								.map((info) => info.error)
								.filter(Boolean)
								.join('；') || '本次未获取到可匹配的答案，原页面答案未改动。'
						);
					}
					assertCurrent();
					await ctx.waitUntilActive?.();
					assertCurrent();
					await adapter.apply(plan, ctx, assertCurrent);
					assertCurrent();
					if (candidate) {
						for (const info of ctx.searchInfos)
							if (info.ensemble) {
								info.ensemble.status = 'confirmed';
								info.ensemble.reason = '用户已明确采用候选回答，并已通过页面替换校验。';
								info.error = undefined;
								info.results = [
									{
										question: (ctx.elements.title || []).map((element) => element?.textContent || '').join('\n'),
										answer: candidate.join('#'),
										extra_data: { ai: true, ai_native: true, answers: [...candidate], manual_adopted: true }
									}
								];
							}
					}
					result.result = candidate ? { ...resolved, manual: true } : resolved;
					result.confirmReview = undefined;
					succeeded = true;
				} catch (error) {
					if (previousReview) {
						if (!ctx.searchInfos.some((info) => info.ensemble)) ctx.searchInfos = previousInfos;
						if (!needsAIReview(ctx.searchInfos)) requireAIReview(ctx.searchInfos, '本次操作未完成，等待人工处理。');
						result.confirmReview = previousReview;
					}
					result.result = { finish: false };
					result.error = error instanceof Error ? error.message : String(error);
					throw error;
				} finally {
					result.searching = false;
					result.requested = true;
					result.resolved = true;
					result.retrying = false;
					try {
						// 新任务已初始化时，旧请求不能覆盖新任务的同一题号。
						if (!closed && !worker.isClose && currentGeneration === generation && owners.get(original.root) === owner) {
							try {
								await originalUpdate?.(result, questionIndex, results);
							} catch (error) {
								finalStoreError = error;
								if (previousReview) {
									succeeded = false;
									if (!ctx.searchInfos.some((info) => info.ensemble)) ctx.searchInfos = previousInfos;
									requireAIReview(ctx.searchInfos, '结果状态保存失败，等待人工检查并确认。');
									result.confirmReview = previousReview;
									result.result = { finish: false };
									result.error = error instanceof Error ? error.message : String(error);
								}
							}
						}
					} finally {
						busy = false;
					}
					if (succeeded) previousReview?.complete?.();
				}
				if (finalStoreError) throw finalStoreError;
			};
			result.retry = () => run();
			result.applyReviewAnswer = (answers) => {
				if (!Array.isArray(answers) || !answers.length || answers.some((answer) => typeof answer !== 'string'))
					return Promise.reject(new Error('候选回答格式无效，请重新选择。'));
				return run(answers);
			};
		}
		await originalInit?.(current, index, all);
	};
}
