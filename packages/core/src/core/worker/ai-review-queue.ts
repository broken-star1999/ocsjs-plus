import { CommonEventEmitter } from 'easy-us';
import type { SearchInformation } from '../answer-wrapper/interface';
import { needsAIReview } from '../answer-wrapper/ai-ensemble';
import type { WorkerEvents, WorkResult, RawElements } from './interface';

/** Keeps doWork unfinished until each disagreement has a human confirmation or the task closes. */
export class AIReviewQueue {
	private pending = new Set<() => void>();
	private waits: Promise<void>[] = [];
	private closed = false;
	private cancel = () => {
		this.closed = true;
		this.pending.forEach((resolve) => resolve());
		this.pending.clear();
	};

	constructor(private owner: CommonEventEmitter<WorkerEvents>) {
		owner.once('close', this.cancel);
	}

	add(
		infos: SearchInformation[] | (() => SearchInformation[]),
		validate: () => void,
		onConfirm: () => Promise<void>
	): WorkResult<RawElements>['confirmReview'] {
		const currentInfos = typeof infos === 'function' ? infos : () => infos;
		if (this.closed || !needsAIReview(currentInfos())) return;
		let release!: () => void;
		let confirmed = false;
		let confirming = false;
		this.waits.push(
			new Promise<void>((resolve) => {
				release = resolve;
			})
		);
		this.pending.add(release);
		const complete = () => {
			if (confirmed) return;
			confirmed = true;
			this.pending.delete(release);
			release();
		};
		const confirm = async () => {
			if (this.closed) throw new Error('原答题任务已关闭，请重新开始。');
			if (confirmed || confirming) throw new Error('这道题已经确认或正在确认。');
			validate();
			confirming = true;
			const reviews = currentInfos().filter((info) => info.ensemble?.status === 'review');
			if (!reviews.length) {
				confirming = false;
				throw new Error('本题当前没有待人工处理的回答，请刷新结果后再操作。');
			}
			const previous = reviews.map((info) => ({ info, reason: info.ensemble!.reason, error: info.error }));
			try {
				for (const info of reviews) {
					info.ensemble!.status = 'confirmed';
					info.ensemble!.reason = '用户已在原题人工处理并确认。';
					info.error = undefined;
				}
				await onConfirm();
				complete();
			} catch (error) {
				for (const { info, reason, error: previousError } of previous) {
					info.ensemble!.status = 'review';
					info.ensemble!.reason = reason;
					info.error = previousError;
				}
				throw error;
			} finally {
				confirming = false;
			}
		};
		return Object.assign(confirm, { complete, pending: () => !this.closed && !confirmed && !confirming });
	}

	async wait(): Promise<void> {
		await Promise.all(this.waits);
	}

	dispose(): void {
		this.owner.removeListener('close', this.cancel);
	}
}
