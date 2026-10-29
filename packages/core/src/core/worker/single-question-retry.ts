import { OCSWorker } from './worker';
import { createDefaultQuestionResolver } from './question.resolver';
import { domSearchAll } from '../utils/dom';
import { QuestionTypes, RawElements, WorkContext, WorkResult } from './interface';

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
			result.retry = async () => {
				if (closed || worker.isClose || currentGeneration !== generation || owners.get(original.root) !== owner)
					throw new Error('原答题任务已失效，请重新开始答题。');
				if (busy || worker.isRunning || results.some((item) => !item.resolved)) {
					throw new Error('请等待当前答题任务或单题重做结束后再操作。');
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
				const ctx: WorkContext<E> = { ...original, searchInfos: [], type: adapter.type(original), forceSearch: true };
				result.retrying = true;
				result.searching = true;
				result.requested = false;
				result.resolved = false;
				result.result = undefined;
				result.error = undefined;
				result.ctx = ctx;
				try {
					await originalUpdate?.(result, questionIndex, results);
					ctx.searchInfos = (await worker.opts.answerer(ctx.elements, ctx)) || [];
					result.searching = false;
					result.requested = true;
					assertCurrent();
					const plan: RetryAnswer[] = [];
					const resolver = createDefaultQuestionResolver(ctx, adapter.optionText)[ctx.type!];
					const resolved = await resolver(
						ctx.searchInfos,
						ctx.elements.options as HTMLElement[],
						(type, answer, option) => {
							plan.push({ type, answer, option });
						}
					);
					if (!resolved.finish || !plan.length) {
						throw new Error(
							ctx.searchInfos
								.map((info) => info.error)
								.filter(Boolean)
								.join('；') || '本次未获取到可匹配的答案，原页面答案未改动。'
						);
					}
					assertCurrent();
					await adapter.apply(plan, ctx, assertCurrent);
					assertCurrent();
					result.result = resolved;
				} catch (error) {
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
							await originalUpdate?.(result, questionIndex, results);
						}
					} finally {
						busy = false;
					}
				}
			};
		}
		await originalInit?.(current, index, all);
	};
}
