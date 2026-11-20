import type { WorkResult, SimplifyWorkResult } from '@ocsjs/core';
import { $, cors, h } from 'easy-us';

const frame = 'ocs.single-question-retry.' + $.uuid();
type Action = (answers?: string[]) => Promise<void>;

interface ActionScope {
	address: NonNullable<SimplifyWorkResult['actionScope']>;
	ids: Map<WeakMap<object, string>, string>;
	actions: Map<string, Action>;
	getResults?: () => Promise<SimplifyWorkResult[]>;
	retired: boolean;
}

const scopesByOwner = new WeakMap<object, ActionScope>();
const managedActions = new Map<string, { scope: ActionScope; action: Action }>();
const standaloneActions = new Map<string, Action>();
const publishedScopes = new Map<string, ActionScope>();
const stagedActions = new WeakMap<SimplifyWorkResult, Map<string, Action>>();
const scopesByAddress = new WeakMap<object, ActionScope>();
const ids = new WeakMap<WorkResult<any>, string>();
const reviewIds = new WeakMap<object, string>();
const adoptIds = new WeakMap<object, string>();
const locateIds = new WeakMap<object, string>();
const skipIds = new WeakMap<object, string>();
let listening = false;

/** 只有会话地址进入结果存储；DOM 与回调始终留在创建它们的页面中。 */
export function registerQuestionRetry(result: WorkResult<any>): SimplifyWorkResult['retry'] {
	if (!result.retry) return;
	return registerAction(result, result.retry, ids);
}

function actionScope(owner: object): ActionScope {
	let scope = scopesByOwner.get(owner);
	if (!scope) {
		scope = { address: { id: $.uuid(), frame }, ids: new Map(), actions: new Map(), retired: false };
		scopesByOwner.set(owner, scope);
		scopesByAddress.set(scope.address, scope);
	}
	return scope;
}

function addresses(result: SimplifyWorkResult) {
	return [
		result.reviewControl,
		result.reviewActions?.adopt,
		result.reviewActions?.retry,
		result.reviewActions?.locate,
		result.retry,
		result.skipControl
	];
}

/** Keep published scopes alive across state changes, then release their callbacks when the row goes away. */
export function reconcileWorkResultActions(results: SimplifyWorkResult[]): void {
	const currentScopeIds = new Set(
		results.flatMap((result) => (result.actionScope?.frame === frame ? [result.actionScope.id] : []))
	);
	for (const [id, scope] of publishedScopes) {
		if (currentScopeIds.has(id)) continue;
		scope.retired = true;
		for (const actionId of scope.actions.keys()) managedActions.delete(actionId);
		scope.actions.clear();
		scope.getResults = undefined;
		publishedScopes.delete(id);
	}
	for (const row of results) {
		if (row.actionScope?.frame !== frame) continue;
		const scope = scopesByAddress.get(row.actionScope) || publishedScopes.get(row.actionScope.id);
		if (!scope || scope.retired) continue;
		publishedScopes.set(scope.address.id, scope);
		for (const [id, action] of stagedActions.get(row) || []) {
			managedActions.set(id, { scope, action });
		}
	}
}

export function assertWorkResultActionsCurrent(result: SimplifyWorkResult, stored?: SimplifyWorkResult[]): void {
	const scope = result.actionScope && scopesByAddress.get(result.actionScope);
	if (
		scope &&
		(scope.retired ||
			(stored &&
				publishedScopes.has(scope.address.id) &&
				!stored.some((row) => row.actionScope?.frame === frame && row.actionScope.id === scope.address.id)))
	) {
		throw new Error('答题结果已清空或替换，请重新开始答题。');
	}
}

export function registerWorkResultActions(
	result: WorkResult<any>
): Pick<SimplifyWorkResult, 'actionScope' | 'reviewControl' | 'reviewActions' | 'retry'> {
	const scope = actionScope(result);
	const reviewActions = registerReviewActions(result, scope);
	return {
		actionScope: scope.address,
		reviewControl: result.confirmReview && registerManualReview(result, result.confirmReview, scope),
		reviewActions,
		retry: reviewActions.retry
	};
}

export function registerManualReview(
	result: object,
	confirm: () => Promise<void>,
	scope?: ActionScope
): NonNullable<SimplifyWorkResult['reviewControl']> {
	return registerAction(result, confirm, reviewIds, scope);
}

/** Only addresses are stored; platform adapters and DOM references stay in the owning frame. */
export function registerReviewActions(
	result: WorkResult<any>,
	scope?: ActionScope
): NonNullable<SimplifyWorkResult['reviewActions']> {
	return {
		adopt: result.applyReviewAnswer
			? registerAction(
					result,
					(answers) => {
						if (!Array.isArray(answers)) return Promise.reject(new Error('请重新选择有效的候选回答。'));
						return result.applyReviewAnswer!(answers);
					},
					adoptIds,
					scope
			  )
			: undefined,
		retry: result.retry ? registerAction(result, result.retry, ids, scope) : undefined,
		locate: result.locateQuestion ? registerAction(result, result.locateQuestion, locateIds, scope) : undefined,
		unsupportedReason: result.applyReviewAnswer
			? undefined
			: '当前平台未提供安全替换适配，请在原题手动填写或选择后确认。'
	};
}

function registerAction(
	result: object,
	action: (answers?: string[]) => Promise<void>,
	registry: WeakMap<object, string>,
	scope?: ActionScope
) {
	let id = scope ? scope.ids.get(registry) : registry.get(result);
	if (!id) {
		id = (registry === skipIds ? 'skip.' : '') + $.uuid();
		if (scope) scope.ids.set(registry, id);
		else registry.set(result, id);
	}
	if (scope) {
		if (!scope.retired) scope.actions.set(id, action);
	} else {
		standaloneActions.set(id, action);
		if (standaloneActions.size > 500) standaloneActions.delete(standaloneActions.keys().next().value);
	}
	if (!listening) {
		listening = true;
		cors.on(frame, async ([requestedId, expiresAt, answers]) => {
			if (Date.now() > expiresAt) return '题目操作已过期，请重新点击。';
			try {
				await invokeAction(requestedId, answers);
				return '';
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		});
	}
	return { id, frame };
}

async function invokeAction(id: string, answers?: string[]): Promise<void> {
	const managed = managedActions.get(id);
	if (managed) {
		const current = await managed.scope.getResults?.();
		if (
			!managed.scope.retired &&
			current?.some((row) => addresses(row).some((address) => address?.id === id && address.frame === frame))
		) {
			const action = managedActions.get(id)?.action;
			if (action) {
				await action(answers);
				return;
			}
		}
	} else {
		const action = standaloneActions.get(id);
		if (action) {
			await action(answers);
			return;
		}
	}
	throw new Error(
		id.startsWith('skip.') ? '本题的跳过入口已失效，请刷新答题结果。' : '题目操作入口已失效，请重新开始答题。'
	);
}

export function serializeManualReview(
	result: SimplifyWorkResult,
	getResults?: () => Promise<SimplifyWorkResult[]>
): SimplifyWorkResult {
	const { _confirmReview, _skip, ...serializable } = result;
	let scope = result.actionScope && scopesByAddress.get(result.actionScope);
	if (!scope && (_confirmReview || _skip) && getResults) scope = actionScope(result);
	if (scope) {
		scope.getResults = getResults ?? scope.getResults;
		serializable.actionScope = scope.address;
	}
	if (_confirmReview) serializable.reviewControl = registerManualReview(result, _confirmReview, scope);
	if (
		_skip &&
		result.requested &&
		result.resolved &&
		!result.searching &&
		!result.retrying &&
		!result.finish &&
		!result.skipped
	) {
		serializable.skipControl = registerAction(_skip, _skip, skipIds, scope);
	}
	if (scope && !scope.retired) stagedActions.set(serializable, new Map(scope.actions));
	return serializable;
}

export function createUnansweredQuestionControl(result: SimplifyWorkResult): HTMLElement | undefined {
	if (!result.resolved || result.finish || result.retrying) return;
	const address = result.skipped ? undefined : result.skipControl;
	const locate = result.reviewControl && !result.skipped ? undefined : result.reviewActions?.locate;
	if (!address && !locate) return;
	const root = h('div', { className: 'unanswered-question-actions', style: { marginTop: '8px' } });
	const status = h('div', { role: 'status', style: { color: '#c0392b', whiteSpace: 'pre-wrap' } });
	for (const [action, label] of [
		[address, '跳过本题'],
		[locate, '定位原题']
	] as const) {
		if (!action) continue;
		const button = h('button', { type: 'button', className: 'base-style-button-secondary' }, label);
		button.onclick = async () => {
			button.disabled = true;
			status.textContent = '';
			try {
				await requestReviewAction(action, undefined, 10_000);
				if (action === locate) button.disabled = false;
			} catch (error) {
				status.textContent = error instanceof Error ? error.message : String(error);
				button.disabled = false;
			}
		};
		root.append(button);
	}
	root.append(status);
	return root;
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
	answers?: string[],
	timeoutMs = answers ? 60_000 : 8 * 60_000
): Promise<void> {
	if (address.frame === frame) {
		await invokeAction(address.id, answers);
		return;
	}
	// easy-us awaits async handlers, so a receipt is returned only after the
	// adapter and result update have actually completed in the owning frame.
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error('尚未收到原答题页面的完成结果，请检查原题与处理状态，避免重复点击。')),
			timeoutMs
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
