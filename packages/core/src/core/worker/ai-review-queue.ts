import { CommonEventEmitter } from 'easy-us';
import type { SearchInformation } from '../answer-wrapper/interface';
import { needsAIReview } from '../answer-wrapper/ai-ensemble';
import type { ReviewControl, WorkerEvents } from './interface';

type ReviewDecision = 'confirmed' | 'skipped';

/** Review actions share a lock and only settle once the owning page stores the result. */
export function createAIReviewControl(options: {
	infos: () => SearchInformation[];
	isClosed: () => boolean;
	validate: () => void;
	onDecision: (decision: ReviewDecision) => Promise<void>;
	onComplete?: () => void;
}): ReviewControl {
	let completed = false;
	let settling = false;
	const complete = () => {
		if (completed) return;
		completed = true;
		options.onComplete?.();
	};
	const settle = async (decision: ReviewDecision) => {
		if (options.isClosed()) throw new Error('原答题任务已关闭，请重新开始。');
		if (completed || settling) throw new Error('这道题已经确认、跳过或正在处理。');
		options.validate();
		const reviews = options.infos().filter((info) => info.ensemble?.status === 'review');
		if (!reviews.length) throw new Error('本题当前没有待人工处理的回答，请刷新结果后再操作。');
		settling = true;
		const previous = reviews.map((info) => ({ info, reason: info.ensemble!.reason, error: info.error }));
		try {
			for (const info of reviews) {
				info.ensemble!.status = decision;
				if (decision === 'confirmed') {
					info.ensemble!.reason = '用户已在原题人工处理并确认。';
					info.error = undefined;
				}
			}
			await options.onDecision(decision);
			complete();
		} catch (error) {
			for (const { info, reason, error: previousError } of previous) {
				info.ensemble!.status = 'review';
				info.ensemble!.reason = reason;
				info.error = previousError;
			}
			throw error;
		} finally {
			settling = false;
		}
	};
	return Object.assign(() => settle('confirmed'), {
		complete,
		pending: () => !options.isClosed() && !completed && !settling,
		skip: () => settle('skipped')
	});
}

/** Keeps doWork unfinished until each disagreement is confirmed, skipped or closed. */
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
		onDecision: (decision: ReviewDecision) => Promise<void>
	): ReviewControl | undefined {
		const currentInfos = typeof infos === 'function' ? infos : () => infos;
		if (this.closed || !needsAIReview(currentInfos())) return;
		let release!: () => void;
		this.waits.push(
			new Promise<void>((resolve) => {
				release = resolve;
			})
		);
		this.pending.add(release);
		return createAIReviewControl({
			infos: currentInfos,
			isClosed: () => this.closed,
			validate,
			onDecision,
			onComplete: () => {
				this.pending.delete(release);
				release();
			}
		});
	}

	async wait(): Promise<void> {
		await Promise.all(this.waits);
	}

	dispose(): void {
		this.owner.removeListener('close', this.cancel);
	}
}
