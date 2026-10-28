import assert from 'node:assert/strict';
import {
	aiModelKey,
	migrateAIProviders,
	resolveAISelection,
	saveAISource,
	saveAIModel,
	deleteAIModel,
	deleteAISource,
	AIProviderState,
	AIProviderSource
} from '../packages/core/src/core/answer-wrapper/ai-providers';
import {
	getAIKeyStorage,
	searchAIAnswer,
	validateAIExtraBody,
	buildAIRequest
} from '../packages/core/src/core/answer-wrapper/ai';

async function main() {
	let state = migrateAIProviders({
		endpoint: 'https://api.deepseek.com/v1',
		model: 'deepseek-flash',
		vision: true,
		models: [
			{ id: 'deepseek-flash', name: 'Flash', vision: true },
			{ id: 'deepseek-v4-pro', name: 'Pro' }
		]
	});
	assert.equal(state.sources[0].catalog.length, 2);
	assert.equal(state.sources[0].models.length, 1, 'discovered models do not automatically become configured models');
	assert.equal(resolveAISelection(state)?.model, 'deepseek-flash');
	const original = JSON.stringify(state);
	const gateway: AIProviderSource = {
		id: 'gateway',
		name: '网关',
		preset: 'openai',
		endpoint: 'https://api.deepseek.com/v1',
		timeoutSeconds: 40,
		models: [],
		catalog: []
	};
	state = saveAISource(state, gateway);
	assert.ok(original.includes('migrated-default'));
	assert.notEqual(
		getAIKeyStorage(gateway.endpoint, gateway.id),
		getAIKeyStorage(gateway.endpoint, 'migrated-default'),
		'sources sharing an endpoint still have independent credentials'
	);
	state = saveAIModel(state, 'gateway', {
		id: 'deepseek-flash',
		name: '网关 Flash',
		enabled: true,
		vision: false,
		extraBody: { temperature: 0.2, max_tokens: 1000 }
	});
	state = { ...state, selection: aiModelKey('gateway', 'deepseek-flash') };
	assert.equal(resolveAISelection(state)?.sourceId, 'gateway');
	assert.equal(resolveAISelection(state)?.label, '网关 / 网关 Flash');
	assert.equal(resolveAISelection(state)?.timeoutSeconds, 40);
	assert.equal(resolveAISelection(state)?.vision, false);
	assert.deepEqual(resolveAISelection(state)?.extraBody, { temperature: 0.2, max_tokens: 1000 });
	const renamed = saveAISource(state, { ...state.sources[1], name: '新的显示名称' });
	assert.equal(renamed.selection, state.selection, 'renaming a source does not change model identity');
	assert.equal(resolveAISelection(renamed)?.sourceId, 'gateway');
	const source = renamed.sources[1];
	const refreshed = saveAISource(renamed, { ...source, catalog: [{ id: 'new-model', name: 'New' }] });
	assert.equal(refreshed.sources[1].models[0].id, 'deepseek-flash', 'refresh never drops configured models');
	const changedEndpoint = saveAISource(refreshed, { ...refreshed.sources[1], endpoint: 'http://localhost:1234/v1' });
	assert.deepEqual(changedEndpoint.sources[1].catalog, []);
	assert.equal(changedEndpoint.sources[1].models.length, 1);
	assert.equal(refreshed.sources[1].endpoint, gateway.endpoint, 'helpers do not mutate prior state');
	const disabled = saveAIModel(refreshed, 'gateway', { ...source.models[0], enabled: false });
	assert.equal(disabled.selection, '');
	assert.equal(resolveAISelection(disabled), undefined);
	assert.equal(deleteAIModel(refreshed, 'gateway', 'deepseek-flash').selection, '');
	assert.equal(deleteAISource(refreshed, 'gateway').selection, '');
	assert.equal(deleteAISource(refreshed, 'migrated-default').selection, refreshed.selection);
	assert.throws(() => saveAISource(state, { ...gateway, endpoint: 'not a url' }));
	assert.throws(() => saveAISource(state, { ...gateway, timeoutSeconds: 0 }));
	assert.throws(() => saveAIModel(state, 'missing', source.models[0]));
	assert.throws(() => saveAIModel(state, 'gateway', { ...source.models[0], id: ' ' }));
	assert.throws(() => validateAIExtraBody({ messages: [] }));
	assert.throws(() => validateAIExtraBody({ model: 'override' }));
	assert.throws(() => validateAIExtraBody([]));

	let sent: any;
	const runtime = globalThis as any;
	runtime.GM_getValue = (key: string) =>
		key === getAIKeyStorage(gateway.endpoint, gateway.id) ? 'gateway-test-key' : '';
	runtime.GM_xmlhttpRequest = (request: any) => {
		sent = request;
		request.onload({
			status: 200,
			responseText: JSON.stringify({
				choices: [
					{
						finish_reason: 'stop',
						message: {
							content: '{"answers":["2"],"uncertain":false}'
						}
					}
				]
			})
		});
	};
	const config = resolveAISelection(state)!;
	const response = await searchAIAnswer(config, { title: '1+1?', type: 'single', options: '1\n2' }, 1000);
	assert.equal(response.results[0].answer, '2');
	assert.equal(sent.headers.Authorization, 'Bearer gateway-test-key');
	assert.equal(sent.timeout, 40_000);
	assert.equal(JSON.parse(sent.data).temperature, 0.2);
	assert.equal(JSON.parse(sent.data).max_tokens, 1000);
	assert.ok(!JSON.stringify(state).includes('gateway-test-key'));
	assert.equal(
		buildAIRequest({ ...config, extraBody: { response_format: { type: 'text' } } }, { title: 'x' }).response_format
			?.type,
		'text'
	);
	const empty: AIProviderState = { sources: [], selection: '' };
	assert.equal(resolveAISelection(empty), undefined);
	delete runtime.GM_getValue;
	delete runtime.GM_xmlhttpRequest;
	console.log(
		'Provider checks passed: migration, candidates/configured separation, stable selection, per-source keys, refresh, deletion, disable and inference parameters.'
	);
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
