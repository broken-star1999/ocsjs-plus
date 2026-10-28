import { AIAnswererConfig, AIModel, normalizeAIEndpoint, validateAIExtraBody } from './ai';

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
