import { AIAnswererConfig, AIModel, normalizeAIEndpoint, validateAIExtraBody } from './ai';
import type { AnswererWrapper } from './interface';
import type { AIEnsembleRule, AISubjectiveRule } from './ai-ensemble';

export interface AIConfiguredModel extends AIModel {
	enabled: boolean;
	vision: boolean;
	extraBody: Record<string, unknown>;
}

export interface AIProviderSource {
	/** Stable internal identity; display names and endpoints can be edited independently. */
	id: string;
	name: string;
	preset: 'deepseek' | 'mimo' | 'openai';
	endpoint: string;
	timeoutSeconds: number;
	models: AIConfiguredModel[];
	/** Discovery candidates are never implicitly enabled. */
	catalog: AIModel[];
}

export interface AIProviderState {
	sources: AIProviderSource[];
	selection: string;
}

export interface AIModelThreads {
	key: string;
	threads: number;
}

export function createAIAnswererWrappers(
	state: AIProviderState,
	ensembleEnabled = false,
	assignments: AIModelThreads[] = [],
	options: {
		threshold?: number;
		confidenceEnabled?: boolean;
		summaryEnabled?: boolean;
		summarySelection?: string;
		rule?: AIEnsembleRule;
		subjectiveRule?: AISubjectiveRule;
		subjectiveSelection?: string;
	} = {}
): AnswererWrapper[] {
	const base = {
		name: '多模型联合答题',
		url: '',
		method: 'post' as const,
		type: 'GM_xmlhttpRequest' as const,
		headers: {},
		handler: ''
	};
	if (!ensembleEnabled) {
		const ai = resolveAISelection(state);
		return ai ? [{ ...base, name: 'AI · ' + ai.model, url: ai.endpoint, ai }] : [];
	}
	const models: AIAnswererConfig[] = [];
	let subjectiveModelIndex = -1;
	let error: string | undefined;
	const keys = new Set<string>();
	for (const assignment of assignments) {
		const ai = resolveAISelection({ ...state, selection: assignment.key });
		if (keys.has(assignment.key)) error = '同一个模型只能配置一行，请使用该行的并发数。';
		keys.add(assignment.key);
		if (!ai) error = '高级模式中存在已删除或停用的模型，请重新选择。';
		if (!Number.isInteger(assignment.threads) || assignment.threads < 1 || assignment.threads > 8) {
			error = '每个模型的同题并发数须为 1–8 的整数。';
		} else if (ai)
			for (let i = 0; i < assignment.threads; i++) {
				if (assignment.key === options.subjectiveSelection && i === 0) subjectiveModelIndex = models.length;
				models.push({ ...ai });
			}
	}
	if (!error && models.length < 2) error = '高级模式请至少配置两次作答：可选择多个模型，或增加单模型同题并发数。';
	const rule =
		options.rule ||
		(options.summaryEnabled
			? options.confidenceEnabled === false
				? 'summary'
				: 'confidence-then-summary'
			: options.confidenceEnabled === false
			? 'manual'
			: 'confidence');
	const objectiveError =
		(rule === 'unanimous' || rule.includes('confidence')) && options.confidenceEnabled === false
			? '当前决策规则需要启用置信度选择。'
			: undefined;
	const needsSummary = rule.includes('summary') || options.subjectiveRule === 'summary';
	let summaryError =
		needsSummary && !options.summaryEnabled ? '当前客观题或主观题处理方式需要启用总结模型。' : undefined;
	const summary =
		options.summaryEnabled && needsSummary
			? resolveAISelection({ ...state, selection: options.summarySelection || '' })
			: undefined;
	if (options.summaryEnabled && needsSummary && !summary) summaryError = '请选择一个已启用的总结模型。';
	return [
		{
			...base,
			aiEnsemble: {
				models: error ? [] : models,
				error,
				objectiveError,
				summaryError,
				repeat: true,
				threshold: options.threshold ?? 100,
				summary,
				rule,
				subjectiveRule: options.subjectiveRule,
				subjectiveModelIndex
			}
		}
	];
}

export function aiModelKey(sourceId: string, modelId: string): string {
	return JSON.stringify([sourceId, modelId]);
}

export function resolveAISelection(state: AIProviderState): AIAnswererConfig | undefined {
	for (const source of state.sources) {
		const model = source.models.find((item) => item.enabled && aiModelKey(source.id, item.id) === state.selection);
		if (model)
			return {
				label: source.name + ' / ' + model.name,
				providerName: source.name,
				endpoint: source.endpoint,
				sourceId: source.id,
				model: model.id,
				vision: model.vision,
				timeoutSeconds: source.timeoutSeconds,
				extraBody: model.extraBody
			};
	}
}

export function saveAISource(state: AIProviderState, source: AIProviderSource): AIProviderState {
	const name = source.name.trim();
	if (!source.id || !name) throw new Error('请填写提供商名称');
	normalizeAIEndpoint(source.endpoint);
	if (!Number.isFinite(source.timeoutSeconds) || source.timeoutSeconds < 10 || source.timeoutSeconds > 180) {
		throw new Error('超时时间须在 10–180 秒之间');
	}
	const previous = state.sources.find((item) => item.id === source.id);
	const endpointChanged = previous && normalizeAIEndpoint(previous.endpoint) !== normalizeAIEndpoint(source.endpoint);
	const saved: AIProviderSource = {
		...source,
		name,
		endpoint: source.endpoint.trim(),
		catalog: endpointChanged ? [] : source.catalog,
		models: source.models.map((model) => ({ ...model, extraBody: validateAIExtraBody(model.extraBody) }))
	};
	return {
		...state,
		sources: previous ? state.sources.map((item) => (item.id === source.id ? saved : item)) : [...state.sources, saved]
	};
}

export function saveAIModel(state: AIProviderState, sourceId: string, model: AIConfiguredModel): AIProviderState {
	const source = state.sources.find((item) => item.id === sourceId);
	if (!source) throw new Error('提供商已不存在，请重新打开管理窗口');
	const id = model.id.trim();
	if (!id) throw new Error('请填写模型 ID');
	const saved = { ...model, id, name: model.name.trim() || id, extraBody: validateAIExtraBody(model.extraBody) };
	const models = source.models.some((item) => item.id === id)
		? source.models.map((item) => (item.id === id ? saved : item))
		: [...source.models, saved];
	const next = saveAISource(state, { ...source, models });
	if (next.selection && !resolveAISelection(next)) next.selection = '';
	return next;
}

export function deleteAISource(state: AIProviderState, sourceId: string): AIProviderState {
	const next = { ...state, sources: state.sources.filter((source) => source.id !== sourceId) };
	if (!resolveAISelection(next)) next.selection = '';
	return next;
}

export function deleteAIModel(state: AIProviderState, sourceId: string, modelId: string): AIProviderState {
	const next = {
		...state,
		sources: state.sources.map((source) =>
			source.id === sourceId ? { ...source, models: source.models.filter((model) => model.id !== modelId) } : source
		)
	};
	if (!resolveAISelection(next)) next.selection = '';
	return next;
}

/** Pure metadata migration; credential copying stays in the storage layer. */
export function migrateAIProviders(legacy: {
	endpoint: string;
	model: string;
	vision: boolean;
	models: AIModel[];
}): AIProviderState {
	let endpoint = legacy.endpoint || 'https://api.deepseek.com';
	try {
		normalizeAIEndpoint(endpoint);
	} catch {
		endpoint = 'https://api.deepseek.com';
	}
	const deepseek = new URL(normalizeAIEndpoint(endpoint)).hostname === 'api.deepseek.com';
	const models: AIConfiguredModel[] = legacy.model
		? [
				{
					...(legacy.models.find((model) => model.id === legacy.model) || { id: legacy.model, name: legacy.model }),
					enabled: true,
					vision: legacy.vision,
					extraBody: {}
				}
		  ]
		: [];
	return {
		sources: [
			{
				id: 'migrated-default',
				name: deepseek ? 'DeepSeek' : '原有 AI 接口',
				preset: deepseek ? 'deepseek' : 'openai',
				endpoint,
				timeoutSeconds: 120,
				models,
				catalog: legacy.models
			}
		],
		selection: legacy.model ? aiModelKey('migrated-default', legacy.model) : ''
	};
}
