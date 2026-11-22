import assert from 'node:assert/strict';
import {
	AnswererWrapper,
	AnswerWrapperHandlerConfig,
	WorkContext,
	aiModelKey,
	createDefaultQuestionResolver
} from '../packages/core';
import { CommonProject } from '../packages/scripts/src/projects/common';
import { inspectAIWorkConfiguration } from '../packages/scripts/src/utils/ai-work-status';
import { matchBankSelections, withBankFallback } from '../packages/scripts/src/utils/bank-fallback';
import { createCommonAnswerer, extractTextWithImages } from '../packages/scripts/src/utils/work';
import { createAnswererWrapperList } from '../packages/scripts/src/utils/ui';

interface Request {
	url: string;
	data: string;
	onload: (response: { status: number; responseText: string }) => void;
}

const bank = (name: string): AnswererWrapper => ({
	name,
	method: 'post',
	type: 'GM_xmlhttpRequest',
	url: 'https://bank.invalid/' + name,
	headers: {},
	data: { title: '${title}', options: '${options}' },
	handler: 'return response => ["测试题", response.answer]'
});
const first = bank('first');
const second = bank('second');
const third = bank('third');
const ai: AnswererWrapper = {
	...bank('ai'),
	ai: { endpoint: 'https://model.invalid/v1', model: 'fixture', authMode: 'none' }
};
const original = {
	request: globalThis.GM_xmlhttpRequest,
	timeout: AnswerWrapperHandlerConfig.timeout_seconds,
	imageOptimize: CommonProject.scripts.settings.cfg.imageOptimize,
	read: globalThis.GM_getValue
};
const respond = (request: Request, value: unknown, status = 200) =>
	request.onload({ status, responseText: JSON.stringify(value) });
const chatResponse = (answers: string[]) => ({
	choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers, uncertain: false }) } }]
});
function mockRequests(handler: (name: string, request: Request) => void | (() => void)) {
	const calls: string[] = [];
	globalThis.GM_xmlhttpRequest = ((request: Request) => {
		const name = new URL(request.url).pathname.split('/').pop()!;
		calls.push(name);
		const abort = handler(name, request);
		return { abort: () => abort?.() };
	}) as typeof GM_xmlhttpRequest;
	return calls;
}

function question(
	wrappers: AnswererWrapper[],
	type: WorkContext<any>['type'] = 'single',
	optionTexts = ['雪梨', '柠檬', '柚子']
) {
	const root = document.createElement('div');
	const options = optionTexts.map((text) => {
		const label = document.createElement('label');
		label.textContent = text;
		root.append(label);
		return label;
	});
	const elements = { options };
	const ctx: WorkContext<any> = { root, elements, searchInfos: [], type, forceSearch: true };
	const answerer = createCommonAnswerer({
		answererWrappers: wrappers,
		period: 0,
		titleTransform: () => '模型题干 $x^2$',
		bankTitleTransform: () => '原题库题干',
		bankMatch: (ctx, infos) => {
			if (String(ctx.type) !== 'line') return;
			return matchBankSelections(infos, options.length, (answer, index) => options[index].textContent === answer);
		},
		optionsTransform: () => {
			const items = options.map((option) => extractTextWithImages(option));
			return { items, text: items.map((item) => item.text).join('\n') };
		}
	});
	let writes = 0;
	for (const option of options) option.onclick = () => writes++;
	return { ctx, run: () => answerer(elements, ctx), writes: () => writes };
}

let checks = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) {
	await run();
	checks++;
	console.log('PASS ' + name);
}

async function main() {
	CommonProject.scripts.settings.cfg.imageOptimize = false;
	AnswerWrapperHandlerConfig.timeout_seconds = 0.05;
	globalThis.GM_getValue = ((_key: string, fallback: unknown) => fallback) as typeof GM_getValue;

	await test('settings preserve legacy modes, stored bank order and disabled choices', () => {
		const settings = CommonProject.scripts.settings;
		const snapshot = JSON.parse(JSON.stringify(settings.cfg));
		try {
			Object.assign(settings.cfg, {
				aiProvidersMigrated: true,
				aiEnabled: true,
				aiBankFallback: false,
				aiAnswerMode: 'basic',
				aiProviders: [
					{
						id: 'fixture',
						name: 'fixture',
						preset: 'custom',
						endpoint: 'https://model.invalid/v1',
						authMode: 'none',
						timeoutSeconds: 10,
						catalog: [],
						models: [{ id: 'fixture', name: 'fixture', enabled: true, vision: false, extraBody: {} }]
					}
				],
				aiSelectedModel: aiModelKey('fixture', 'fixture'),
				answererWrappers: [second, first, third],
				disabledAnswererWrapperNames: ['first']
			});
			let active = settings.methods.getWorkOptions().answererWrappers;
			assert.equal(active[0].ai?.model, 'fixture');
			assert.equal(active[0].fallbackBanks, undefined);

			settings.cfg.aiBankFallback = true;
			active = settings.methods.getWorkOptions().answererWrappers;
			assert.deepEqual(
				active[0].fallbackBanks?.map((source) => source.name),
				['second', 'third']
			);

			settings.cfg.aiEnabled = false;
			active = settings.methods.getWorkOptions().answererWrappers;
			assert.deepEqual(
				active.map((source) => source.name),
				['second', 'third']
			);
			assert.equal(active[0].fallbackBanks, undefined);
		} finally {
			Object.assign(settings.cfg, snapshot);
		}
	});

	await test('a structurally usable first result stops both the later bank and paid AI', async () => {
		const calls = mockRequests((name, request) => {
			assert.equal(name, 'first');
			assert.equal(JSON.parse(request.data).title, '原题库题干');
			respond(request, { answer: '柠檬' });
		});
		const fixture = question(withBankFallback([first, second], ai));
		assert.equal((await fixture.run())[0].results[0].answer, '柠檬');
		assert.deepEqual(calls, ['first']);
		assert.equal(fixture.writes(), 0);
	});

	await test('reorder buttons identify the source and protect the beginning and end of the list', () => {
		const moves: [string, number][] = [];
		const cards = createAnswererWrapperList([first, second], {
			isDisabled: () => false,
			onToggle: () => {},
			onMove: (source, offset) => moves.push([source.name, offset])
		});
		assert.equal(cards[0].querySelector<HTMLButtonElement>('button[title="上移 first"]')!.disabled, true);
		assert.equal(cards[1].querySelector<HTMLButtonElement>('button[title="下移 second"]')!.disabled, true);
		cards[1].querySelector<HTMLButtonElement>('button[title="上移 second"]')!.click();
		assert.deepEqual(moves, [['second', -1]]);
	});

	await test('invalid and unmatched answers advance to the next bank in the configured order', async () => {
		const calls = mockRequests((name, request) => {
			const answers: Record<string, unknown> = { second: { unsupported: 'wrong response' }, first: 'Z', third: 'B' };
			respond(request, { answer: answers[name] });
		});
		const fixture = question(withBankFallback([second, first, third], ai));
		assert.equal((await fixture.run())[0].name, 'third');
		assert.deepEqual(calls, ['second', 'first', 'third']);
		assert.equal(fixture.writes(), 0);
	});

	await test('a partial letter combination is not a usable multi-choice answer', async () => {
		const calls = mockRequests((name, request) => respond(request, { answer: name === 'first' ? 'AZ' : 'BC' }));
		const fixture = question(withBankFallback([first, second], ai), 'multiple');
		assert.equal((await fixture.run())[0].results[0].answer, 'BC');
		assert.deepEqual(calls, ['first', 'second']);
	});

	await test('exact uppercase option text takes precedence over out-of-range choice letters', async () => {
		const cases = [
			{ answer: 'AC#DNS', optionTexts: ['A. AC', 'B. DNS', '互联网协议'] },
			{ answer: 'A Z', optionTexts: ['雪梨', 'A Z', '柚子'] }
		];
		for (const { answer, optionTexts } of cases) {
			const calls = mockRequests((name, request) => respond(request, { answer: name === 'first' ? answer : 'BC' }));
			const fixture = question(withBankFallback([first, second], ai), 'multiple', optionTexts);
			assert.equal((await fixture.run())[0].results[0].answer, answer);
			assert.deepEqual(calls, ['first']);
		}
	});

	await test('ordinary fuzzy option text retains the shared resolver behavior', async () => {
		const answer = '计算机网络原例';
		const calls = mockRequests((name, request) => respond(request, { answer: name === 'first' ? answer : 'BC' }));
		const fixture = question(withBankFallback([first, second], ai), 'multiple', ['雪梨', '计算机网络原理', '柚子']);
		assert.equal((await fixture.run())[0].results[0].answer, answer);
		assert.deepEqual(calls, ['first']);
	});

	await test('out-of-range choice letters still reject partial and fuzzy text matches', async () => {
		for (const [answer, firstOption] of [
			['AZ', 'A'],
			['ABCDEZ', 'ABCDEY'],
			['A Z', 'Z'],
			['A\nZ', 'Z']
		]) {
			const calls = mockRequests((name, request) => respond(request, { answer: name === 'first' ? answer : 'BC' }));
			const fixture = question(withBankFallback([first, second], ai), 'multiple', [firstOption, '柠檬', '柚子']);
			assert.equal((await fixture.run())[0].results[0].answer, 'BC', JSON.stringify(answer));
			assert.deepEqual(calls, ['first', 'second']);
		}
	});

	await test('in-range choice letters that exactly match option text keep normal filling precedence', async () => {
		const calls = mockRequests((_name, request) => respond(request, { answer: 'AC' }));
		const fixture = question(withBankFallback([first, second], ai), 'multiple', ['雪梨', 'AC', '柚子']);
		const infos = await fixture.run();
		const options = fixture.ctx.elements.options as HTMLElement[];
		const selected: HTMLElement[] = [];
		await createDefaultQuestionResolver(fixture.ctx, (option) => extractTextWithImages(option).text).multiple(
			infos,
			options,
			async (_type, _answer, option) => {
				selected.push(option);
			}
		);
		assert.deepEqual(selected, [options[1]]);
		assert.deepEqual(calls, ['first']);
	});

	await test('a partial text combination is not a usable multi-choice answer', async () => {
		const calls = mockRequests((name, request) =>
			respond(request, { answer: name === 'first' ? '雪梨#不存在的火箭' : '柠檬#柚子' })
		);
		const fixture = question(withBankFallback([first, second], ai), 'multiple');
		assert.equal((await fixture.run())[0].results[0].answer, '柠檬#柚子');
		assert.deepEqual(calls, ['first', 'second']);
	});

	await test('a grouped platform match checks every current control before selecting a bank result', async () => {
		const calls = mockRequests((name, request) =>
			respond(request, {
				answer: name === 'first' ? '雪梨#不可用选项#柚子' : '雪梨#柠檬#柚子'
			})
		);
		const fixture = question(withBankFallback([first, second], ai), 'line' as WorkContext<any>['type']);
		assert.equal((await fixture.run())[0].name, 'second');
		assert.deepEqual(calls, ['first', 'second']);
		assert.equal(fixture.writes(), 0);
	});

	await test('filling requires the correct number of writable blanks without touching them', async () => {
		const calls = mockRequests((name, request) => respond(request, { answer: name === 'first' ? '甲' : '甲#乙' }));
		const fixture = question(withBankFallback([first, second], ai), 'completion');
		const fields = [document.createElement('input'), document.createElement('textarea')];
		fixture.ctx.elements.options = fields;
		assert.equal((await fixture.run())[0].results[0].answer, '甲#乙');
		assert.deepEqual(calls, ['first', 'second']);
		assert.deepEqual(
			fields.map((field) => field.value),
			['', '']
		);
	});

	await test('a network failure and a timeout allow fallback only after the timed-out request is aborted', async () => {
		const calls = mockRequests((name, request) => {
			if (name === 'first') {
				respond(request, { error: 'offline' }, 503);
			} else if (name === 'second') {
				return () => calls.push('abort:second');
			} else {
				const payload = JSON.parse(JSON.parse(request.data).messages[1].content);
				assert.equal(payload.question, '模型题干 $x^2$');
				respond(request, chatResponse(['B']));
			}
		});
		const fixture = question(withBankFallback([first, second], ai));
		const result = await fixture.run();
		assert.equal(result[0].results[0].answer, 'B');
		assert.deepEqual(calls, ['first', 'second', 'abort:second', 'completions']);
	});

	await test('advanced AI fallback uses the configured members only after banks miss', async () => {
		const ensemble: AnswererWrapper = {
			...ai,
			ai: undefined,
			aiEnsemble: { rule: 'unanimous', models: [ai.ai!, { ...ai.ai!, model: 'second' }] }
		};
		const calls = mockRequests((name, request) =>
			name === 'first' ? respond(request, {}) : respond(request, chatResponse(['B']))
		);
		const result = await question(withBankFallback([first], ensemble)).run();
		assert.equal(result[0].ensemble?.status, 'agreed');
		assert.deepEqual(calls, ['first', 'completions', 'completions']);
	});

	await test('a fetch bank with answer-shaped HTTP failure does not suppress a healthy bank', async () => {
		const fetch = globalThis.fetch;
		try {
			let failed = 0;
			globalThis.fetch = async () => {
				failed++;
				return new Response(JSON.stringify({ answer: 'A' }), { status: 503 });
			};
			const calls = mockRequests((_, request) => respond(request, { answer: 'C' }));
			const result = await question(withBankFallback([{ ...first, type: 'fetch' }, second], ai)).run();
			assert.equal(result[0].results[0].answer, 'C');
			assert.equal(failed, 1);
			assert.deepEqual(calls, ['second']);
		} finally {
			globalThis.fetch = fetch;
		}
	});

	await test('a removed fallback model still permits good bank answers and has an explicit miss diagnostic', async () => {
		const wrappers = withBankFallback([first], undefined);
		const readiness = inspectAIWorkConfiguration({ aiEnabled: true, answererWrappers: wrappers });
		assert.equal(readiness.ready, true);
		assert.match(readiness.warnings.join(''), /兜底暂不可用/);
		const calls = mockRequests((_, request) => respond(request, { answer: 'B' }));
		assert.equal((await question(wrappers).run())[0].results[0].answer, 'B');
		assert.deepEqual(calls, ['first']);
		const misses = mockRequests((_, request) => respond(request, {}));
		assert.match((await question(wrappers).run())[0].error!, /配置.*兜底/);
		assert.deepEqual(misses, ['first']);
	});

	await test('when a configured fallback loses its API key, a bank hit remains usable', async () => {
		const wrappers = withBankFallback([first], { ...ai, ai: { ...ai.ai!, authMode: 'api-key' } });
		const readiness = inspectAIWorkConfiguration({ answererWrappers: wrappers });
		assert.equal(readiness.ready, true);
		assert.match(readiness.warnings.join(''), /API Key/);
		const calls = mockRequests((_, request) => respond(request, { answer: 'A' }));
		assert.equal((await question(wrappers).run())[0].results[0].answer, 'A');
		assert.deepEqual(calls, ['first']);
		const misses = mockRequests((_, request) => respond(request, {}));
		assert.match((await question(wrappers).run())[0].error!, /API Key/);
		assert.deepEqual(misses, ['first']);
	});

	await test('closing between stages prevents starting any later request', async () => {
		let closed = false;
		const calls = mockRequests((_, request) => {
			closed = true;
			respond(request, {});
		});
		const fixture = question(withBankFallback([first, second], ai));
		fixture.ctx.isClosed = () => closed;
		await assert.rejects(fixture.run(), /已关闭/);
		assert.deepEqual(calls, ['first']);
	});

	await test('pausing after one stage defers the next and its paid fallback', async () => {
		let resume!: () => void;
		let paused: Promise<void> | undefined;
		let bankFinished!: () => void;
		const firstResponse = new Promise<void>((resolve) => (bankFinished = resolve));
		const calls = mockRequests((name, request) => {
			if (name === 'first') {
				paused = new Promise<void>((resolve) => (resume = resolve));
				respond(request, {});
				bankFinished();
			} else if (name === 'second') {
				respond(request, {});
			} else {
				respond(request, chatResponse(['A']));
			}
		});
		const fixture = question(withBankFallback([first, second], ai));
		fixture.ctx.waitUntilActive = async () => paused;
		const result = fixture.run();
		await firstResponse;
		await Promise.resolve();
		assert.deepEqual(calls, ['first']);
		resume();
		assert.equal((await result)[0].results[0].answer, 'A');
		assert.deepEqual(calls, ['first', 'second', 'completions']);
	});

	await test('legacy bank-only search still starts both banks while AI-only starts just the model', async () => {
		const pending = new Map<string, Request>();
		let bothStarted!: () => void;
		const started = new Promise<void>((resolve) => (bothStarted = resolve));
		const calls = mockRequests((name, request) => {
			pending.set(name, request);
			if (pending.size === 2) bothStarted();
		});
		const result = question([first, second]).run();
		await started;
		for (const request of pending.values()) respond(request, { answer: 'A' });
		assert.equal((await result).length, 2);
		assert.deepEqual(calls, ['first', 'second']);
		const aiCalls = mockRequests((_, request) => respond(request, chatResponse(['A'])));
		assert.equal((await question([ai]).run())[0].results[0].answer, 'A');
		assert.deepEqual(aiCalls, ['completions']);
	});

	console.log('Ordered bank and AI fallback: ' + checks + ' scenarios passed.');
}

main()
	.finally(() => {
		globalThis.GM_xmlhttpRequest = original.request;
		globalThis.GM_getValue = original.read;
		AnswerWrapperHandlerConfig.timeout_seconds = original.timeout;
		CommonProject.scripts.settings.cfg.imageOptimize = original.imageOptimize;
	})
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
