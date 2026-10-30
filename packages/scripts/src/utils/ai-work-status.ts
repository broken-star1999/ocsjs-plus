import type { AnswererWrapper } from '@ocsjs/core';
import { getAIConfigurationError, normalizeAIEndpoint } from '@ocsjs/core';
import { h } from 'easy-us';

export interface AIWorkStatusOptions {
	aiEnabled?: boolean;
	aiAnswerMode?: 'basic' | 'advanced';
	answererWrappers: AnswererWrapper[];
	thread?: number;
}

/** Global errors block a task; a missing rule dependency only affects its own question type. */
export function inspectAIWorkConfiguration(options: AIWorkStatusOptions) {
	const wrappers = options.answererWrappers;
	const ai = wrappers.flatMap((wrapper) => (wrapper.ai ? [wrapper.ai] : []));
	const ensembles = wrappers.flatMap((wrapper) => (wrapper.aiEnsemble ? [wrapper.aiEnsemble] : []));
	const isAI = options.aiEnabled === true || ai.length > 0 || ensembles.length > 0;
	let error = !wrappers.length
		? isAI
			? '请先添加并选择一个已启用的普通模式模型，或完成高级模式配置。'
			: '请先配置并启用题库。'
		: '';
	const warnings: string[] = [];
	for (const config of ensembles) {
		if (config.error || config.models.length < 2) error ||= config.error || '高级模式至少配置 2 次作答。';
		if (config.objectiveError) warnings.push('客观题：' + config.objectiveError);
		if (config.summaryError) warnings.push('总结规则：' + config.summaryError);
		if (
			config.subjectiveRule === 'selected' &&
			(!Number.isInteger(config.subjectiveModelIndex) ||
				config.subjectiveModelIndex! < 0 ||
				config.subjectiveModelIndex! >= config.models.length)
		)
			warnings.push('主观题尚未指定有效的参与模型，将等待人工判断。');
	}
	const models = [...ai, ...ensembles.flatMap((config) => config.models)];
	for (const model of models) {
		try {
			normalizeAIEndpoint(model.endpoint);
			if (!model.model.trim()) error ||= '模型 ID 为空，请在提供商中重新配置。';
			const configurationError = getAIConfigurationError(model);
			if (configurationError) error ||= `${model.providerName || model.label || model.model}：${configurationError}`;
		} catch {
			error ||= '模型接口地址无效，请在提供商中重新配置。';
		}
	}
	for (const config of ensembles) {
		const objectiveUsesSummary = (config.rule || (config.summary ? 'confidence-then-summary' : 'confidence')).includes(
			'summary'
		);
		if (config.summary && (objectiveUsesSummary || config.subjectiveRule === 'summary')) {
			const configurationError = getAIConfigurationError(config.summary);
			if (configurationError) {
				const summaryError = `总结模型 ${config.summary.label || config.summary.model}：${configurationError}`;
				// An objective rule that never uses this model must remain runnable.
				// The subjective route validates its summary again before any requests.
				if (objectiveUsesSummary) error ||= summaryError;
				else warnings.push('主观题：' + summaryError);
			}
		}
	}
	const groupedModels = new Map<string, { name: string; count: number }>();
	for (const model of models) {
		const key = JSON.stringify([model.sourceId || '', model.endpoint, model.model]);
		const group = groupedModels.get(key) || { name: model.label || model.model, count: 0 };
		group.count++;
		groupedModels.set(key, group);
	}
	const names = [...groupedModels.values()].map((group) =>
		ensembles.length ? `${group.name} × ${group.count}` : group.name
	);
	const baseCalls = models.length;
	const summaryCalls = ensembles.filter(
		(config) => config.summary && (config.rule?.includes('summary') || config.subjectiveRule === 'summary')
	).length;
	const threads = Number.isInteger(options.thread) && options.thread! > 0 ? options.thread! : 1;
	const objectiveNames: Record<string, string> = {
		manual: '全部人工判断',
		unanimous: '仅全票一致自动填写',
		confidence: '按一致率阈值选择',
		summary: '每题由总结模型决定',
		'confidence-then-summary': '先一致率，未达标再总结',
		'summary-then-confidence': '先总结，失败再按一致率'
	};
	const config = ensembles[0];
	const objective = config
		? `${objectiveNames[config.rule || 'confidence'] || '规则需检查'}${
				config.rule?.includes('confidence') ? `（${config.threshold ?? 100}%）` : ''
		  }`
		: '采用当前普通模式模型的答案';
	const subjective = config
		? config.subjectiveRule === 'selected'
			? config.models[config.subjectiveModelIndex!]
				? '采用 ' +
				  (config.models[config.subjectiveModelIndex!].label || config.models[config.subjectiveModelIndex!].model) +
				  ' 的回答'
				: '指定模型需检查，将交给人工判断'
			: config.subjectiveRule === 'summary'
			? '由总结模型决定'
			: '全部人工判断'
		: '按实际填写位置匹配答案';
	return {
		ready: !error,
		error,
		warnings,
		isAI,
		advanced: ensembles.length > 0 || options.aiAnswerMode === 'advanced',
		names,
		baseCalls,
		summaryCalls,
		threads,
		maxRequests: threads * Math.max(baseCalls, summaryCalls),
		objective,
		subjective
	};
}

export function createAIWorkSummary(options: {
	read: () => AIWorkStatusOptions;
	observe: (listener: () => void) => () => void;
}): HTMLElement {
	const root = h('section', {
		className: 'ai-work-summary',
		role: 'status',
		style: {
			flexBasis: '100%',
			width: '100%',
			maxWidth: 'min(440px, calc(100vw - 190px))',
			minWidth: '0',
			padding: '12px 14px',
			border: '1px solid #4263eb30',
			borderRadius: '10px',
			background: '#4263eb06',
			font: '13px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif',
			whiteSpace: 'normal',
			overflowWrap: 'anywhere'
		}
	});
	const render = () => {
		const state = inspectAIWorkConfiguration(options.read());
		root.replaceChildren(
			h(
				'strong',
				`${state.isAI ? (state.advanced ? '高级模式' : '普通模式') : '题库模式'} · ${
					state.ready ? (state.warnings.length ? '部分规则需检查' : '已就绪') : '尚未就绪'
				}`
			),
			...(state.error ? [h('div', { style: { color: '#c0392b' } }, state.error)] : []),
			...(state.isAI && state.names.length ? [h('div', '参与模型：' + state.names.join('、'))] : []),
			...(state.isAI && state.ready
				? [
						h(
							'div',
							`每题 ${state.baseCalls} 次基础作答${
								state.summaryCalls ? `，最多另有 ${state.summaryCalls} 次总结` : '，不调用总结模型'
							}`
						),
						h('div', `同时处理 ${state.threads} 题 · 最多 ${state.maxRequests} 个在途 AI 请求`),
						...(state.advanced ? [h('div', '客观题：' + state.objective), h('div', '主观题：' + state.subjective)] : [])
				  ]
				: []),
			...state.warnings.map((warning) => h('div', { style: { color: '#916209' } }, warning))
		);
	};
	render();
	const stop = options.observe(() => {
		if (!root.isConnected) stop();
		else render();
	});
	return root;
}
