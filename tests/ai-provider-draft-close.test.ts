import assert from 'node:assert/strict';
import { $modal } from 'easy-us';
import type { AIProviderState } from '../packages/core/src/core/answer-wrapper/ai-providers';
import { getAIKeyStorage } from '../packages/core/src/core/answer-wrapper/ai';
import { openAIProviderManager } from '../packages/scripts/src/utils/ai-provider-manager';

if (!Element.prototype.replaceChildren)
	Element.prototype.replaceChildren = function (...nodes: (Node | string)[]) {
		while (this.firstChild) this.removeChild(this.firstChild);
		for (const node of nodes) this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
	};

type FixtureModal = HTMLElement & {
	content: HTMLElement;
	footer?: HTMLElement;
	onConfirm?: () => Promise<void>;
	onCancel?: () => void;
};
const runtime = globalThis as any;
const oldGet = runtime.GM_getValue;
const oldSet = runtime.GM_setValue;
const oldDelete = runtime.GM_deleteValue;
const oldList = runtime.GM_listValues;
const oldRequest = runtime.GM_xmlhttpRequest;
const values = new Map<string, unknown>();
let checks = 0;
runtime.GM_getValue = (key: string, fallback: unknown) => values.get(key) ?? fallback;
runtime.GM_setValue = (key: string, value: unknown) => values.set(key, value);
runtime.GM_deleteValue = (key: string) => values.delete(key);
runtime.GM_listValues = () => [...values.keys()];
runtime.GM_xmlhttpRequest = () => assert.fail('draft close must never query a service');

function initial(): AIProviderState {
	return {
		selection: '',
		sources: [
			{
				id: 'draft-fixture',
				name: 'Saved provider',
				preset: 'openai',
				endpoint: 'https://provider.invalid/v1',
				authMode: 'api-key',
				timeoutSeconds: 120,
				models: [],
				catalog: []
			}
		]
	};
}

/** Keep easy-us's actual wrapper listeners; jsdom 13 does not mount custom-element children. */
function attachContents(wrapper: HTMLElement): FixtureModal {
	const modal = wrapper.querySelector<FixtureModal>('modal-element')!;
	assert.ok(modal, 'actual easy-us modal exists');
	if (modal.content && !modal.contains(modal.content)) modal.append(modal.content);
	if (modal.footer && !modal.contains(modal.footer)) modal.append(modal.footer);
	return modal;
}

function fixture() {
	document.body.replaceChildren();
	values.clear();
	let state = initial();
	let writes = 0;
	let credentialChanges = 0;
	const storage = getAIKeyStorage(state.sources[0].endpoint, state.sources[0].id);
	values.set(storage, 'saved-offline-fixture-key');
	openAIProviderManager({
		read: () => state,
		write: (next) => {
			state = next;
			writes++;
		},
		onCredentialsChange: () => credentialChanges++
	});
	const wrapper = document.querySelector<HTMLElement>('.modal-wrapper')!;
	const modal = attachContents(wrapper);
	const input = (label: string) => {
		const value = modal.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
		assert.ok(value, `provider input exists: ${label}`);
		return value;
	};
	const type = (label: string, value: string) => {
		const field = input(label);
		field.value = value;
		field.dispatchEvent(new window.Event('input', { bubbles: true }));
	};
	const press = async (text: string) => {
		const button = [...modal.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text);
		assert.ok(button, `provider action exists: ${text}`);
		await button.onclick!(new MouseEvent('click'));
	};
	const confirmation = () => {
		const wrappers = [...document.querySelectorAll<HTMLElement>('.modal-wrapper')];
		assert.equal(wrappers.length, 2, 'exactly one discard confirmation is open');
		return attachContents(wrappers[1]);
	};
	return {
		wrapper,
		modal,
		input,
		type,
		press,
		confirmation,
		read: () => state,
		writes: () => writes,
		credentialChanges: () => credentialChanges,
		storedKey: () => values.get(storage)
	};
}

async function test(name: string, run: () => void | Promise<void>) {
	await run();
	checks++;
	console.log('PASS ' + name);
}

async function main() {
	await test('a newly added provider remains an unsaved draft after an outside click', async () => {
		const view = fixture();
		view.modal.querySelector<HTMLButtonElement>('.source-add')!.click();
		const pickerWrapper = [...document.querySelectorAll<HTMLElement>('.modal-wrapper')][1];
		const picker = attachContents(pickerWrapper);
		const custom = [...picker.querySelectorAll<HTMLButtonElement>('button')].find(
			(button) => button.getAttribute('aria-label') === '自定义'
		);
		assert.ok(custom);
		await custom.onclick!(new MouseEvent('click'));
		view.type('提供商名称', 'New unsaved provider');
		view.type('API Base URL', 'https://new-provider.invalid/v1');
		view.wrapper.click();
		assert.ok(view.wrapper.isConnected);
		assert.equal(view.input('提供商名称').value, 'New unsaved provider');
		assert.equal(view.input('API Base URL').value, 'https://new-provider.invalid/v1');
		assert.equal(view.read().sources.length, 1, 'the new provider was not implicitly saved');
		assert.equal(view.writes(), 0);
	});
	await test('mask and Escape leave provider and credential drafts intact without writes', () => {
		const view = fixture();
		view.type('提供商名称', 'Unsaved provider');
		view.type('API Key', 'new-offline-fixture-key');
		view.wrapper.click();
		window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.ok(view.wrapper.isConnected);
		assert.equal(view.input('提供商名称').value, 'Unsaved provider');
		assert.equal(view.input('API Key').value, 'new-offline-fixture-key');
		assert.equal(document.querySelectorAll('.modal-wrapper').length, 1);
		assert.equal(view.writes(), 0);
		assert.equal(view.credentialChanges(), 0);
		assert.equal(view.storedKey(), 'saved-offline-fixture-key');
	});
	await test('cancelling explicit draft dismissal preserves inputs and saved state', async () => {
		const view = fixture();
		view.type('提供商名称', 'Unsaved provider');
		await view.press('关闭');
		view.confirmation().onCancel!();
		assert.ok(view.wrapper.isConnected);
		assert.equal(view.input('提供商名称').value, 'Unsaved provider');
		assert.equal(document.querySelectorAll('.modal-wrapper').length, 1);
		assert.deepEqual(view.read(), initial());
		assert.equal(view.writes(), 0);
	});
	await test('confirming explicit dismissal closes both dialogs without saving draft or key', async () => {
		const view = fixture();
		view.type('提供商名称', 'Discarded provider');
		view.type('API Key', 'discarded-offline-fixture-key');
		await view.press('关闭');
		await view.confirmation().onConfirm!();
		assert.equal(document.querySelectorAll('.modal-wrapper').length, 0);
		assert.deepEqual(view.read(), initial());
		assert.equal(view.storedKey(), 'saved-offline-fixture-key');
		assert.equal(view.writes(), 0);
		assert.equal(view.credentialChanges(), 0);
	});
	await test('an unchanged provider closes directly through its footer', async () => {
		const view = fixture();
		await view.press('关闭');
		assert.equal(document.querySelectorAll('.modal-wrapper').length, 0);
		assert.equal(view.writes(), 0);
	});
	await test('saved provider and key changes remain saved and close without another prompt', async () => {
		const view = fixture();
		view.type('提供商名称', 'Saved replacement');
		view.type('API Key', 'replacement-offline-fixture-key');
		await view.press('保存配置');
		assert.equal(view.read().sources[0].name, 'Saved replacement');
		assert.equal(view.storedKey(), 'replacement-offline-fixture-key');
		assert.equal(view.writes(), 1);
		assert.equal(view.credentialChanges(), 1);
		await view.press('关闭');
		assert.equal(document.querySelectorAll('.modal-wrapper').length, 0);
	});
	console.log(`Provider draft close protection: ${checks} scenarios passed.`);
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		document.body.replaceChildren();
		runtime.GM_getValue = oldGet;
		runtime.GM_setValue = oldSet;
		runtime.GM_deleteValue = oldDelete;
		runtime.GM_listValues = oldList;
		runtime.GM_xmlhttpRequest = oldRequest;
	});
