import assert from 'node:assert/strict';
import {
	getAIKeyStorage,
	normalizeAIEndpoint,
	buildAIRequest,
	parseAIAnswer,
	searchAIAnswer,
	listAIModels
} from '../packages/core/src/core/answer-wrapper/ai';
import { defaultAnswerWrapperHandler } from '../packages/core/src/core/answer-wrapper/answer.wrapper.handler';
import { createDefaultQuestionResolver } from '../packages/core/src/core/worker/question.resolver';
import {
	getAICallRecords,
	clearAICallRecords,
	observeAICallRecords,
	AI_REASONING_MAX_LENGTH
} from '../packages/core/src/core/answer-wrapper/ai-call-log';
import { createAICallDetails } from '../packages/scripts/src/elements/ai-call-details';
import { CustomOCSWorker } from '../packages/core/src/core/worker/worker';

async function main() {
	const config = { endpoint: 'https://example.com/v1/', model: 'test-model', vision: false };
	assert.equal(normalizeAIEndpoint(config.endpoint), 'https://example.com/v1/chat/completions');
	assert.equal(normalizeAIEndpoint('http://localhost:1234'), 'http://localhost:1234/v1/chat/completions');
	assert.equal(
		normalizeAIEndpoint('https://example.com/api/v3/chat/completions/'),
		'https://example.com/api/v3/chat/completions'
	);
	assert.equal(normalizeAIEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
	assert.equal(normalizeAIEndpoint('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
	assert.notEqual(getAIKeyStorage(config.endpoint), getAIKeyStorage('https://api.deepseek.com'));
	assert.throws(() => normalizeAIEndpoint('javascript:alert(1)'));
	assert.throws(() => normalizeAIEndpoint('https://user:pass@example.com'));
	assert.throws(() => normalizeAIEndpoint('https://example.com?key=secret'));
	const question = { title: '1 + 1 = ?', options: '1\n2\n3', type: 'single' };
	assert.equal(buildAIRequest(config, question).model, 'test-model');
	assert.equal(buildAIRequest(config, question).stream, false);
	assert.equal(
		buildAIRequest({ ...config, endpoint: 'https://api.deepseek.com' }, question).response_format?.type,
		'json_object'
	);
	assert.equal(buildAIRequest(config, question).response_format, undefined);
	assert.throws(() => buildAIRequest({ ...config, model: '' }, question));
	assert.throws(() => buildAIRequest(config, { ...question, images: ['data:image/png;base64,AA=='] }));
	const vision = buildAIRequest(
		{ ...config, vision: true },
		{ ...question, images: ['data:image/png;base64,AA=='], suggestion_title: '[图片1]' }
	);
	assert.equal((vision.messages[1].content as any[])[1].image_url.url, 'data:image/png;base64,AA==');
	assert.equal(parseAIAnswer('{"answers":["2"],"uncertain":false}', 'single'), '2');
	assert.equal(parseAIAnswer('```json\n{"answers":["甲","乙"],"uncertain":false}\n```', 'multiple'), '甲#乙');
	assert.equal(parseAIAnswer('{"answers":["false"],"uncertain":false}', 'judgement'), '错误');
	assert.equal(parseAIAnswer('{"answers":[],"uncertain":true}'), undefined);
	assert.throws(() => parseAIAnswer('答案是 B'));
	assert.throws(() => parseAIAnswer('{"answers":[{"code":"alert(1)"}],"uncertain":false}'));
	assert.throws(() => parseAIAnswer('{"answers":["1","2"],"uncertain":false}', 'single'));
	assert.throws(() => parseAIAnswer('{"answers":["2"]}'));

	let sent: any;
	const runtime = globalThis as any;
	runtime.GM_getValue = (key: string) => {
		assert.equal(key, getAIKeyStorage(config.endpoint));
		return 'test-only-key';
	};
	runtime.GM_xmlhttpRequest = (request: any) => {
		sent = request;
		request.onload({
			status: 200,
			responseText: JSON.stringify({
				choices: [
					{
						finish_reason: 'stop',
						message: {
							reasoning_content: 'provider-reasoning-only',
							content: '{"answers":["2"],"uncertain":false}'
						}
					}
				]
			})
		});
	};
	const info = await searchAIAnswer(config, question, 1000);
	assert.equal(sent.url, 'https://example.com/v1/chat/completions');
	assert.equal(sent.headers.Authorization, 'Bearer test-only-key');
	assert.equal(sent.anonymous, true);
	assert.equal(sent.timeout, 1000);
	assert.equal(JSON.parse(sent.data).messages[1].role, 'user');
	assert.equal(info.results[0].answer, '2');
	assert.deepEqual((info.results[0].extra_data as any).answers, ['2']);
	assert.ok(!JSON.stringify(info).includes('test-only-key'));
	assert.equal(getAICallRecords()[0].status, 'success');
	assert.equal(getAICallRecords()[0].model, config.model);
	assert.equal(typeof getAICallRecords()[0].durationMs, 'number');
	assert.equal(getAICallRecords()[0].usage, undefined);
	assert.ok(!JSON.stringify(getAICallRecords()).includes('test-only-key'));
	assert.equal(info.ai?.reasoning, 'provider-reasoning-only');
	assert.equal(info.ai?.call.status, 'success');
	assert.ok(!JSON.stringify(getAICallRecords()).includes('provider-reasoning-only'));

	// Details survive the automatic worker's simplified results, without entering answers.
	let displayed: any;
	const worker = new CustomOCSWorker({
		questions: () => [{ text: question.title, type: 'single' }],
		answerer: async () => [info],
		resolver: () => ({ finish: true }),
		period: 0,
		onResultsUpdate: (result) => {
			displayed = JSON.parse(JSON.stringify(result));
		}
	});
	await worker.doWork();
	assert.equal(displayed.searchInfos[0].ai.reasoning, 'provider-reasoning-only');
	assert.equal(displayed.searchInfos[0].results[0][1], '2');
	const unsafeReasoning = '<img src=x onerror="alert(1)">\n普通文字';
	const details = createAICallDetails({ call: info.ai!.call, reasoning: unsafeReasoning });
	assert.equal(details.querySelector('.ai-reasoning-content')?.textContent, unsafeReasoning);
	assert.equal(details.querySelectorAll('img, script').length, 0);
	assert.equal(details.querySelector('details')?.hasAttribute('open'), false);
	assert.match(createAICallDetails({ call: info.ai!.call }).textContent || '', /接口未返回思考内容/);

	// Model discovery uses the same scoped authentication and accepts both minimal and DeepSeek metadata.
	runtime.GM_xmlhttpRequest = (request: any) => {
		sent = request;
		request.onload({
			status: 200,
			responseText: JSON.stringify({
				data: [
					{ id: 'deepseek-flash', name: 'DeepSeek Flash', input_modalities: ['text', 'image'] },
					{ id: 'deepseek-v4-pro', input_modalities: ['text'] },
					{ id: 'deepseek-flash' },
					{ id: '' },
					{ name: 'missing-id' }
				]
			})
		});
	};
	const models = await listAIModels(config.endpoint);
	assert.equal(sent.method, 'GET');
	assert.equal(sent.url, 'https://example.com/v1/models');
	assert.equal(sent.data, undefined);
	assert.deepEqual(
		models.map((model) => model.id),
		['deepseek-flash', 'deepseek-v4-pro']
	);
	assert.equal(models[0].vision, true);
	assert.equal(models[1].vision, false);
	runtime.GM_xmlhttpRequest = (request: any) => request.onload({ status: 200, responseText: '{"data":[]}' });
	await assert.rejects(listAIModels(config.endpoint), /没有返回/);
	runtime.GM_xmlhttpRequest = (request: any) => request.onload({ status: 200, responseText: '{"models":[]}' });
	await assert.rejects(listAIModels(config.endpoint), /格式/);

	// Full adapter-to-DOM-resolver path, including punctuation which upstream string splitting loses.
	const wrappers = [
		{
			name: 'AI',
			url: config.endpoint,
			method: 'post' as const,
			type: 'GM_xmlhttpRequest' as const,
			headers: {},
			handler: '',
			ai: config
		}
	];
	const solve = async (
		type: 'single' | 'multiple' | 'completion' | 'judgement',
		options: string[],
		answers: string[]
	) => {
		runtime.GM_xmlhttpRequest = (request: any) =>
			request.onload({
				status: 200,
				responseText: JSON.stringify({
					choices: [
						{
							finish_reason: 'stop',
							message: { reasoning_content: 'not an answer', content: JSON.stringify({ answers, uncertain: false }) }
						}
					]
				})
			});
		const infos = await defaultAnswerWrapperHandler(wrappers, {
			title: question.title,
			type,
			options: options.join('\n')
		});
		const elements = options.map((innerText) => ({ innerText })) as HTMLElement[];
		const clicked: { answer: string; index: number }[] = [];
		const resolver = createDefaultQuestionResolver({} as any)[type];
		const result = await resolver(infos, elements, async (_type, answer, element) => {
			clicked.push({ answer, index: elements.indexOf(element) });
		});
		return { result, clicked };
	};
	assert.deepEqual((await solve('single', ['A. C', 'B. C#', 'C. C++'], ['C#'])).clicked, [{ answer: 'C#', index: 1 }]);
	assert.equal((await solve('single', ['TCP', 'TCP/IP'], ['TCP 或 TCP/IP'])).result.finish, false);
	assert.equal((await solve('single', ['甲', '甲'], ['甲'])).result.finish, false);
	assert.deepEqual(
		(await solve('multiple', ['甲', '乙', '丙'], ['甲', '丙'])).clicked.map((item) => item.index),
		[0, 2]
	);
	assert.equal((await solve('multiple', ['甲', '乙'], ['甲', '不存在'])).clicked.length, 0);
	assert.deepEqual(
		(await solve('judgement', ['正确', '错误'], ['错误'])).clicked.map((item) => item.index),
		[1]
	);
	assert.deepEqual(
		(await solve('completion', [''], ['for (i=0; i<3; i++) { a|=1; }'])).clicked.map((item) => item.answer),
		['for (i=0; i<3; i++) { a|=1; }']
	);
	assert.deepEqual(
		(await solve('completion', ['', ''], ['甲', '乙'])).clicked.map((item) => item.answer),
		['甲', '乙']
	);
	assert.equal((await solve('completion', ['', ''], ['甲'])).clicked.length, 0);

	// Errors and truncated answers never fall through to the option resolver.
	runtime.GM_xmlhttpRequest = (request: any) => request.onload({ status: 401, responseText: 'test-only-key' });
	const unauthorized = await searchAIAnswer(config, question, 1000);
	assert.match(unauthorized.error || '', /401/);
	assert.ok(!JSON.stringify(unauthorized).includes('test-only-key'));
	assert.equal(unauthorized.results.length, 0);
	assert.equal(unauthorized.ai?.call.status, 'error');
	runtime.GM_xmlhttpRequest = (request: any) => request.ontimeout();
	assert.match((await searchAIAnswer(config, question, 1)).error || '', /超时/);
	runtime.GM_xmlhttpRequest = (request: any) =>
		request.onload({
			status: 200,
			responseText: JSON.stringify({
				choices: [{ finish_reason: 'length', message: { content: '{"answers":["2"],"uncertain":false}' } }]
			})
		});
	assert.equal((await searchAIAnswer(config, question, 1000)).results.length, 0);
	assert.equal(getAICallRecords()[0].status, 'error');

	// Concurrent calls retain independent IDs and usage; pending and failures are observable.
	clearAICallRecords();
	const requests: any[] = [];
	runtime.GM_xmlhttpRequest = (request: any) => requests.push(request);
	const first = searchAIAnswer(config, { title: '第一题' }, 1000);
	const second = searchAIAnswer(config, { title: '第二题' }, 1000);
	assert.equal(getAICallRecords().filter((r) => r.status === 'pending').length, 2);
	requests[1].onload({
		status: 200,
		responseText: JSON.stringify({
			usage: {
				prompt_tokens: 12,
				completion_tokens: 8,
				total_tokens: 20
			},
			choices: [{ finish_reason: 'stop', message: { content: '{"answers":[],"uncertain":true}' } }]
		})
	});
	requests[0].ontimeout();
	await Promise.all([first, second]);
	assert.equal(new Set(getAICallRecords().map((r) => r.id)).size, 2);
	assert.equal(getAICallRecords().find((r) => r.question === '第一题')?.status, 'error');
	assert.deepEqual(getAICallRecords().find((r) => r.question === '第二题')?.usage, { input: 12, output: 8, total: 20 });
	assert.equal(getAICallRecords().find((r) => r.question === '第二题')?.status, 'uncertain');
	let notifications = 0;
	const unobserve = observeAICallRecords(() => notifications++);
	clearAICallRecords();
	assert.equal(notifications, 1);
	unobserve();
	assert.equal(getAICallRecords().length, 0);
	runtime.GM_xmlhttpRequest = (request: any) =>
		request.onload({
			status: 200,
			responseText: JSON.stringify({
				choices: [
					{ finish_reason: 'stop', message: { reasoning_content: '{"answers":["2"],"uncertain":false}', content: '' } }
				]
			})
		});
	assert.equal((await searchAIAnswer(config, question, 1000)).results.length, 0);
	const longReasoning = '思'.repeat(AI_REASONING_MAX_LENGTH + 10);
	runtime.GM_xmlhttpRequest = (request: any) =>
		request.onload({
			status: 200,
			responseText: JSON.stringify({
				usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
				choices: [
					{
						finish_reason: 'stop',
						message: { reasoning_content: longReasoning, content: '{"answers":["2"],"uncertain":false}' }
					}
				]
			})
		});
	const long = await searchAIAnswer(config, question, 1000);
	assert.equal(long.ai?.reasoning?.length, AI_REASONING_MAX_LENGTH);
	assert.equal(long.ai?.reasoningTruncated, true);
	assert.equal(long.ai?.call.usage?.total, 12);
	assert.equal(long.results[0].answer, '2');
	delete runtime.GM_getValue;
	delete runtime.GM_xmlhttpRequest;
	console.log(
		'AI checks passed: DeepSeek/OpenAI endpoints, model discovery, scoped keys, JSON/vision, HTTP failures, reasoning isolation and all four DOM resolvers.'
	);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
