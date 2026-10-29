import { AIAnswererConfig, searchAIAnswer } from './ai';
import type { SearchInformation } from './interface';
import type { AICallDetails } from './ai-call-log';
import { isJudgementOptions, resolveJudgement } from '../worker/resolvers/judgement';
import { resolveAIQuestionType } from './ai-question-type';

export type AIEnsembleRule =
	| 'manual'
	| 'unanimous'
	| 'confidence'
	| 'summary'
	| 'confidence-then-summary'
	| 'summary-then-confidence';

export interface AIEnsembleConfig {
	rule?: AIEnsembleRule;
	models: AIAnswererConfig[];
	error?: string;
	repeat?: boolean;
	threshold?: number;
	summary?: AIAnswererConfig;
}

export interface AIEnsembleResult {
	status: 'agreed' | 'summarized' | 'review' | 'confirmed';
	reason: string;
	members: { name: string; answers?: string[]; error?: string; ai?: AICallDetails }[];
	vote?: { count: number; total: number; threshold: number };
	summary?: { name: string; answers?: string[]; error?: string; ai?: AICallDetails };
}

export function needsAIReview(infos: SearchInformation[]): boolean {
	return infos.some((info) => info.ensemble?.status === 'review');
}

export function requireAIReview(infos: SearchInformation[], reason: string): void {
	for (const info of infos) {
		if (!info.ensemble) continue;
		info.ensemble.status = 'review';
		info.ensemble.reason = reason;
		info.error = reason;
		info.results = [];
	}
}

/** Compare answer values only. No reasoning text or additional model vote can break a tie. */
export function canonicalEnsembleAnswers(
	answers: string[],
	question: { type?: string; title: string; options?: string }
): string[] | undefined {
	if (!answers.length || answers.some((answer) => !answer.trim())) return;
	const type = resolveAIQuestionType(question);
	const values = answers.map((answer) => answer.trim().replace(/\r\n/g, '\n'));
	if (type === 'judgement' || (type === 'single' && isJudgementOptions((question.options || '').split('\n')))) {
		if (values.length !== 1) return;
		const result = resolveJudgement([values], ['正确', '错误']);
		return result.finish ? [result.option!] : undefined;
	}
	if (type === 'single' || type === 'multiple') {
		if (values.length !== 1) return;
		const letters = values[0].toUpperCase();
		if (!(type === 'single' ? /^[A-Z]$/ : /^[A-Z]+$/).test(letters)) return;
		if (new Set(letters).size !== letters.length) return;
		return [letters.split('').sort().join('')];
	}
	return values;
}

export async function searchAIEnsemble(
	config: AIEnsembleConfig,
	question: Parameters<typeof searchAIAnswer>[1],
	timeoutMs: number
): Promise<SearchInformation> {
	const ensemble: AIEnsembleResult = { status: 'review', reason: '', members: [] };
	const info: SearchInformation = { name: '多模型联合答题', results: [], ensemble };
	const identities = config.models.map((model) => model.endpoint.replace(/\/$/, '') + '\n' + model.model);
	const rule = config.rule || (config.summary ? 'confidence-then-summary' : 'confidence');
	const strategies: Record<AIEnsembleRule, string[]> = {
		manual: [],
		unanimous: ['unanimous'],
		confidence: ['confidence'],
		summary: ['summary'],
		'confidence-then-summary': ['confidence', 'summary'],
		'summary-then-confidence': ['summary', 'confidence']
	};
	if (!Object.prototype.hasOwnProperty.call(strategies, rule) || (rule.includes('summary') && !config.summary)) {
		info.error = ensemble.reason = '决策规则无效或未指定总结模型，请检查高级设置。';
		return info;
	}
	const threshold = rule.includes('confidence') ? config.threshold ?? 100 : 100;
	if (!Number.isFinite(threshold) || threshold < 50 || threshold > 100) {
		info.error = ensemble.reason = '置信度阈值（一致率）须为 50–100%。';
		return info;
	}
	if (config.error || config.models.length < 2 || (!config.repeat && new Set(identities).size !== identities.length)) {
		info.error = ensemble.reason = config.error || '联合答题至少选择两个不同的有效模型，请检查设置。';
		return info;
	}
	// Promise.all keeps configured model order even when responses arrive in a different order.
	const counts = new Map<string, number>();
	const responses = await Promise.all(
		config.models.map((model) => {
			const key = model.endpoint + '\n' + model.model;
			const index = (counts.get(key) || 0) + 1;
			counts.set(key, index);
			return searchAIAnswer(
				config.repeat ? { ...model, label: `${model.label || model.model} · 第 ${index} 次` } : model,
				question,
				timeoutMs
			);
		})
	);
	const canonical: (string[] | undefined)[] = [];
	for (const response of responses) {
		const data = response.results[0]?.extra_data as { answers?: string[] } | undefined;
		const answers = data?.answers;
		const normalized = answers && canonicalEnsembleAnswers(answers, question);
		canonical.push(normalized);
		ensemble.members.push({
			name: response.name,
			answers,
			ai: response.ai,
			error: response.error || (!normalized ? '答案格式不符合本题要求' : undefined)
		});
	}
	const valid = canonical.every(Boolean);
	const groups = new Map<string, { answers: string[]; count: number }>();
	for (const answers of canonical)
		if (answers) {
			const key = JSON.stringify(answers);
			const group = groups.get(key) || { answers, count: 0 };
			group.count++;
			groups.set(key, group);
		}
	const ranked = [...groups.values()].sort((a, b) => b.count - a.count);
	const winner = ranked[0];
	const objective = ['single', 'multiple', 'judgement'].includes(resolveAIQuestionType(question));
	const unique = winner && (!ranked[1] || winner.count > ranked[1].count);
	const agreed =
		unique && (objective ? winner.count * 100 >= threshold * canonical.length : valid && groups.size === 1);
	ensemble.vote = { count: winner?.count || 0, total: canonical.length, threshold: objective ? threshold : 100 };
	let answers: string[] | undefined;
	for (const strategy of strategies[rule]) {
		if (strategy === 'confidence' || strategy === 'unanimous') {
			if (!(strategy === 'unanimous' ? valid && groups.size === 1 : agreed)) continue;
			ensemble.status = 'agreed';
			answers = winner.answers;
			ensemble.reason =
				strategy === 'unanimous'
					? '全部回答一致，按全票一致规则填写。'
					: `${winner.count}/${canonical.length} 次答案相同，达到 ${objective ? threshold : 100}% 一致率阈值。`;
			break;
		}
		if (!config.summary) continue;
		const response = await searchAIAnswer(
			config.summary,
			{
				...question,
				model_reports: ensemble.members.map((member) => ({
					name: member.name,
					answers: member.answers,
					error: member.error,
					reasoning: member.ai?.reasoning,
					reasoningTruncated: member.ai?.reasoningTruncated
				}))
			},
			timeoutMs
		);
		const data = response.results[0]?.extra_data as { answers?: string[] } | undefined;
		answers = data?.answers && canonicalEnsembleAnswers(data.answers, question);
		ensemble.summary = {
			name: response.name,
			answers: data?.answers,
			error: response.error || (!answers ? '总结答案无效' : undefined),
			ai: response.ai
		};
		if (answers) {
			ensemble.status = 'summarized';
			ensemble.reason = '按决策规则，已采用指定总结模型独立核对后的答案。';
			break;
		}
	}
	if (!answers) {
		info.error = ensemble.reason =
			rule === 'manual' ? '按当前规则，所有回答交由人工判断。' : '未达到一致率阈值、票数打平或总结失败，等待人工评判。';
		return info;
	}
	info.results = [
		{ question: question.title, answer: answers.join('#'), extra_data: { ai: true, ai_native: true, answers } }
	];
	return info;
}
