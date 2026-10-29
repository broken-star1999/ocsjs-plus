import type { AIConsensusSettings } from './ai-consensus-settings';

/** Plain-language preview of the saved strategy; it does not change configuration. */
export function describeAIConsensusPlan(state: AIConsensusSettings) {
	const countsValid = state.assignments.every(
		(item) => Number.isInteger(item.threads) && item.threads >= 1 && item.threads <= 8
	);
	const basicRequests = countsValid ? state.assignments.reduce((sum, item) => sum + item.threads, 0) : undefined;
	const summaryRequests =
		state.summaryEnabled && (state.rule.includes('summary') || state.subjectiveRule === 'summary') ? 1 : 0;
	const modelName = (key?: string) => {
		for (const source of state.sources)
			for (const model of source.models)
				if (JSON.stringify([source.id, model.id]) === key && model.enabled) return source.name + ' / ' + model.name;
	};
	const summary = modelName(state.summaryKey) || '尚未选择的总结模型';
	const threshold = Number.isFinite(state.threshold) ? state.threshold + '%' : '待设置的';
	const decision: Record<AIConsensusSettings['rule'], string> = {
		manual: '客观题：展示各次回答，由你在原题人工处理并确认。',
		unanimous: '客观题：全部回答都有效且一致时自动填写，否则交给人工。',
		confidence: `客观题：最高票答案达到 ${threshold} 一致率且没有并列时自动填写，否则交给人工。`,
		summary: `客观题：每题由 ${summary} 核对后填写；总结无有效结果时交给人工。`,
		'confidence-then-summary': `客观题：先按 ${threshold} 一致率选择；未达标或并列时由 ${summary} 总结，仍无有效结果则交给人工。`,
		'summary-then-confidence': `客观题：先由 ${summary} 总结；总结失败时再按 ${threshold} 一致率选择，仍未达标则交给人工。`
	};
	const selected = modelName(state.subjectiveKey);
	const participating = state.assignments.some((item) => item.key === state.subjectiveKey);
	const subjective =
		state.subjectiveRule === 'summary'
			? `主观题：每题由 ${summary} 汇总所有回答后作答；失败时交给人工。`
			: state.subjectiveRule === 'selected'
			? selected && participating
				? `主观题：采用 ${selected} 按配置顺序的首次回答；失败时交给人工。`
				: '主观题：尚未指定有效的参与模型，将交给人工处理。'
			: '主观题：仅展示各次回答，由你在原题填写后确认。';
	const requests =
		basicRequests === undefined
			? '请求规模：请先将每个模型的同题作答次数设为 1–8 的整数。'
			: `每题基础 ${basicRequests} 次请求；${
					summaryRequests ? `总结最多额外 1 次，每题最多 ${basicRequests + 1} 次。` : '当前规则不额外调用总结模型。'
			  }`;
	const questionThreads =
		Number.isInteger(state.questionThreads) && state.questionThreads! > 0 ? state.questionThreads! : undefined;
	const concurrency =
		questionThreads && basicRequests !== undefined
			? `同时处理 ${questionThreads} 道题时，基础阶段最多并发 ${
					questionThreads * basicRequests
			  } 次请求；实际并发随答题进度变化。`
			: '同题作答次数与同时处理的题目数共同决定请求并发规模。';
	return { objective: decision[state.rule], subjective, requests, concurrency, basicRequests, summaryRequests };
}
