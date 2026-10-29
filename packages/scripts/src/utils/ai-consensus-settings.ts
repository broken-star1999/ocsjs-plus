import type { AIProviderSource, AIModelThreads, AIEnsembleRule } from '@ocsjs/core';
import { createAIAnswererWrappers } from '@ocsjs/core';
import { h, $modal } from 'easy-us';

export interface AIConsensusSettings {
	mode: 'basic' | 'advanced';
	assignments: AIModelThreads[];
	threshold: number;
	confidenceEnabled: boolean;
	rule: AIEnsembleRule;
	summaryEnabled: boolean;
	summaryKey: string;
	sources: AIProviderSource[];
}

export interface AIConsensusSettingsAccess {
	read: () => AIConsensusSettings;
	write: (patch: Partial<AIConsensusSettings>) => void;
	observe: (listener: () => void) => () => void;
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
.ai-consensus-settings .ensemble-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.ai-consensus-settings .ensemble-switch{display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:12px}
.ai-consensus-settings .ensemble-field{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ai-consensus-settings .ensemble-picker{width:100%;margin:0}
.ai-consensus-settings .ensemble-rule-label{display:block;margin-bottom:8px;color:#718096;font-size:12px}
@media(max-width:620px){.ai-consensus-settings .ensemble-grid{grid-template-columns:1fr;gap:0}.ai-consensus-settings .ensemble-heading{align-items:flex-start;flex-direction:column}.ai-consensus-settings .ensemble-model-row{padding:9px 7px;gap:8px}}
`;
/* eslint-enable max-len */

const decisionRules: [AIEnsembleRule, string][] = [
	['manual', '全部人工判断'],
	['unanimous', '仅全票一致自动填写'],
	['confidence', '仅按置信度阈值'],
	['summary', '每题由总结模型决定'],
	['confidence-then-summary', '先置信度，未达标再总结'],
	['summary-then-confidence', '先总结，失败再按置信度']
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
		const total = state.assignments.reduce((sum, item) => sum + item.threads, 0);
		const modelCard = h('section', { className: 'ensemble-card' }, [
			h('div', { className: 'ensemble-heading' }, [
				h('h3', '参与模型'),
				h('strong', { className: 'ensemble-count' }, `已选 ${state.assignments.length} 个模型 · 每题 ${total} 次作答`)
			]),
			list,
			h(
				'p',
				{ className: 'ensemble-note' },
				'至少配置 2 次作答，每个模型可设 1–8 次。仅选一个模型并增加次数，即为单模型并发；原“答题线程数”控制同时处理几道题。'
			)
		]);
		root.append(modelCard);
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
		threshold.setAttribute('aria-label', '置信度阈值（一致率）');
		threshold.disabled = !state.confidenceEnabled;
		const confidence = h('input', { type: 'checkbox' });
		confidence.className = 'ensemble-toggle';
		confidence.checked = state.confidenceEnabled;
		confidence.setAttribute('aria-label', '启用置信度选择');
		confidence.onchange = () =>
			options.write({
				confidenceEnabled: confidence.checked,
				rule: keepAvailableRule(state.rule, confidence.checked, state.summaryEnabled)
			});
		threshold.onchange = () => options.write({ threshold: Number(threshold.value) });
		grid.append(
			h('section', { className: 'ensemble-card' }, [
				h('div', { className: 'ensemble-heading' }, [h('h3', '自动选择')]),
				h('label', { className: 'ensemble-switch' }, [confidence, ' 启用置信度选择']),
				h('label', { className: 'ensemble-field' }, ['一致率阈值 ', threshold, ' %']),
				h(
					'p',
					{ className: 'ensemble-note' },
					'例如 4 次回答中 3 次相同为 75%。失败和无效回答也计入总次数；这是回答一致率，不代表实际正确概率。填空、简答仍要求答案全部相同。'
				)
			])
		);
		const summary = h('input', { type: 'checkbox' });
		summary.className = 'ensemble-toggle';
		summary.checked = state.summaryEnabled;
		summary.setAttribute('aria-label', '启用总结模型');
		summary.onchange = () =>
			options.write({
				summaryEnabled: summary.checked,
				rule: keepAvailableRule(state.rule, state.confidenceEnabled, summary.checked)
			});
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
				h('div', { className: 'ensemble-heading' }, [h('h3', '总结模型')]),
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
		const rule = h('select');
		rule.className = 'ensemble-picker';
		rule.setAttribute('aria-label', '决策规则');
		for (const [value, label] of availableDecisionRules(state.confidenceEnabled, state.summaryEnabled))
			rule.append(h('option', { value }, label));
		rule.value = keepAvailableRule(state.rule, state.confidenceEnabled, state.summaryEnabled);
		rule.onchange = () => options.write({ rule: rule.value as AIEnsembleRule });
		root.append(
			h('section', { className: 'ensemble-card' }, [
				h('div', { className: 'ensemble-heading' }, [h('h3', '决策规则')]),
				rule,
				h(
					'p',
					{ className: 'ensemble-note' },
					'规则未获得有效答案时交给人工。选择“仅全票一致”或“全部人工”时，不调用总结模型。'
				)
			])
		);
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
		let refresh = () => {};
		const content = createAIConsensusSettings({
			read: () => ({ ...draft, mode: 'advanced' }),
			write: (patch) => {
				draft = { ...draft, ...patch };
				refresh();
			},
			observe: (listener) => {
				refresh = listener;
				return () => {};
			}
		});
		Object.assign(content.style, {
			maxWidth: 'none',
			marginTop: '0',
			maxHeight: '68vh',
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
					rule: draft.rule
				}
			)[0].aiEnsemble!;
			const thresholdInvalid =
				draft.rule.includes('confidence') &&
				(!Number.isFinite(draft.threshold) || draft.threshold < 50 || draft.threshold > 100);
			if (configured.error || thresholdInvalid) {
				status.textContent = configured.error || '置信度阈值（一致率）须为 50–100%。';
				return;
			}
			options.write({
				assignments: draft.assignments,
				threshold: draft.threshold,
				confidenceEnabled: draft.confidenceEnabled,
				summaryEnabled: draft.summaryEnabled,
				summaryKey: draft.summaryKey,
				rule: draft.rule
			});
			close();
		};
		modal = $modal.simple({
			title: '高级模式设置',
			width: 880,
			content,
			footer: h('div', [
				status,
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
			])
		});
		if (modal) modal.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif';
	};
	return button;
}
