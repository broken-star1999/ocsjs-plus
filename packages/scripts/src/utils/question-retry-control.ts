import type { WorkResult, SimplifyWorkResult } from '@ocsjs/core';
import { $, cors, h } from 'easy-us';

const frame = 'ocs.single-question-retry.' + $.uuid();
const actions = new Map<string, (answers?: string[]) => Promise<void>>();
const ids = new WeakMap<WorkResult<any>, string>();
const reviewIds = new WeakMap<object, string>();
const adoptIds = new WeakMap<object, string>();
const locateIds = new WeakMap<object, string>();
let listening = false;

/** 只有会话地址进入结果存储；DOM 与回调始终留在创建它们的页面中。 */
export function registerQuestionRetry(result: WorkResult<any>): SimplifyWorkResult['retry'] {
	if (!result.retry) return;
	return registerAction(result, result.retry, ids);
}

export function registerManualReview(
	result: object,
	confirm: () => Promise<void>
): NonNullable<SimplifyWorkResult['reviewControl']> {
	return registerAction(result, confirm, reviewIds);
}

/** Only addresses are stored; platform adapters and DOM references stay in the owning frame. */
export function registerReviewActions(result: WorkResult<any>): NonNullable<SimplifyWorkResult['reviewActions']> {
	return {
		adopt: result.applyReviewAnswer
			? registerAction(
					result,
					(answers) => {
						if (!Array.isArray(answers)) return Promise.reject(new Error('请重新选择有效的候选回答。'));
						return result.applyReviewAnswer!(answers);
					},
					adoptIds
			  )
			: undefined,
		retry: registerQuestionRetry(result),
		locate: result.locateQuestion ? registerAction(result, result.locateQuestion, locateIds) : undefined,
		unsupportedReason: result.applyReviewAnswer
			? undefined
			: '当前平台未提供安全替换适配，请在原题手动填写或选择后确认。'
	};
}

function registerAction(
	result: object,
	action: (answers?: string[]) => Promise<void>,
	registry: WeakMap<object, string>
) {
	let id = registry.get(result);
	if (!id) {
		id = $.uuid();
		registry.set(result, id);
	}
	actions.set(id, action);
	// 整页任务通常远小于此数量，避免长期 SPA 会话不断保留旧 DOM。
	if (actions.size > 500) actions.delete(actions.keys().next().value);
	if (!listening) {
		listening = true;
		cors.on(frame, async ([requestedId, expiresAt, answers]) => {
			if (Date.now() > expiresAt) return '重做指令已过期，请重新点击。';
			const action = actions.get(requestedId);
			if (!action) return '这道题的重做入口已失效，请重新开始答题。';
			try {
				await action(answers);
				return '';
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		});
	}
	return { id, frame };
}

export function serializeManualReview(result: SimplifyWorkResult): SimplifyWorkResult {
	const { _confirmReview, ...serializable } = result;
	if (_confirmReview) serializable.reviewControl = registerManualReview(result, _confirmReview);
	return serializable;
}

export function createManualReviewControl(result: SimplifyWorkResult): HTMLElement {
	const root = h('div', { className: 'ai-manual-review-control', style: { marginTop: '8px' } });
	if (!result.reviewControl || !result.searchInfos.some((info) => info.ensemble?.status === 'review')) return root;
	const button = h('button', { type: 'button', className: 'base-style-button' }, '我已人工处理本题');
	button.disabled = !result.resolved;
	const status = h('div', { role: 'status' });
	root.append(
		h('p', '请比较各模型答案，在原题手动选择或填写；完成后点击确认。确认会继续任务，不会替你选择某个模型答案。'),
		button,
		status
	);
	if (result.reviewActions?.unsupportedReason) root.append(h('p', result.reviewActions.unsupportedReason));
	for (const [address, label] of [
		[result.reviewActions?.locate, '定位原题'],
		[result.reviewActions?.retry, result.retrying ? '正在重新请求…' : '重新请求本题']
	] as const) {
		if (!address) continue;
		const action = h('button', { type: 'button', className: 'base-style-button-secondary' }, label);
		action.disabled = !result.resolved || !!result.retrying;
		action.onclick = async () => {
			action.disabled = true;
			status.textContent = '';
			try {
				await requestReviewAction(address);
			} catch (error) {
				status.textContent = error instanceof Error ? error.message : String(error);
			} finally {
				action.disabled = false;
			}
		};
		root.append(action);
	}
	button.onclick = async () => {
		button.disabled = true;
		try {
			await requestQuestionRetry(result.reviewControl!);
		} catch (error) {
			status.textContent = error instanceof Error ? error.message : String(error);
			button.disabled = false;
		}
	};
	return root;
}

export async function requestQuestionRetry(address: NonNullable<SimplifyWorkResult['retry']>): Promise<void> {
	return requestReviewAction(address);
}

export async function requestReviewAction(
	address: NonNullable<SimplifyWorkResult['retry']>,
	answers?: string[]
): Promise<void> {
	if (address.frame === frame) {
		const action = actions.get(address.id);
		if (!action) throw new Error('这道题的重做入口已失效，请重新开始答题。');
		await action(answers);
		return;
	}
	// easy-us awaits async handlers, so a receipt is returned only after the
	// adapter and result update have actually completed in the owning frame.
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error('尚未收到原答题页面的完成结果，请检查原题与处理状态，避免重复点击。')),
			answers ? 60_000 : 8 * 60_000
		);
		cors.emit(address.frame, [address.id, Date.now() + 3000, answers], (error) => {
			clearTimeout(timer);
			error ? reject(new Error(String(error))) : resolve();
		});
	});
}

export function createQuestionRetryControl(result: SimplifyWorkResult, taskWorking: boolean): HTMLElement {
	const root = h('div', { style: { marginTop: '8px', textAlign: 'right' } });
	if (!result.retry) return root;
	const button = h(
		'button',
		{ className: 'base-style-button-secondary', type: 'button' },
		result.retrying ? '正在重做本题…' : '🔄 重做本题'
	);
	button.disabled =
		taskWorking ||
		!!result.retrying ||
		!result.resolved ||
		(result.searchInfos || []).some((info) => info.ensemble?.status === 'review');
	button.title = result.retrying
		? '本题正在重新请求或采用候选，请等待本次操作完成。'
		: !result.requested || result.searching
		? '本题正在查题，请等待搜索结果返回。'
		: !result.resolved
		? '本题正在解析或填写，请等待处理完成。'
		: (result.searchInfos || []).some((info) => info.ensemble?.status === 'review')
		? '本题等待人工判断，请使用人工处理区的“重新请求本题”。'
		: taskWorking
		? '其他题目仍在自动处理中，请等待整卷自动处理结束。'
		: '重新查询并替换本题答案；其他题目不变，不触发整卷提交。';
	const status = h('div', { role: 'status', style: { color: '#c0392b', marginTop: '4px', whiteSpace: 'pre-wrap' } });
	button.onclick = async () => {
		button.disabled = true;
		status.textContent = '';
		try {
			await requestQuestionRetry(result.retry!);
		} catch (error) {
			status.textContent = error instanceof Error ? error.message : String(error);
		} finally {
			button.disabled = false;
		}
	};
	root.append(button, status);
	return root;
}
