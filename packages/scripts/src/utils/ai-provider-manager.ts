/* global GM_getValue, GM_setValue, GM_deleteValue, GM_listValues */
import { h, $modal } from 'easy-us';
import { AI_PROVIDER_ICONS } from './ai-provider-icons';
import {
	AIProviderState,
	AIProviderSource,
	AIConfiguredModel,
	AIModel,
	AI_API_KEY_STORAGE,
	aiModelKey,
	getAIKeyStorage,
	listAIModels,
	normalizeAIEndpoint,
	searchAIAnswer,
	saveAISource,
	saveAIModel,
	deleteAISource,
	deleteAIModel,
	validateAIExtraBody
} from '@ocsjs/core';

export interface AIProviderManagerOptions {
	read: () => AIProviderState;
	write: (state: AIProviderState) => void;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const providerCards = [
	{
		id: 'deepseek',
		name: 'DeepSeek',
		endpoint: 'https://api.deepseek.com',
		description: 'DeepSeek 官方接口',
		keywords: 'ds 深度求索'
	},
	{
		id: 'mimo',
		name: 'MiMo',
		endpoint: 'https://api.xiaomimimo.com/v1',
		description: '小米 MiMo 官方接口',
		keywords: '小米 xiaomi'
	},
	{
		id: 'openai',
		name: 'OpenAI',
		endpoint: 'https://api.openai.com/v1',
		description: 'OpenAI 官方接口',
		keywords: 'gpt chatgpt'
	},
	{
		id: 'custom',
		name: '自定义',
		endpoint: '',
		description: 'OpenAI 兼容服务或自建网关',
		keywords: 'custom compatible 中转 本地'
	}
] as const;
/* eslint-disable max-len */
const style = `
.ocs-ai-manager{font:14px system-ui;color:inherit;min-height:420px}
.ocs-ai-manager *{box-sizing:border-box}.ocs-ai-manager button{cursor:pointer}
.ocs-ai-manager .workbench{display:grid;grid-template-columns:285px minmax(0,1fr);gap:24px;height:66vh;max-height:650px;overflow:hidden}
.ocs-ai-manager .workbench>section{overflow:auto;min-width:0;padding-right:4px}
.ocs-ai-manager .source-detail-heading{position:sticky;top:0;z-index:2;background:#fff;border-bottom:1px solid #8080801a;padding-bottom:8px}
.ocs-ai-manager aside{border-right:1px solid #80808026;padding-right:16px;overflow:auto;min-width:0}
.ocs-ai-manager small{display:block;color:#718096;word-break:break-all;margin-top:5px}
.ocs-ai-manager .source-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 12px 18px}
.ocs-ai-manager .source-heading strong{font-size:17px}.ocs-ai-manager .source-add{display:flex;align-items:center;gap:7px;border:0;background:transparent;color:#4296d4;padding:7px 2px;font:inherit}
.ocs-ai-manager .source-add span{font-size:22px;line-height:1}.ocs-ai-manager .source-row{position:relative;border-radius:14px;margin:4px 0;transition:background .15s}
.ocs-ai-manager .source-row:hover{background:#8080800d}.ocs-ai-manager .source-row.selected{background:#80808018}
.ocs-ai-manager .source{display:flex;align-items:center;gap:13px;width:100%;min-height:84px;text-align:left;padding:16px 44px 16px 12px;border:0;border-radius:14px;background:transparent;color:inherit;font:inherit}
.ocs-ai-manager .source:focus-visible,.ocs-ai-manager .source-remove:focus-visible,.ocs-ai-manager .source-add:focus-visible{outline:2px solid #4263eb;outline-offset:-2px}
.ocs-ai-manager .source-icon{display:grid;place-items:center;flex:0 0 32px;width:32px;height:32px}.ocs-ai-manager .source-icon svg{display:block;width:100%;height:100%}
.ocs-ai-manager .source-icon.mimo{font-size:23px;font-weight:700;color:#ff6900}.ocs-ai-manager .source-icon.custom{font-size:28px;color:#718096}
.ocs-ai-manager .source-copy{display:block;flex:1;min-width:0}.ocs-ai-manager .source-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:700;line-height:1.5}
.ocs-ai-manager .source-url{display:block;margin-top:4px;color:#80838c;font-size:12px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:normal}
.ocs-ai-manager .source-draft{display:block;font-size:11px;color:#4296d4;margin-top:3px}
.ocs-ai-manager .source-remove{position:absolute;right:8px;top:50%;transform:translateY(-50%);display:grid;place-items:center;width:30px;height:34px;border:0;border-radius:7px;background:transparent;color:inherit;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .15s}
.ocs-ai-manager .source-remove svg{width:17px;height:17px}.ocs-ai-manager .source-row.selected .source-remove,.ocs-ai-manager .source-row:hover .source-remove,.ocs-ai-manager .source-row:focus-within .source-remove{opacity:1;visibility:visible;pointer-events:auto}
.ocs-ai-manager .source-remove:hover{color:#e25b58;background:#e25b5812}
.ocs-ai-manager .toolbar,.ocs-ai-manager .model-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ocs-ai-manager .toolbar{justify-content:space-between;margin-bottom:14px}.ocs-ai-manager h3{margin:12px 0;font-size:16px}
.ocs-ai-manager .model-controls{display:flex;gap:8px;flex-wrap:wrap}
.ocs-ai-manager .field{display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px;align-items:center;margin:12px 0}
.ocs-ai-manager .field input,.ocs-ai-manager .field select,.ocs-ai-manager textarea,.ocs-ai-manager .search{width:100%;min-width:0;padding:8px;border:1px solid #cdd5e0;border-radius:7px;color:inherit;background:transparent}
.ocs-ai-manager .actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.ocs-ai-manager .model-row{border-top:1px solid #e2e8f0;padding:10px 0;flex-wrap:nowrap}
.ocs-ai-manager .model-name{flex:1;min-width:0;overflow-wrap:anywhere}.ocs-ai-manager .badge{font-size:12px;color:#4263eb;margin-left:8px}
.ocs-ai-manager .status{padding:10px 12px;background:#4263eb0d;border-radius:7px;margin-bottom:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.ocs-ai-manager .error{color:#c0392b}.ocs-ai-manager .muted{color:#718096}.ocs-ai-manager .danger{color:#c0392b}
.ocs-ai-manager .empty{padding:30px 8px;color:#718096}.ocs-ai-manager .model-row button{white-space:nowrap}
.ocs-ai-picker{min-height:0}.ocs-ai-picker .picker-heading{display:flex;justify-content:space-between;align-items:center;margin:18px 0 12px}
.ocs-ai-picker .provider-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;max-height:52vh;overflow:auto;padding:2px}
.ocs-ai-picker .provider-card{display:flex;align-items:center;gap:14px;text-align:left;min-height:100px;padding:18px;border:1px solid #dce3ed;border-radius:12px;color:inherit;background:transparent;transition:border-color .15s,background .15s}
.ocs-ai-picker .provider-card:hover,.ocs-ai-picker .provider-card:focus-visible{border-color:#4263eb;background:#4263eb0d;outline:2px solid #4263eb33;outline-offset:1px}
.ocs-ai-picker .provider-card strong{font-size:16px}.ocs-ai-picker .provider-card small{margin-top:6px;word-break:normal;line-height:1.5}
.ocs-ai-picker .provider-icon{display:grid;place-items:center;flex:0 0 42px;width:42px;height:42px;border-radius:12px;font-size:18px;font-weight:700;background:#4263eb12;color:#4263eb}
.ocs-ai-picker .provider-icon.mimo{background:#ff690014;color:#e65e00;font-size:24px}.ocs-ai-picker .provider-icon.openai{background:#10977f14;color:#10977f}.ocs-ai-picker .provider-icon.custom{background:#71809614;color:#718096;font-size:28px;font-weight:400}
.ocs-ai-picker .picker-note{margin:16px 0 0;line-height:1.6}.ocs-ai-picker .picker-empty{grid-column:1/-1;padding:28px 8px;text-align:center}
@media(max-width:700px){.ocs-ai-manager .workbench{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.ocs-ai-manager aside{border:0;max-height:130px}.ocs-ai-manager .field{grid-template-columns:1fr;gap:4px}.ocs-ai-manager .model-row{flex-wrap:wrap}}
@media(max-width:480px){.ocs-ai-picker .provider-grid{grid-template-columns:1fr}.ocs-ai-picker .provider-card{min-height:80px;padding:12px}}
@media(hover:none){.ocs-ai-manager .source-remove{opacity:1;visibility:visible;pointer-events:auto}}
`;
/* eslint-enable max-len */

/** Independent, code-native workbench: source connections, configured models, then task selection. */
export function openAIProviderManager(options: AIProviderManagerOptions) {
	let selectedId = options.read().sources[0]?.id || '';
	let draft: AIProviderSource | undefined;
	let dirty = false;
	let clearKey = false;
	const requests = new Map<string, number>();
	const root = h('div', { className: 'ocs-ai-manager' });
	const sidebar = h('aside');
	const detail = h('section');
	const status = h('div', {
		className: 'status',
		role: 'status',
		textContent: '先配置提供商源，再添加模型，最后选择用于答题的模型。'
	});
	root.append(h('style', style), status, h('div', { className: 'workbench' }, [sidebar, detail]));
	let nameInput: HTMLInputElement;
	let endpointInput: HTMLInputElement;
	let timeoutInput: HTMLInputElement;
	let keyInput: HTMLInputElement;

	const notify = (text: string, error = false) => {
		status.textContent = text;
		status.classList.toggle('error', error);
	};
	const button = (label: string, action: () => void | Promise<void>, primary = false) => {
		const node = h(
			'button',
			{ type: 'button', className: primary ? 'base-style-button' : 'base-style-button-secondary' },
			label
		);
		node.onclick = async () => {
			node.disabled = true;
			try {
				await action();
			} catch (error) {
				notify(error instanceof Error ? error.message : '操作失败', true);
			} finally {
				node.disabled = false;
			}
		};
		return node;
	};
	const field = (label: string, input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
		input.setAttribute('aria-label', label);
		return h('label', { className: 'field' }, [h('span', label), input]);
	};
	const providerIcon = (preset: string) => {
		const icon = h('span', { className: 'source-icon ' + preset, ariaHidden: 'true' });
		if (preset === 'mimo' || preset === 'custom') icon.textContent = preset === 'mimo' ? 'mi' : '+';
		else icon.innerHTML = AI_PROVIDER_ICONS[preset === 'deepseek' ? 'deepseek' : 'openai'];
		return icon;
	};
	const confirm = (message: string, action: () => void) =>
		$modal.confirm({ title: '确认操作', content: h('p', message), onConfirm: action });
	const select = (source?: AIProviderSource) => {
		if (source && source.id === selectedId) return;
		const apply = () => {
			selectedId = source?.id || '';
			draft = source ? clone(source) : undefined;
			dirty = !!source && !options.read().sources.some((item) => item.id === source.id);
			clearKey = false;
			render();
			detail.scrollTop = 0;
			notify(source ? '正在配置：' + source.name + (dirty ? '（未保存）' : '') : '请选择或新增提供商源。');
		};
		if (dirty) confirm('当前提供商有未保存的修改，放弃这些修改并切换？', apply);
		else apply();
	};
	const chooseProvider = () => {
		const picker = h('div', { className: 'ocs-ai-manager ocs-ai-picker' });
		const search = h('input', { className: 'search', placeholder: '搜索供应商', ariaLabel: '搜索供应商' });
		const grid = h('div', { className: 'provider-grid' });
		const count = h('span', { className: 'muted', role: 'status' });
		const renderCards = () => {
			const term = search.value.trim().toLowerCase();
			const cards = providerCards.filter((card) =>
				`${card.name} ${card.description} ${card.keywords}`.toLowerCase().includes(term)
			);
			count.textContent = `${cards.length} 个`;
			grid.replaceChildren(
				...cards.map((card) => {
					const node = button(card.name, () => {
						dialog?.remove();
						const baseName = card.id === 'custom' ? '自定义提供商' : card.name;
						const names = new Set(options.read().sources.map((source) => source.name.toLowerCase()));
						let name: string = baseName;
						for (let suffix = 1; names.has(name.toLowerCase()); suffix++) name = baseName + '_' + suffix;
						select({
							id: 'source-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
							name,
							preset: card.id === 'custom' ? 'openai' : card.id,
							endpoint: card.endpoint,
							timeoutSeconds: 120,
							models: [],
							catalog: []
						});
					});
					node.className = 'provider-card';
					node.setAttribute('aria-label', card.name);
					const icon = providerIcon(card.id);
					icon.classList.add('provider-icon');
					node.replaceChildren(icon, h('span', {}, [h('strong', card.name), h('small', card.description)]));
					return node;
				})
			);
			if (!cards.length) grid.append(h('p', { className: 'muted picker-empty' }, '未找到供应商，请尝试其他关键词'));
		};
		search.oninput = renderCards;
		renderCards();
		picker.append(
			h('style', style),
			search,
			h('div', { className: 'picker-heading' }, [h('strong', '选择供应商'), count]),
			grid,
			h('p', { className: 'muted picker-note' }, '选择供应商后，填写 API Key 并获取模型；自定义支持 OpenAI 兼容服务。')
		);
		const dialog: HTMLDivElement | undefined = $modal.simple({
			title: '新增模型提供商',
			width: 740,
			content: picker,
			footer: h('div', {}, [button('取消', () => dialog?.remove())])
		});
	};
	const saveDraft = (): AIProviderSource => {
		if (!draft) throw new Error('请先选择或新增提供商');
		const old = options.read().sources.find((source) => source.id === draft!.id);
		const next: AIProviderSource = {
			...draft,
			name: nameInput.value,
			endpoint: endpointInput.value,
			timeoutSeconds: Number(timeoutInput.value),
			models: old?.models || draft.models,
			catalog: old?.catalog || draft.catalog
		};
		const state = saveAISource(options.read(), next);
		const storage = getAIKeyStorage(next.endpoint, next.id);
		if (keyInput.value.trim()) GM_setValue(storage, keyInput.value.trim());
		else if (clearKey) GM_deleteValue(storage);
		keyInput.value = '';
		requests.set(next.id, (requests.get(next.id) || 0) + 1);
		options.write(state);
		draft = clone(state.sources.find((source) => source.id === next.id)!);
		dirty = false;
		clearKey = false;
		render();
		return draft;
	};
	const fetchModels = async () => {
		const source = saveDraft();
		const requestId = (requests.get(source.id) || 0) + 1;
		requests.set(source.id, requestId);
		notify('正在获取 ' + source.name + ' 的模型列表…');
		try {
			const catalog = await listAIModels(source.endpoint, source.id);
			const state = options.read();
			const current = state.sources.find((item) => item.id === source.id);
			if (
				!root.isConnected ||
				!current ||
				requests.get(source.id) !== requestId ||
				normalizeAIEndpoint(current.endpoint) !== normalizeAIEndpoint(source.endpoint)
			)
				return;
			options.write(saveAISource(state, { ...current, catalog }));
			if (selectedId === source.id && !dirty) {
				draft = clone(options.read().sources.find((item) => item.id === source.id)!);
				render();
				notify(`已获取 ${source.name} 的 ${catalog.length} 个候选模型。点击“添加”后才会成为可选的答题模型。`);
			}
		} catch (error) {
			if (selectedId === source.id && requests.get(source.id) === requestId) {
				notify(
					(error instanceof Error ? error.message : '获取失败') + '\n已配置模型仍保留；也可以手动添加模型 ID。',
					true
				);
			}
		}
	};
	const editModel = (existing?: AIConfiguredModel) => {
		const source = saveDraft();
		const id = h('input', { value: existing?.id || '', readOnly: !!existing });
		const name = h('input', { value: existing?.name || '' });
		const enabled = h('input', { type: 'checkbox', checked: existing?.enabled ?? true });
		const vision = h('input', { type: 'checkbox', checked: existing?.vision || false });
		const extra = h('textarea', { value: JSON.stringify(existing?.extraBody || {}, null, 2), rows: 5 });
		const error = h('p', { className: 'error', role: 'alert' });
		$modal.confirm({
			title: existing ? '编辑模型' : '手动添加模型',
			width: 600,
			content: h('div', { className: 'ocs-ai-manager' }, [
				h('style', style),
				field('模型 ID', id),
				field('显示名称', name),
				field('启用模型', enabled),
				field('允许图片输入', vision),
				field('额外请求参数', extra),
				h('small', 'JSON 对象，例如 {"temperature":0.2}。支持推理强度、输出长度等参数。'),
				error
			]),
			onConfirm: () => {
				try {
					const extraBody = validateAIExtraBody(JSON.parse(extra.value));
					options.write(
						saveAIModel(options.read(), source.id, {
							id: id.value,
							name: name.value,
							enabled: enabled.checked,
							vision: vision.checked,
							extraBody
						})
					);
					draft = clone(options.read().sources.find((item) => item.id === source.id)!);
					render();
					notify('模型已保存。可在模型行点击“用于答题”。');
				} catch (err) {
					error.textContent = err instanceof Error ? err.message : '模型参数格式错误';
					return false;
				}
			}
		});
	};
	const testModel = async (model: AIConfiguredModel) => {
		const source = saveDraft();
		notify('正在测试 ' + source.name + ' / ' + model.id + '…');
		const info = await searchAIAnswer(
			{
				endpoint: source.endpoint,
				providerName: source.name,
				sourceId: source.id,
				model: model.id,
				vision: model.vision,
				extraBody: model.extraBody,
				timeoutSeconds: source.timeoutSeconds
			},
			{ title: '1 + 1 等于多少？', options: '1\n2\n3\n4', type: 'single' },
			source.timeoutSeconds * 1000
		);
		if (selectedId === source.id) notify(info.error || '测试完成，模型返回：' + info.results[0]?.answer, !!info.error);
	};
	const renderModels = (source: AIProviderSource) => {
		const list = h('div');
		const search = h('input', { className: 'search', placeholder: '搜索模型名称或 ID', ariaLabel: '搜索模型' });
		const configured = h('div');
		const available = h('div');
		const renderRows = () => {
			const term = search.value.toLowerCase();
			const matches = (model: AIModel) => (model.name + ' ' + model.id).toLowerCase().includes(term);
			configured.replaceChildren(
				...source.models.filter(matches).map((model) => {
					const key = aiModelKey(source.id, model.id);
					const toggle = h('input', { type: 'checkbox', checked: model.enabled, ariaLabel: '启用 ' + model.id });
					toggle.onchange = () => {
						saveDraft();
						options.write(saveAIModel(options.read(), source.id, { ...model, enabled: toggle.checked }));
						draft = clone(options.read().sources.find((item) => item.id === source.id)!);
						render();
						notify(toggle.checked ? '模型已启用，可以选择用于答题。' : '模型已停用；若它是当前答题模型，选择已清空。');
					};
					return h('div', { className: 'model-row' }, [
						h('div', { className: 'model-name' }, [
							h('strong', model.name),
							h('small', source.name + ' / ' + model.id),
							h('span', { className: 'badge' }, model.vision ? '文字 · 图片' : '文字')
						]),
						toggle,
						button(options.read().selection === key ? '当前答题模型' : '用于答题', () => {
							saveDraft();
							if (!model.enabled) throw new Error('请先启用此模型');
							options.write({ ...options.read(), selection: key });
							render();
							notify('答题模型已切换，重新开始答题后生效。');
						}),
						button('测试', () => testModel(model)),
						button('编辑', () => editModel(model)),
						button('删除', () => {
							confirm('删除模型 ' + model.id + '？', () => {
								saveDraft();
								options.write(deleteAIModel(options.read(), source.id, model.id));
								draft = clone(options.read().sources.find((item) => item.id === source.id)!);
								render();
							});
						})
					]);
				})
			);
			const candidates = source.catalog
				.filter((model) => !source.models.some((item) => item.id === model.id))
				.filter(matches);
			available.replaceChildren(
				...candidates.map((model) =>
					h('div', { className: 'model-row' }, [
						h('div', { className: 'model-name' }, [
							h('strong', model.name),
							h('small', model.id + (model.vision ? ' · 支持图片' : ''))
						]),
						button('添加', () => {
							saveDraft();
							options.write(
								saveAIModel(options.read(), source.id, {
									...model,
									enabled: true,
									vision: !!model.vision,
									extraBody: {}
								})
							);
							draft = clone(options.read().sources.find((item) => item.id === source.id)!);
							render();
							notify('模型已添加，请选择用于答题的模型。');
						})
					])
				)
			);
			if (!configured.childNodes.length) configured.append(h('p', { className: 'muted' }, '尚无已配置模型'));
			if (!available.childNodes.length)
				available.append(h('p', { className: 'muted' }, '暂无候选模型，可获取列表或手动添加'));
		};
		search.oninput = renderRows;
		list.append(
			h('div', { className: 'toolbar' }, [
				h('h3', '模型'),
				h('div', { className: 'model-controls' }, [
					button('保存并获取模型', fetchModels, true),
					button('手动添加模型', () => editModel())
				])
			]),
			search,
			h('h3', '已配置模型'),
			configured,
			h('h3', '候选模型'),
			available
		);
		renderRows();
		return list;
	};
	const removeSource = (source: AIProviderSource) => {
		const saved = options.read().sources.some((item) => item.id === source.id);
		confirm(saved ? '删除提供商 ' + source.name + ' 及其模型？' : '放弃新提供商 ' + source.name + ' 的配置？', () => {
			if (saved) {
				options.write(deleteAISource(options.read(), source.id));
				requests.delete(source.id);
				const prefix = AI_API_KEY_STORAGE + ':' + encodeURIComponent(source.id) + ':';
				for (const key of GM_listValues()) if (key.startsWith(prefix)) GM_deleteValue(key);
			}
			if (source.id === selectedId) {
				dirty = false;
				select(options.read().sources[0]);
			} else renderSidebar();
			notify(saved ? '提供商已删除' : '已放弃新增提供商');
		});
	};
	function renderSidebar() {
		const state = options.read();
		const sources = [...state.sources];
		if (draft && !sources.some((source) => source.id === draft!.id)) sources.push(draft);
		const add = button('新增', chooseProvider);
		add.className = 'source-add';
		add.prepend(h('span', { ariaHidden: 'true' }, '+'));
		sidebar.replaceChildren(
			h('div', { className: 'source-heading' }, [h('strong', '提供商源'), add]),
			...sources.map((source) => {
				const node = button(source.name, () => select(source));
				node.className = 'source';
				node.setAttribute('aria-label', '选择提供商 ' + source.name);
				node.setAttribute('aria-pressed', String(source.id === selectedId));
				const saved = state.sources.some((item) => item.id === source.id);
				node.replaceChildren(
					providerIcon(source.preset),
					h('span', { className: 'source-copy' }, [
						h('strong', { className: 'source-name', title: source.name }, source.name),
						h('span', { className: 'source-url', title: source.endpoint }, source.endpoint || '待填写接口地址'),
						...(!saved ? [h('span', { className: 'source-draft' }, '未保存')] : [])
					])
				);
				const remove = button('', () => removeSource(source));
				remove.className = 'source-remove';
				const label = (saved ? '删除提供商 ' : '放弃新增 ') + source.name;
				remove.setAttribute('aria-label', label);
				remove.title = label;
				remove.innerHTML =
					'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
				return h('div', { className: 'source-row' + (source.id === selectedId ? ' selected' : '') }, [node, remove]);
			})
		);
	}
	function render() {
		const state = options.read();
		renderSidebar();
		if (!draft) {
			detail.replaceChildren(h('p', { className: 'empty' }, '选择一个提供商源，或点击“＋ 新增”开始配置。'));
			return;
		}
		nameInput = h('input', { value: draft.name });
		endpointInput = h('input', { value: draft.endpoint, placeholder: 'https://api.example.com/v1' });
		timeoutInput = h('input', { type: 'number', min: '10', max: '180', value: String(draft.timeoutSeconds) });
		keyInput = h('input', {
			type: 'password',
			autocomplete: 'new-password',
			placeholder: '输入 API Key；留空保留已有密钥'
		});
		let hasKey = false;
		try {
			hasKey = !!GM_getValue(getAIKeyStorage(draft.endpoint, draft.id), '');
		} catch {
			/* New source */
		}
		for (const input of [nameInput, endpointInput, timeoutInput, keyInput])
			input.oninput = () => {
				dirty = true;
			};
		const keyStatus = h(
			'small',
			hasKey ? '当前接口已保存密钥，留空即可保留。' : '当前接口尚未设置密钥。本地无鉴权服务可留空。'
		);
		const saved = state.sources.find((source) => source.id === draft!.id);
		const heading = h('h3', draft.name + (saved ? '' : '（未保存）'));
		nameInput.oninput = () => {
			dirty = true;
			if (draft && !saved) {
				draft.name = nameInput.value;
				heading.textContent = draft.name + '（未保存）';
				renderSidebar();
			}
		};
		detail.replaceChildren(
			h('div', { className: 'toolbar source-detail-heading' }, [
				heading,
				button(
					'保存配置',
					() => {
						saveDraft();
						notify('提供商配置已保存');
					},
					true
				)
			]),
			field('提供商名称', nameInput),
			field('API Key', keyInput),
			keyStatus,
			field('API Base URL', endpointInput),
			field('超时（秒）', timeoutInput),
			h('div', { className: 'actions' }, [
				button('清除密钥', () => {
					clearKey = true;
					dirty = true;
					keyInput.value = '';
					keyStatus.textContent = '密钥将在保存配置后清除。';
				})
			]),
			renderModels(saved || draft)
		);
	}
	const initial = options.read().sources.find((source) => source.id === selectedId);
	draft = initial ? clone(initial) : undefined;
	// No provider is also a valid initial state.
	if (!selectedId) draft = undefined;
	render();
	const modal: HTMLDivElement | undefined = $modal.simple({
		title: '模型提供商',
		width: 1000,
		content: root,
		footer: h('div', {}, [
			button('关闭', () => {
				if (dirty) confirm('放弃未保存的提供商修改并关闭？', () => modal?.remove());
				else modal?.remove();
			})
		])
	});
}
