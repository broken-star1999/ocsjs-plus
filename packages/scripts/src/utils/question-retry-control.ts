import type { WorkResult, SimplifyWorkResult } from '@ocsjs/core';
import { $, $message, cors, h } from 'easy-us';

const frame = 'ocs.single-question-retry.' + $.uuid();
const actions = new Map<string, () => Promise<void>>();
const ids = new WeakMap<WorkResult<any>, string>();
const reviewIds = new WeakMap<object, string>();
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

function registerAction(result: object, action: () => Promise<void>, registry: WeakMap<object, string>) {
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
		cors.on(frame, ([requestedId, expiresAt]) => {
			if (Date.now() > expiresAt) return '重做指令已过期，请重新点击。';
			const action = actions.get(requestedId);
			if (!action) return '这道题的重做入口已失效，请重新开始答题。';
			action().catch((error) => $message.error(error instanceof Error ? error.message : String(error)));
			return '';
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
	if (address.frame === frame) {
		const action = actions.get(address.id);
		if (!action) throw new Error('这道题的重做入口已失效，请重新开始答题。');
		await action();
		return;
	}
	// 子帧只确认接收指令；长请求的进度与结果沿用原有跨帧结果存储。
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('无法连接原答题页面，请返回题目并重新开始答题。')), 4000);
		cors.emit(address.frame, [address.id, Date.now() + 3000], (error) => {
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
	button.title = '任务结束后，重新查询并替换本题答案；其他题目不变，不触发整卷提交。';
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
