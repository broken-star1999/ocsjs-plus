import type { AIProviderSource, AIModelThreads, AIEnsembleRule, AISubjectiveRule } from '@ocsjs/core';
import { createAIAnswererWrappers } from '@ocsjs/core';
import { h, $modal } from 'easy-us';
import { describeAIConsensusPlan } from './ai-consensus-plan';

export interface AIConsensusSettings {
	mode: 'basic' | 'advanced';
	assignments: AIModelThreads[];
	threshold: number;
	confidenceEnabled: boolean;
	rule: AIEnsembleRule;
	subjectiveRule?: AISubjectiveRule;
	subjectiveKey?: string;
	summaryEnabled: boolean;
	summaryKey: string;
	sources: AIProviderSource[];
	/** Number of questions processed at once, independent of same-question model calls. */
	questionThreads?: number;
}

export interface AIConsensusSettingsAccess {
	read: () => AIConsensusSettings;
	write: (patch: Partial<AIConsensusSettings>) => void;
	observe: (listener: () => void) => () => void;
	onRuleChange?: (message: string) => void;
}

/* eslint-disable max-len */
const settingsStyle = `
.ai-consensus-settings{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:inherit}
.ai-consensus-settings *{box-sizing:border-box}
.ai-consensus-settings .ensemble-intro{margin:0 0 16px;color:#718096;font-size:13px}
.ai-consensus-settings .ensemble-card{border:1px solid #80808029;border-radius:12px;padding:16px;margin-bottom:14px;background:#80808003}
.ai-consensus-settings .ensemble-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.ai-consensus-settings h3{margin:0;font-size:15px;font-weight:650;color:inherit}
.ai-consensus-settings .ensemble-count{font-size:12px;font-weight:500;color:#4263eb;background:#4263eb0d;padding:4px 9px;border-radius:6px}
.ai-consensus-settings .ensemble-model-row{display:flex;align-items:center;gap:14px;padding:10px 12px;border:1px solid transparent;border-radius:9px;margin:6px 0;background:#80808007}
.ai-consensus-settings .ensemble-model-row.selected{border-color:#4263eb40;background:#4263eb06}
.ai-consensus-settings .ensemble-model-label{display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer}
.ai-consensus-settings .ensemble-model-copy{min-width:0;overflow-wrap:anywhere}
.ai-consensus-settings .ensemble-model-name{display:block;font-weight:600}
.ai-consensus-settings .ensemble-provider{display:block;color:#718096;font-size:12px}
.ai-consensus-settings input[type=checkbox]{accent-color:#4263eb;flex-shrink:0;width:16px;height:16px;margin:0;cursor:pointer}
.ai-consensus-settings input.ensemble-toggle{appearance:none;width:34px;height:20px;border:0;border-radius:99px;background:#cbd5e1;position:relative;transition:background .15s}
.ai-consensus-settings input.ensemble-toggle:checked{background:#4263eb}
.ai-consensus-settings input.ensemble-toggle:after{content:"";position:absolute;width:16px;height:16px;left:2px;top:2px;border-radius:50%;background:white;box-shadow:0 1px 3px #0002;transition:transform .15s}
.ai-consensus-settings input.ensemble-toggle:checked:after{transform:translateX(14px)}
.ai-consensus-settings input[type=number],.ai-consensus-settings select{font:inherit;color:inherit;border:1px solid #cdd5e0;border-radius:7px;background:transparent;padding:7px 9px;min-width:0}
.ai-consensus-settings input:focus-visible,.ai-consensus-settings select:focus-visible{outline:2px solid #4263eb60;outline-offset:2px;border-color:#4263eb}
.ai-consensus-settings input:disabled,.ai-consensus-settings select:disabled{opacity:.5;cursor:not-allowed}
.ai-consensus-settings .ensemble-count-input{display:flex;align-items:center;gap:7px;white-space:nowrap;color:#718096;font-size:12px}
.ai-consensus-settings .ensemble-count-input input{width:66px;text-align:center}
.ai-consensus-settings .ensemble-note{font-size:12px;color:#718096;margin:10px 0 0}
.ai-consensus-settings .ensemble-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.ai-consensus-settings .ensemble-grid>.ensemble-card{min-width:0}
.ai-consensus-settings .ensemble-switch{display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:12px}
.ai-consensus-settings .ensemble-field{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ai-consensus-settings .ensemble-picker{width:100%;margin:0}
.ai-consensus-settings .ensemble-rule-label{display:block;margin-bottom:8px;color:#718096;font-size:12px}
.ai-consensus-settings .ensemble-change{padding:10px 12px;border:1px solid #4263eb26;border-radius:8px;background:#4263eb08;font-size:12px;margin:0 0 14px;overflow-wrap:anywhere}
@media(max-width:620px){.ai-consensus-settings .ensemble-grid{grid-template-columns:1fr;gap:0}.ai-consensus-settings .ensemble-heading{align-items:flex-start;flex-direction:column}.ai-consensus-settings .ensemble-model-row{padding:9px 7px;gap:8px}}
`;
/* eslint-enable max-len */

const decisionRules: [AIEnsembleRule, string][] = [
	['manual', '全部人工判断'],
	['unanimous', '仅全票一致自动填写'],
	['confidence', '仅按一致率阈值'],
	['summary', '每题由总结模型决定'],
	['confidence-then-summary', '先一致率，未达标再总结'],
	['summary-then-confidence', '先总结，失败再按一致率']
];

function availableDecisionRules(confidence: boolean, summary: boolean) {
	return decisionRules.filter(
		([rule]) =>
			(!(rule === 'unanimous' || rule.includes('confidence')) || confidence) && (!rule.includes('summary') || summary)
	);
}

function keepAvailableRule(rule: AIEnsembleRule, confidence: boolean, summary: boolean): AIEnsembleRule {
	if (availableDecisionRules(confidence, summary).some(([value]) => value === rule)) return rule;
	return confidence ? (summary ? 'confidence-then-summary' : 'confidence') : summary ? 'summary' : 'manual';
}

export function createAIConsensusSettings(options: AIConsensusSettingsAccess): HTMLElement {
	let capabilityNotice = '';
	const describeRule = (rule: AIEnsembleRule) => decisionRules.find(([value]) => value === rule)?.[1] || rule;
	const changeCapability = (patch: Partial<AIConsensusSettings>, enabledName: string, enabled: boolean) => {
		const before = options.read();
		const nextRule = patch.rule || before.rule;
		const changes: string[] = [];
		if (nextRule !== before.rule) changes.push(`客观题由“${describeRule(before.rule)}”改为“${describeRule(nextRule)}”`);
		if (patch.subjectiveRule && patch.subjectiveRule !== before.subjectiveRule)
			changes.push('主观题已改为“全部人工判断”');
		capabilityNotice = `${enabled ? '已开启' : '已关闭'}${enabledName}。${
			changes.length ? changes.join('；') + '。' : '当前主客观题处理方式保持不变。'
		}保存后应用于下一次任务。`;
		options.onRuleChange?.(capabilityNotice);
		options.write(patch);
	};
	const root = h('div', {
		className: 'ai-consensus-settings',
		style: { marginTop: '8px', textAlign: 'left', maxWidth: '560px', width: '100%', minWidth: '0' }
	});
	const render = () => {
		const state = options.read();
		root.style.display = state.mode === 'advanced' ? 'block' : 'none';
		root.replaceChildren();
		if (state.mode !== 'advanced') return;
		root.append(
			h('style', settingsStyle),
			h('p', { className: 'ensemble-intro' }, '为同一道题安排独立作答，再选择如何采用这些答案。')
		);
		const list = h('div', { style: { maxHeight: '220px', overflow: 'auto' } });
		const available = new Set<string>();
		const participating: { key: string; name: string }[] = [];
		const add = (key: string, name: string, modelName?: string, provider?: string) => {
			const configured = state.assignments.find((item) => item.key === key);
			const input = h('input', { type: 'checkbox' });
			input.setAttribute('aria-label', name);
			input.checked = !!configured;
			const count = h('input', {
				type: 'number',
				min: '1',
				max: '8',
				step: '1',
				value: String(configured?.threads ?? 1),
				style: { width: '66px' }
			});
			count.setAttribute('aria-label', name + ' 同题并发数');
			count.disabled = !configured;
			input.onchange = () =>
				options.write({
					assignments: input.checked
						? [...state.assignments, { key, threads: 1 }]
						: state.assignments.filter((item) => item.key !== key)
				});
			count.onchange = () =>
				options.write({
					assignments: state.assignments.map((item) =>
						item.key === key ? { key, threads: Number(count.value) } : item
					)
				});
			list.append(
				h('div', { className: 'ensemble-model-row' + (configured ? ' selected' : '') }, [
					h('label', { className: 'ensemble-model-label' }, [
						input,
						h('span', { className: 'ensemble-model-copy' }, [
							h('span', { className: 'ensemble-model-name' }, modelName || name),
							...(provider ? [h('small', { className: 'ensemble-provider' }, provider)] : [])
						])
					]),
					h('span', { className: 'ensemble-count-input' }, [count, '次 / 题'])
				])
			);
		};
		for (const source of state.sources)
			for (const model of source.models.filter((model) => model.enabled)) {
				const key = JSON.stringify([source.id, model.id]);
				available.add(key);
				const assignment = state.assignments.find((item) => item.key === key);
				if (assignment) participating.push({ key, name: source.name + ' / ' + model.name });
				add(
					key,
					source.name + ' / ' + model.name + (model.vision ? ' · 图片' : ''),
					model.name,
					source.name + (model.vision ? ' · 支持图片' : '')
				);
			}
		state.assignments
			.filter((item) => !available.has(item.key))
			.forEach((item) => add(item.key, '已失效的模型选择（请取消）'));
		const plan = describeAIConsensusPlan(state);
		const modelCard = h('section', { className: 'ensemble-card' }, [
			h('div', { className: 'ensemble-heading' }, [
				h('h3', '参与模型'),
				h(
					'strong',
					{ className: 'ensemble-count' },
					`已选 ${state.assignments.length} 个模型 · 基础 ${plan.basicRequests ?? '待设置'} 次 / 题`
				)
			]),
			list,
			h(
				'p',
				{ className: 'ensemble-note' },
				'至少配置 2 次作答，每个模型可设 1–8 次。仅选一个模型并增加次数，即为单模型并发；原“答题线程数”控制同时处理几道题。'
			)
		]);
		root.append(modelCard);
		modelCard.append(
			h('p', { className: 'ensemble-note', dataset: { requestScale: '' } }, plan.requests + ' ' + plan.concurrency)
		);
		if (!available.size) modelCard.append(h('p', '请先在模型提供商中添加并启用模型。'));
		const grid = h('div', { className: 'ensemble-grid' });
		const threshold = h('input', {
			type: 'number',
			min: '50',
			max: '100',
			step: '1',
			value: String(state.threshold),
			style: { width: '70px' }
		});
		threshold.setAttribute('aria-label', '一致率阈值');
		threshold.disabled = !state.confidenceEnabled;
		const confidence = h('input', { type: 'checkbox' });
		confidence.className = 'ensemble-toggle';
		confidence.checked = state.confidenceEnabled;
		confidence.setAttribute('aria-label', '启用一致率选择');
		confidence.onchange = () =>
			changeCapability(
				{
					confidenceEnabled: confidence.checked,
					rule: keepAvailableRule(state.rule, confidence.checked, state.summaryEnabled)
				},
				'一致率选择',
				confidence.checked
			);
		threshold.onchange = () => options.write({ threshold: Number(threshold.value) });
		grid.append(
			h('section', { className: 'ensemble-card' }, [
				h('div', { className: 'ensemble-heading' }, [h('h3', '客观题一致率')]),
				h('label', { className: 'ensemble-switch' }, [confidence, ' 启用一致率选择']),
				h('label', { className: 'ensemble-field' }, ['一致率阈值 ', threshold, ' %']),
				h(
					'p',
					{ className: 'ensemble-note' },
					'仅用于单选、多选、判断题。例如 4 次回答中 3 次相同为 75%；失败和无效回答也计入总次数。一致率不代表实际正确概率。'
				)
			])
		);
		const summary = h('input', { type: 'checkbox' });
		summary.className = 'ensemble-toggle';
		summary.checked = state.summaryEnabled;
		summary.setAttribute('aria-label', '启用总结模型');
		summary.onchange = () =>
			changeCapability(
				{
					summaryEnabled: summary.checked,
					rule: keepAvailableRule(state.rule, state.confidenceEnabled, summary.checked),
					subjectiveRule: !summary.checked && state.subjectiveRule === 'summary' ? 'manual' : state.subjectiveRule
				},
				'总结模型',
				summary.checked
			);
		const picker = h('select');
		picker.className = 'ensemble-picker';
		picker.setAttribute('aria-label', '总结模型');
		picker.append(h('option', { value: '' }, '请选择总结模型'));
		for (const source of state.sources)
			for (const model of source.models.filter((model) => model.enabled)) {
				picker.append(h('option', { value: JSON.stringify([source.id, model.id]) }, source.name + ' / ' + model.name));
			}
		picker.value = state.summaryKey;
		picker.disabled = !state.summaryEnabled;
		picker.onchange = () => options.write({ summaryKey: picker.value });
		grid.append(
			h('section', { className: 'ensemble-card' }, [
				h('div', { className: 'ensemble-heading' }, [h('h3', '总结模型 · 两类题共用')]),
				h('label', { className: 'ensemble-switch' }, [summary, ' 启用总结模型']),
				picker,
				h(
					'p',
					{ className: 'ensemble-note' },
					'当决策规则需要总结时，额外调用一次所选模型，将题目、图片、各次答案及接口返回的思考内容发送给它。总结失败时按所选规则回退或转人工。'
				)
			])
		);
		root.append(grid);
		if (capabilityNotice) root.append(h('p', { className: 'ensemble-change', role: 'status' }, capabilityNotice));
		const rule = h('select');
		rule.className = 'ensemble-picker';
		rule.setAttribute('aria-label', '客观题决策方式');
		for (const [value, label] of availableDecisionRules(state.confidenceEnabled, state.summaryEnabled))
			rule.append(h('option', { value }, label));
		rule.value = keepAvailableRule(state.rule, state.confidenceEnabled, state.summaryEnabled);
		rule.onchange = () => options.write({ rule: rule.value as AIEnsembleRule });
		const decisions = h('div', { className: 'ensemble-grid' });
		decisions.append(
			h('section', { className: 'ensemble-card' }, [
				h('div', { className: 'ensemble-heading' }, [h('h3', '客观题决策方式')]),
				rule,
				h(
					'p',
					{ className: 'ensemble-note' },
					'适用于单选、多选、判断题。规则未获得有效答案时交给人工；本项不影响主观题处理方式。'
				)
			])
		);
		const subjective = h('select', { className: 'ensemble-picker' });
		subjective.setAttribute('aria-label', '主观题处理方式');
		subjective.append(
			h('option', { value: 'manual' }, '全部人工判断'),
			h('option', { value: 'selected' }, '采用指定回答')
		);
		if (state.summaryEnabled) subjective.append(h('option', { value: 'summary' }, '由总结模型决定'));
		subjective.value =
			state.summaryEnabled && state.subjectiveRule === 'summary'
				? 'summary'
				: state.subjectiveRule === 'selected'
				? 'selected'
				: 'manual';
		subjective.onchange = () => options.write({ subjectiveRule: subjective.value as AISubjectiveRule });
		const subjectiveCard = h('section', { className: 'ensemble-card' }, [
			h('div', { className: 'ensemble-heading' }, [h('h3', '主观题处理方式')]),
			subjective,
			h('p', { className: 'ensemble-note' }, '适用于填空、简答等填写题，不使用一致率。空位数量以网页实际填写位置为准。')
		]);
		if (subjective.value === 'selected') {
			const model = h('select', { className: 'ensemble-picker' });
			model.setAttribute('aria-label', '主观题指定模型');
			model.append(h('option', { value: '' }, '请选择一个参与模型（未指定则转人工）'));
			for (const item of participating) model.append(h('option', { value: item.key }, item.name));
			model.value = state.subjectiveKey || '';
			model.onchange = () => options.write({ subjectiveKey: model.value });
			subjectiveCard.append(
				h('label', { className: 'ensemble-rule-label', style: { marginTop: '12px' } }, ['采用的参与模型', model]),
				h(
					'p',
					{ className: 'ensemble-note' },
					'同题多次作答时，采用该模型按配置顺序的第一次回答，与返回速度无关。未指定、模型失效或该次返回失败时转人工，不自动换用其他回答。'
				)
			);
		} else if (subjective.value === 'summary') {
			subjectiveCard.append(
				h(
					'p',
					{ className: 'ensemble-note' },
					'每道主观题汇总所有参与模型的答案和思考，再由上方所选总结模型作答；总结失败则转人工。'
				)
			);
		} else {
			subjectiveCard.append(
				h(
					'p',
					{ className: 'ensemble-note' },
					'仅展示各次模型回答，不自动填写，也不调用总结模型。请在原题手动处理，再点击“我已人工处理本题”；确认前任务保持待人工状态。'
				)
			);
		}
		if (!state.summaryEnabled)
			subjectiveCard.append(h('p', { className: 'ensemble-note' }, '开启上方“启用总结模型”后，可选择总结模型方式。'));
		decisions.append(subjectiveCard);
		root.append(decisions);
	};
	render();
	const stop = options.observe(() => {
		if (!root.isConnected) stop();
		else render();
	});
	return root;
}

/** The main settings page only holds the mode picker and this entry point. */
export function createAIConsensusSettingsButton(options: AIConsensusSettingsAccess): HTMLButtonElement {
	const button = h('button', { type: 'button', className: 'base-style-button-secondary' }, '高级模式设置');
	let modal: HTMLDivElement | undefined;
	const update = () => {
		button.disabled = options.read().mode !== 'advanced';
	};
	update();
	let attached = false;
	const stop = options.observe(() => {
		if (button.isConnected) attached = true;
		else if (attached) {
			stop();
			return;
		}
		update();
	});
	button.onclick = () => {
		if (button.disabled || modal?.isConnected) return;
		let draft: AIConsensusSettings = JSON.parse(JSON.stringify(options.read()));
		draft.rule = keepAvailableRule(draft.rule, draft.confidenceEnabled, draft.summaryEnabled);
		draft.subjectiveRule =
			draft.summaryEnabled && draft.subjectiveRule === 'summary'
				? 'summary'
				: draft.subjectiveRule === 'selected'
				? 'selected'
				: 'manual';
		let refresh = () => {};
		let refreshPlan = () => {};
		const ruleNotice = h('div', {
			role: 'status',
			style: { color: '#4263eb', marginBottom: '8px', textAlign: 'left', fontSize: '12px' }
		});
		const content = createAIConsensusSettings({
			read: () => ({ ...draft, mode: 'advanced' }),
			write: (patch) => {
				draft = { ...draft, ...patch };
				refresh();
				refreshPlan();
			},
			observe: (listener) => {
				refresh = listener;
				return () => {};
			},
			onRuleChange: (message) => {
				ruleNotice.textContent = message;
			}
		});
		const executionPlan = h('div', {
			className: 'ai-consensus-execution-plan',
			style: {
				textAlign: 'left',
				fontSize: '12px',
				lineHeight: '1.6',
				padding: '10px 12px',
				margin: '8px 0 12px',
				borderRadius: '8px',
				background: '#4263eb08',
				border: '1px solid #4263eb20',
				overflowWrap: 'anywhere'
			}
		});
		refreshPlan = () => {
			const plan = describeAIConsensusPlan(draft);
			executionPlan.replaceChildren(
				h('strong', '保存后的执行计划'),
				h('div', plan.objective),
				h('div', plan.subjective),
				h('div', plan.requests),
				h('div', plan.concurrency)
			);
		};
		refreshPlan();
		Object.assign(content.style, {
			maxWidth: 'none',
			marginTop: '0',
			maxHeight: 'clamp(120px, calc(100vh - 400px), 52vh)',
			overflowY: 'auto',
			overflowX: 'hidden',
			boxSizing: 'border-box',
			padding: '0 8px 0 0'
		});
		const status = h('div', { role: 'alert', style: { color: '#c0392b', textAlign: 'left', marginBottom: '8px' } });
		status.setAttribute('role', 'alert');
		const close = () => {
			modal?.remove();
			modal = undefined;
		};
		const cancel = h('button', { type: 'button', className: 'base-style-button-secondary' }, '取消');
		Object.assign(cancel.style, { padding: '8px 16px', borderRadius: '8px', fontSize: '14px' });
		cancel.onclick = close;
		const save = h('button', { type: 'button', className: 'base-style-button' }, '保存高级设置');
		Object.assign(save.style, { padding: '8px 16px', borderRadius: '8px', fontSize: '14px' });
		save.onclick = () => {
			const configured = createAIAnswererWrappers(
				{ sources: options.read().sources, selection: '' },
				true,
				draft.assignments,
				{
					threshold: draft.threshold,
					confidenceEnabled: draft.confidenceEnabled,
					summaryEnabled: draft.summaryEnabled,
					summarySelection: draft.summaryKey,
					rule: draft.rule,
					subjectiveRule: draft.subjectiveRule,
					subjectiveSelection: draft.subjectiveKey
				}
			)[0].aiEnsemble!;
			const thresholdInvalid =
				draft.rule.includes('confidence') &&
				(!Number.isFinite(draft.threshold) || draft.threshold < 50 || draft.threshold > 100);
			const configurationError = configured.error || configured.objectiveError || configured.summaryError;
			if (configurationError || thresholdInvalid) {
				status.textContent = (configurationError || '一致率阈值须为 50–100%。')
					.replace(/置信度阈值（一致率）/g, '一致率阈值')
					.replace(/置信度/g, '一致率');
				return;
			}
			options.write({
				assignments: draft.assignments,
				threshold: draft.threshold,
				confidenceEnabled: draft.confidenceEnabled,
				summaryEnabled: draft.summaryEnabled,
				summaryKey: draft.summaryKey,
				rule: draft.rule,
				subjectiveRule: draft.subjectiveRule,
				subjectiveKey: draft.subjectiveKey || ''
			});
			close();
		};
		modal = $modal.simple({
			title: '高级模式设置',
			width: 880,
			content,
			footer: h(
				'div',
				{
					style: {
						width: '100%',
						minWidth: '0',
						whiteSpace: 'normal',
						fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif'
					}
				},
				[
					status,
					ruleNotice,
					executionPlan,
					h(
						'div',
						{
							style: {
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								gap: '12px',
								flexWrap: 'wrap'
							}
						},
						[
							h('small', { style: { color: '#718096' } }, '保存后应用于下一次任务，取消将放弃本次修改'),
							h('div', [cancel, ' ', save])
						]
					)
				]
			)
		});
		if (modal) {
			modal.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif';
			const dialog = modal.querySelector<HTMLElement>('modal-element');
			if (dialog) Object.assign(dialog.style, { maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box' });
		}
	};
	return button;
}
