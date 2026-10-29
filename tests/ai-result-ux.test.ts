import assert from 'node:assert/strict';
import {
	searchAIEnsemble,
	AIEnsembleConfig,
	AIEnsembleResult
} from '../packages/core/src/core/answer-wrapper/ai-ensemble';
import { SearchInformation } from '../packages/core/src/core/answer-wrapper/interface';
import {
	createAIEnsembleDetails,
	createAIEnsembleSummary,
	createAIAnswerCopyButton
} from '../packages/scripts/src/elements/ai-ensemble-details';
import { SearchInfosElement } from '../packages/scripts/src/elements/search.infos';

const runtime = globalThis as any;
runtime.GM_getValue = () => '';
const question = { type: 'single', title: '请选择正确答案。', options: '甲\n乙', option_count: 2 };
const model = (id: string) => ({ model: id, label: id, endpoint: 'https://offline.example/v1', vision: true });
const base: AIEnsembleConfig = { models: ['a', 'b', 'c'].map(model), repeat: true, rule: 'confidence', threshold: 100 };
let requests: any[] = [];
function install(reply: (model: string, index: number) => string[] | 'error', hold = false) {
	requests = [];
	runtime.GM_xmlhttpRequest = (request: any) => {
		const index = requests.length;
		requests.push(request);
		request.respond = () => {
			const answers = reply(JSON.parse(request.data).model, index);
			request.onload(
				answers === 'error'
					? { status: 401, responseText: '' }
					: {
							status: 200,
							responseText: JSON.stringify({
								choices: [
									{
										finish_reason: 'stop',
										message: {
											content: JSON.stringify({ answers, uncertain: false }),
											reasoning_content: '<img src=x onerror=alert(1)> 中文思考'
										}
									}
								]
							})
					  }
			);
		};
		if (!hold) request.respond();
	};
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function candidateFixture(): AIEnsembleResult {
	return {
		status: 'review',
		reason: '存在不同答案，请人工判断。',
		vote: { count: 2, total: 4, threshold: 75 },
		progress: { stage: 'done', completed: 4, total: 4 },
		members: [
			{ name: '模型一', answers: ['A'], normalizedAnswers: ['A'] },
			{ name: '模型二', answers: ['a'], normalizedAnswers: ['A'] },
			{ name: '模型三', answers: ['B'], normalizedAnswers: ['B'] },
			{ name: '模型四', error: '网络失败' }
		]
	};
}
const adoptionButtons = (root: HTMLElement) =>
	[...root.querySelectorAll('button')].filter((button) => button.textContent === '采用此答案填入本题');
async function click(button: HTMLElement) {
	await button.onclick!({} as MouseEvent);
}
function renderResult(ensemble: AIEnsembleResult, type: any = 'single', answers = ['A']) {
	const element = document.createElement('section') as unknown as SearchInfosElement;
	element.question = '题目';
	element.type = type;
	element.infos = [
		{ name: '联合答题', ensemble, results: [['题目', answers.join('#'), { ai: true, ai_native: true, answers }]] }
	];
	SearchInfosElement.prototype.connectedCallback.call(element);
	return element;
}
let checks = 0;
async function test(name: string, action: () => void | Promise<void>) {
	await action();
	checks++;
	console.log('PASS ' + name);
}

async function main() {
	await test('each participant publishes progress immediately while members retain configured order', async () => {
		install(() => ['A'], true);
		const snapshots: SearchInformation[] = [];
		const task = searchAIEnsemble(
			base,
			{
				...question,
				onProgress: (info) => {
					snapshots.push(info);
				}
			},
			1000
		);
		assert.equal(snapshots[0].ensemble?.progress?.completed, 0);
		requests[2].respond();
		await tick();
		const partial = snapshots[snapshots.length - 1].ensemble!;
		assert.equal(partial.status, 'running');
		assert.equal(partial.progress?.completed, 1);
		assert.equal(partial.members[0].answers, undefined);
		assert.deepEqual(partial.members[2].answers, ['A']);
		assert.match(partial.members[0].name, /^a/);
		requests[0].respond();
		await tick();
		assert.equal(snapshots[snapshots.length - 1].ensemble?.progress?.completed, 2);
		requests[1].respond();
		const result = await task;
		assert.deepEqual(result.results[0].extra_data, { ai: true, ai_native: true, answers: ['A'] });
		assert.deepEqual(result.ensemble?.progress, { stage: 'done', completed: 3, total: 3 });
		assert.equal(snapshots[0].ensemble?.members[2].answers, undefined);
	});
	await test('summary start and completion are separate progress phases', async () => {
		install((id, index) => [id === 'summary' ? 'B' : index === 0 ? 'A' : 'B'], true);
		const snapshots: SearchInformation[] = [];
		const task = searchAIEnsemble(
			{ ...base, rule: 'summary', summary: model('summary') },
			{
				...question,
				onProgress: (info) => {
					snapshots.push(info);
				}
			},
			1000
		);
		requests[0].respond();
		requests[1].respond();
		requests[2].respond();
		await tick();
		assert.equal(requests.length, 4);
		const latest = snapshots[snapshots.length - 1].ensemble!;
		assert.equal(latest.progress?.stage, 'summary');
		assert.equal(latest.progress?.completed, 3);
		assert.match(createAIEnsembleSummary(latest).textContent!, /独立作答 3\/3 已返回.*正在调用总结模型/);
		requests[3].respond();
		const result = await task;
		assert.equal(result.results[0].answer, 'B');
		assert.equal(result.ensemble?.status, 'summarized');
		assert.equal(snapshots[snapshots.length - 1].ensemble?.progress?.stage, 'done');
	});
	for (const failure of ['throw', 'reject', 'never-resolve'] as const)
		await test('a progress observer that can ' + failure + ' never changes or delays successful answers', async () => {
			install(() => ['A']);
			const task = searchAIEnsemble(
				base,
				{
					...question,
					onProgress: () => {
						if (failure === 'throw') throw new Error('observer');
						if (failure === 'reject') return Promise.reject(new Error('observer'));
						return new Promise<void>(() => {});
					}
				},
				1000
			);
			const result = await Promise.race([
				task,
				new Promise<never>((resolve, reject) => setTimeout(() => reject(new Error('observer delayed answer')), 100))
			]);
			assert.equal(result.results[0].answer, 'A');
			await tick();
		});
	await test('observer mutations never change real candidate answers or the final result', async () => {
		install(() => ['A']);
		const result = await searchAIEnsemble(
			base,
			{
				...question,
				onProgress: (info) => {
					if (info.ensemble) {
						info.ensemble.status = 'confirmed';
						info.ensemble.members.length = 0;
					}
					info.results.length = 0;
				}
			},
			1000
		);
		assert.equal(result.ensemble?.status, 'agreed');
		assert.equal(result.ensemble?.members.length, 3);
		assert.equal(result.results[0].answer, 'A');
	});
	await test('failed participants still advance progress and remain in the denominator', async () => {
		install((_id, index) => (index === 2 ? 'error' : ['A']));
		const snapshots: SearchInformation[] = [];
		const result = await searchAIEnsemble(
			base,
			{
				...question,
				onProgress: (info) => {
					snapshots.push(info);
				}
			},
			1000
		);
		assert.equal(result.ensemble?.status, 'review');
		assert.equal(result.ensemble?.progress?.completed, 3);
		assert.equal(result.ensemble?.vote?.total, 3);
		assert.match(createAIEnsembleSummary(result.ensemble!).textContent!, /失败\/无效 1 次/);
		assert.equal(
			snapshots.some((info) => info.ensemble?.progress?.completed === 2),
			true
		);
	});
	await test('invalid configuration emits a final review snapshot with zero requests', async () => {
		install(() => ['A']);
		const snapshots: SearchInformation[] = [];
		await searchAIEnsemble(
			{ ...base, models: [] },
			{
				...question,
				onProgress: (info) => {
					snapshots.push(info);
				}
			},
			1000
		);
		assert.equal(requests.length, 0);
		assert.equal(snapshots.length, 1);
		assert.equal(snapshots[0].ensemble?.progress?.stage, 'done');
	});
	await test('the final answer and decision stay visible while the entire candidate area truly collapses', async () => {
		const root = renderResult(candidateFixture());
		const card = root.querySelector<HTMLElement>('.accordion-card')!;
		const permanent = card.querySelector('.accordion-card-always-visible')!;
		const foldable = card.querySelector('.accordion-card-body')!;
		assert.equal(card.classList.contains('expanded'), false);
		assert.equal(permanent.querySelector('.answer code')?.textContent, 'A');
		assert.ok(permanent.querySelector('.ai-ensemble-summary'));
		assert.equal(permanent.querySelector('.ai-ensemble-details'), null);
		assert.ok(foldable.querySelector('.ai-ensemble-details'));
		await click(card.querySelector<HTMLElement>('.accordion-card-header')!);
		assert.equal(card.classList.contains('expanded'), true);
		await click(card.querySelector<HTMLElement>('.accordion-card-header')!);
		assert.equal(card.classList.contains('expanded'), false);
		assert.equal(permanent.querySelector('.answer code')?.textContent, 'A');
	});
	await test('real bubbling title clicks toggle the card while homepage link clicks preserve its state', () => {
		for (const homepage of [undefined, 'https://example.test/provider']) {
			const element = document.createElement('section') as unknown as SearchInfosElement;
			element.question = '标题点击测试：' + (homepage || '无主页');
			element.type = 'single';
			element.infos = [{ name: '多模型联合答题', homepage, ensemble: candidateFixture(), results: [] }];
			SearchInfosElement.prototype.connectedCallback.call(element);
			const card = element.querySelector<HTMLElement>('.accordion-card')!;
			const header = card.querySelector<HTMLElement>('.accordion-card-header')!;
			const title = header.firstElementChild as HTMLElement;
			assert.equal(title.tagName, homepage ? 'A' : 'SPAN');
			assert.equal(card.classList.contains('expanded'), false);
			let bubbled = 0;
			header.addEventListener('click', () => {
				bubbled++;
			});
			if (homepage) title.addEventListener('click', (event) => event.preventDefault());
			const dispatch = () => {
				const event = document.createEvent('Event');
				event.initEvent('click', true, true);
				title.dispatchEvent(event);
			};
			dispatch();
			assert.equal(card.classList.contains('expanded'), !homepage);
			assert.equal(bubbled, homepage ? 0 : 1);
			if (!homepage) {
				dispatch();
				assert.equal(card.classList.contains('expanded'), false);
				assert.equal(bubbled, 2);
			}
		}
	});
	await test('a repeated manual-review reason appears once while a distinct real error stays visible', () => {
		for (const realError of [false, true]) {
			const element = document.createElement('section') as unknown as SearchInfosElement;
			element.question = '人工提示去重';
			element.type = 'single';
			const fixture = candidateFixture();
			fixture.reason = '各次回答存在分歧，请人工评判。';
			const error = realError ? '结果状态保存失败' : fixture.reason;
			element.infos = [{ name: '联合答题', ensemble: fixture, error, results: [] }];
			SearchInfosElement.prototype.connectedCallback.call(element);
			const permanent = element.querySelector('.accordion-card-always-visible')!;
			assert.equal(permanent.textContent!.split(fixture.reason).length - 1, 1);
			assert.equal(permanent.querySelector('.error')?.textContent, realError ? error : undefined);
			assert.equal(element.textContent!.includes('共 0 个结果'), false);
		}
	});
	for (const status of ['running', 'review', 'confirmed'] as const)
		await test('an ensemble without an adopted result does not claim zero search results: ' + status, () => {
			const element = document.createElement('section') as unknown as SearchInfosElement;
			element.question = '尚无具体采用值：' + status;
			element.type = 'single';
			element.infos = [{ name: '联合答题', ensemble: { ...candidateFixture(), status }, results: [] }];
			SearchInfosElement.prototype.connectedCallback.call(element);
			assert.equal(element.querySelector('.accordion-card-header')!.textContent!.includes('共 0 个结果'), false);
			assert.ok(element.querySelector('.ai-ensemble-summary'));
		});
	await test('an ensemble with a concrete adopted result still shows its result count and answer', () => {
		const element = renderResult({ ...candidateFixture(), status: 'confirmed' }, 'single', ['B']);
		assert.match(element.querySelector('.accordion-card-header')!.textContent!, /共 1 个结果/);
		assert.equal(element.querySelector('.answer code')?.textContent, 'B');
	});
	await test('equivalent normalized candidates form one group without losing provider entries', () => {
		const fixture = candidateFixture();
		const summary = createAIEnsembleSummary(fixture, 'single');
		assert.match(summary.textContent!, /A × 2.*B × 1.*失败\/无效 1 次/);
		const details = createAIEnsembleDetails(fixture, { type: 'single', includeSummary: false });
		assert.equal(details.querySelectorAll('.ai-candidate-answer').length, 2);
		assert.match(details.textContent!, /模型一.*模型二.*模型三.*模型四/);
	});
	await test('progress rebuilds preserve the users candidate-card and reasoning disclosure choices', async () => {
		const fixture = candidateFixture();
		fixture.members[0].ai = {
			call: {
				id: 'disclosure-fixture',
				startedAt: 0,
				provider: '离线',
				model: '模型一',
				question: '题干',
				imageCount: 0,
				status: 'success'
			},
			reasoning: '核对依据'
		};
		const first = renderResult(fixture);
		const firstCard = first.querySelector<HTMLElement>('.accordion-card')!;
		await click(firstCard.querySelector<HTMLElement>('.accordion-card-header')!);
		const disclosure = firstCard.querySelector('details')!;
		disclosure.open = true;
		const toggled = document.createEvent('Event');
		toggled.initEvent('toggle', false, false);
		disclosure.dispatchEvent(toggled);
		const next = renderResult(fixture);
		assert.equal(next.querySelector('.accordion-card')!.classList.contains('expanded'), true);
		assert.equal(next.querySelector('details')!.open, true);
		await click(next.querySelector<HTMLElement>('.accordion-card-header')!);
	});
	await test('the full result renderer wires a review action only to explicit candidate buttons', async () => {
		let chosen: string[] | undefined;
		const element = document.createElement('section') as unknown as SearchInfosElement;
		element.question = '独立的采用题目';
		element.type = 'single';
		element.infos = [{ name: '联合答题', ensemble: candidateFixture(), results: [] }];
		element.reviewActions = {
			adopt: async (answers) => {
				chosen = answers;
			}
		};
		SearchInfosElement.prototype.connectedCallback.call(element);
		assert.equal(chosen, undefined);
		await click(adoptionButtons(element)[0]);
		assert.deepEqual(chosen, ['A']);
	});
	await test('completion values have blank labels and copying keeps exact code, punctuation and field boundaries', async () => {
		let copied = '';
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: async (value: string) => {
					copied = value;
				}
			}
		});
		const answers = ['C#; a,b', '<img src=x>\n第二行'];
		const details = createAIEnsembleDetails(
			{ status: 'review', reason: '人工', members: [{ name: '模型', answers }] },
			{ type: 'completion' }
		);
		assert.match(details.textContent!, /第 1 空：/);
		assert.match(details.textContent!, /第 2 空：/);
		assert.equal(details.querySelector('img'), null);
		await click([...details.querySelectorAll('button')].find((button) => button.textContent === '复制答案')!);
		assert.equal(copied, answers.join('\n'));
		const final = renderResult({ status: 'selected', reason: '指定模型', members: [] }, 'completion', answers);
		assert.match(final.querySelector('.answer')!.textContent!, /第 1 空：.*第 2 空：/s);
		assert.equal(final.querySelector('.answer img'), null);
	});
	await test('copy failure is visible rather than reporting false success', async () => {
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: async () => {
					throw new Error('denied');
				}
			}
		});
		const button = createAIAnswerCopyButton(['A']);
		await click(button);
		assert.match(button.textContent!, /复制失败/);
	});
	await test('adoption is explicit and passes a detached copy of the chosen original answer array', async () => {
		let adopted: string[] | undefined;
		const fixture = candidateFixture();
		const root = createAIEnsembleDetails(fixture, {
			type: 'single',
			reviewActions: {
				adopt: async (answers) => {
					adopted = answers;
				}
			}
		});
		assert.equal(adopted, undefined);
		const buttons = adoptionButtons(root);
		assert.equal(buttons.length, 2);
		await click(buttons[1]);
		assert.deepEqual(adopted, ['B']);
		adopted!.push('changed');
		assert.deepEqual(fixture.members[2].answers, ['B']);
		assert.equal(
			buttons.every((button) => button.disabled),
			true
		);
	});
	await test('adoption serializes clicks and failure shows the reason then allows retry', async () => {
		let calls = 0;
		let rejectAction: (error: Error) => void = () => {};
		const root = createAIEnsembleDetails(candidateFixture(), {
			type: 'single',
			reviewActions: {
				adopt: () => {
					calls++;
					return new Promise<void>((resolve, reject) => {
						rejectAction = reject;
					});
				}
			}
		});
		const buttons = adoptionButtons(root);
		const pending = click(buttons[0]);
		assert.equal(
			buttons.every((button) => button.disabled),
			true
		);
		await click(buttons[1]);
		assert.equal(calls, 1);
		rejectAction(new Error('原题已失效'));
		await pending;
		assert.match(root.textContent!, /原题已失效/);
		assert.equal(
			buttons.every((button) => !button.disabled),
			true
		);
	});
	for (const type of ['unknown', undefined])
		await test('unknown question type never exposes adoption: ' + type, () => {
			const root = createAIEnsembleDetails(candidateFixture(), {
				type,
				reviewActions: {
					adopt: async () => {
						throw new Error('must not run');
					}
				}
			});
			assert.equal(adoptionButtons(root).length, 0);
		});
	for (const status of ['running', 'agreed', 'summarized', 'selected', 'confirmed'] as const)
		await test('only manual-review results expose adoption, not ' + status, () => {
			const root = createAIEnsembleDetails(
				{ ...candidateFixture(), status },
				{ type: 'single', reviewActions: { adopt: async () => {} } }
			);
			assert.equal(adoptionButtons(root).length, 0);
		});
	await test('provider names, answers and reasoning remain plain text without executable elements', async () => {
		install(() => ['<script>bad()</script>']);
		const result = await searchAIEnsemble(
			{ ...base, rule: 'manual', subjectiveRule: 'manual' },
			{
				title: '简答',
				type: 'completion',
				blank_count: 1
			},
			1000
		);
		result.ensemble!.members[0].name = '<img src=x onerror=alert(1)>';
		const root = createAIEnsembleDetails(result.ensemble!, { type: 'completion' });
		assert.equal(root.querySelector('img, script'), null);
		assert.match(root.textContent!, /<script>bad\(\)<\/script>/);
		assert.match(root.textContent!, /中文思考/);
	});
	console.log(`AI result UX: ${checks} scenarios passed.`);
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
