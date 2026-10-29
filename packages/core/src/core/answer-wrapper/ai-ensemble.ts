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

export type AISubjectiveRule = 'manual' | 'selected' | 'summary';

export interface AIEnsembleConfig {
	rule?: AIEnsembleRule;
	models: AIAnswererConfig[];
	/** Participant configuration failures apply to every question. */
	error?: string;
	/** Objective rule dependencies must not disable an independent subjective route. */
	objectiveError?: string;
	/** Missing summary configuration may still allow a confidence fallback. */
	summaryError?: string;
	repeat?: boolean;
	threshold?: number;
	summary?: AIAnswererConfig;
	/** Independent from the objective voting rule. Omitted only for legacy callers. */
	subjectiveRule?: AISubjectiveRule;
	/** Index in configured order, never response arrival order. Missing/invalid means manual review. */
	subjectiveModelIndex?: number;
}

export interface AIEnsembleResult {
	status: 'running' | 'agreed' | 'summarized' | 'selected' | 'review' | 'confirmed';
	reason: string;
	members: { name: string; answers?: string[]; normalizedAnswers?: string[]; error?: string; ai?: AICallDetails }[];
	progress?: { stage: 'members' | 'summary' | 'done'; completed: number; total: number };
	vote?: { count: number; total: number; threshold: number };
	summary?: { name: string; answers?: string[]; error?: string; ai?: AICallDetails };
	selected?: { index: number; name: string };
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
	question: { type?: string; title: string; options?: string; option_count?: number }
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
		// Only page-adapter metadata is authoritative. Online selections may have
		// all options embedded in the title and an empty `options` string.
		if (
			Number.isInteger(question.option_count) &&
			question.option_count! >= 0 &&
			[...letters].some((letter) => letter.charCodeAt(0) - 65 >= question.option_count!)
		)
			return;
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
	const publish = () => {
		if (!question.onProgress) return;
		try {
			// Observers receive an immutable-in-practice snapshot, never the object
			// being updated by concurrent responses. They cannot delay paid work.
			const observed = question.onProgress(JSON.parse(JSON.stringify(info)));
			if (observed) Promise.resolve(observed).catch(() => {});
		} catch {
			// Progress is optional; diagnostics must not turn a valid answer into an error.
		}
	};
	const finish = () => {
		ensemble.progress = { stage: 'done', completed: ensemble.progress?.completed || 0, total: config.models.length };
		publish();
		return info;
	};
	const identities = config.models.map((model) => model.endpoint.replace(/\/$/, '') + '\n' + model.model);
	const type = resolveAIQuestionType(question);
	const subjective = type === 'completion' && config.subjectiveRule !== undefined;
	if (subjective && !['manual', 'selected', 'summary'].includes(config.subjectiveRule!)) {
		info.error = ensemble.reason = '主观题处理方式无效，请重新选择人工判断、指定回答或总结模型。';
		return finish();
	}
	const rule = subjective
		? config.subjectiveRule!
		: type === 'unknown' && config.subjectiveRule !== undefined
		? 'manual'
		: config.rule || (config.summary ? 'confidence-then-summary' : 'confidence');
	const strategies: Record<AIEnsembleRule | 'selected', string[]> = {
		selected: ['selected'],
		manual: [],
		unanimous: ['unanimous'],
		confidence: ['confidence'],
		summary: ['summary'],
		'confidence-then-summary': ['confidence', 'summary'],
		'summary-then-confidence': ['summary', 'confidence']
	};
	if (!Object.prototype.hasOwnProperty.call(strategies, rule)) {
		info.error = ensemble.reason = '决策规则无效或未指定总结模型，请检查高级设置。';
		return finish();
	}
	if (!subjective && rule !== 'manual' && config.objectiveError) {
		info.error = ensemble.reason = config.objectiveError;
		return finish();
	}
	if (rule === 'summary' && !config.summary) {
		info.error = ensemble.reason = config.summaryError || '决策规则未指定总结模型，请检查高级设置。';
		return finish();
	}
	const threshold = rule.includes('confidence') ? config.threshold ?? 100 : 100;
	if (!Number.isFinite(threshold) || threshold < 50 || threshold > 100) {
		info.error = ensemble.reason = '置信度阈值（一致率）须为 50–100%。';
		return finish();
	}
	if (config.error || config.models.length < 2 || (!config.repeat && new Set(identities).size !== identities.length)) {
		info.error = ensemble.reason = config.error || '联合答题至少选择两个不同的有效模型，请检查设置。';
		return finish();
	}
	if (
		rule === 'selected' &&
		(!Number.isInteger(config.subjectiveModelIndex) ||
			config.subjectiveModelIndex! < 0 ||
			config.subjectiveModelIndex! >= config.models.length)
	) {
		info.error = ensemble.reason = '主观题尚未指定有效的参与模型，等待人工评判。';
		return finish();
	}
	// Promise.all keeps configured model order even when responses arrive in a different order.
	const counts = new Map<string, number>();
	const canonical: (string[] | undefined)[] = config.models.map(() => undefined);
	ensemble.status = 'running';
	ensemble.reason = '正在等待参与模型返回答案。';
	ensemble.progress = { stage: 'members', completed: 0, total: config.models.length };
	const invocations = config.models.map((model) => {
		const key = JSON.stringify([model.sourceId || '', model.endpoint, model.model]);
		const index = (counts.get(key) || 0) + 1;
		counts.set(key, index);
		return config.repeat ? { ...model, label: `${model.label || model.model} · 第 ${index} 次` } : model;
	});
	ensemble.members = invocations.map((model) => ({ name: model.label || 'AI · ' + model.model }));
	publish();
	await Promise.all(
		invocations.map(async (model, index) => {
			const response = await searchAIAnswer(model, question, timeoutMs);
			const data = response.results[0]?.extra_data as { answers?: string[] } | undefined;
			const answers = data?.answers;
			const normalized = answers && canonicalEnsembleAnswers(answers, question);
			canonical[index] = normalized;
			ensemble.members[index] = {
				name: response.name,
				answers,
				normalizedAnswers: normalized,
				ai: response.ai,
				error: response.error || (!normalized ? '答案格式不符合本题要求' : undefined)
			};
			ensemble.progress!.completed++;
			publish();
		})
	);
	// All positions are now settled; successful callbacks cannot reorder members.
	ensemble.status = 'review';
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
	const objective = ['single', 'multiple', 'judgement'].includes(type);
	const unique = winner && (!ranked[1] || winner.count > ranked[1].count);
	const agreed =
		unique && (objective ? winner.count * 100 >= threshold * canonical.length : valid && groups.size === 1);
	if (objective || !subjective)
		ensemble.vote = { count: winner?.count || 0, total: canonical.length, threshold: objective ? threshold : 100 };
	let answers: string[] | undefined;
	for (const strategy of strategies[rule]) {
		if (strategy === 'selected') {
			const index = config.subjectiveModelIndex!;
			answers = canonical[index];
			ensemble.selected = { index, name: ensemble.members[index].name };
			if (answers) {
				ensemble.status = 'selected';
				ensemble.reason = `按主观题处理方式，采用 ${ensemble.members[index].name} 的答案；不使用一致率评判。`;
			}
			break;
		}
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
		if (!config.summary) {
			ensemble.summary = { name: '未配置总结模型', error: config.summaryError || '未指定有效的总结模型' };
			continue;
		}
		ensemble.status = 'running';
		ensemble.reason = '参与模型已返回，正在由总结模型核对。';
		ensemble.progress = { stage: 'summary', completed: config.models.length, total: config.models.length };
		publish();
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
		ensemble.status = 'review';
	}
	if (!answers) {
		info.error = ensemble.reason =
			rule === 'manual'
				? subjective
					? '主观题已设为全部人工判断，展示各次回答，等待你在原题处理并确认。'
					: '按当前规则，所有回答交由人工判断。'
				: subjective
				? rule === 'selected'
					? '指定的主观题回答失败或格式无效，等待人工评判，不自动改用其他回答。'
					: '主观题总结失败或答案格式无效，等待人工评判。'
				: '未达到一致率阈值、票数打平或总结失败，等待人工评判。';
		return finish();
	}
	info.results = [
		{ question: question.title, answer: answers.join('#'), extra_data: { ai: true, ai_native: true, answers } }
	];
	return finish();
}
