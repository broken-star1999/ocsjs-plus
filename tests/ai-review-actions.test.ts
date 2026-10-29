import assert from 'node:assert/strict';
import { $, cors } from 'easy-us';
import { OCSWorker } from '../packages/core/src/core/worker/worker';
import { enableSingleQuestionRetry } from '../packages/core/src/core/worker/single-question-retry';
import type { QuestionTypes, WorkResult } from '../packages/core/src/core/worker/interface';
import type { SearchInformation } from '../packages/core/src/core/answer-wrapper/interface';
import { createCXQuestionRetryAdapter } from '../packages/scripts/src/utils/cx-question-retry';
import {
	createManualReviewControl,
	registerReviewActions,
	requestReviewAction
} from '../packages/scripts/src/utils/question-retry-control';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const originalSleep = $.sleep;
const originalOn = cors.on;
const originalEmit = cors.emit;
const remoteHandlers = new Map<string, (args: any[]) => any>();
$.sleep = async () => {};
cors.on = async (name, handler) => {
	remoteHandlers.set(name, handler);
	return 0;
};
function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, resolve: release };
}
async function until(check: () => boolean) {
	for (let n = 0; n < 150; n++) {
		if (check()) return;
		await delay(10);
	}
	assert.fail('scenario did not reach the expected state');
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function review(candidates: string[][] = [['A'], ['B']]): SearchInformation[] {
	return [
		{
			name: '联合答题',
			results: [],
			error: '等待人工评判',
			ensemble: {
				status: 'review',
				reason: '等待人工评判',
				members: candidates.map((answers, index) => ({ name: 'model-' + index, answers }))
			}
		}
	];
}
function agreed(answers: string[]): SearchInformation[] {
	return [
		{
			name: '联合答题',
			results: [{ question: 'question', answer: answers.join('#'), extra_data: { ai_native: true, answers } }],
			ensemble: { status: 'agreed', reason: '一致', members: [{ name: 'model', answers }] }
		}
	];
}
async function fixture(type: QuestionTypes = 'single', supported = true, candidates?: string[][]) {
	const root = document.createElement('section');
	root.innerHTML = '<h3>题干<img src="https://example.test/question.png"></h3><input type="hidden" value="0">';
	const count = type === 'completion' || type === 'judgement' ? 2 : 4;
	for (let i = 0; i < count; i++) {
		const option = document.createElement('div');
		option.className = 'option';
		option.innerHTML =
			type === 'completion'
				? '<textarea>old-' + i + '</textarea>'
				: type === 'judgement'
				? i
					? 'B. 错'
					: 'A. 对'
				: String.fromCharCode(65 + i) + '. value-' + i;
		option.onclick = () => {
			if (type !== 'multiple') root.querySelectorAll('.option').forEach((other) => other.classList.remove('active'));
			option.classList.toggle('active');
		};
		root.append(option);
	}
	document.body.append(root);
	let response = review(
		candidates ||
			(type === 'completion'
				? [
						['new-0', 'new-1'],
						['other-0', 'other-1']
				  ]
				: type === 'judgement'
				? [['正确'], ['错误']]
				: type === 'multiple'
				? [['AB'], ['BC']]
				: undefined)
	);
	let failure = '';
	let gate: ReturnType<typeof deferred> | undefined;
	let calls = 0;
	let all: WorkResult<any>[] = [];
	let settled = false;
	let locations = 0;
	let failNextStore = false;
	let persisted: SearchInformation[] = [];
	(root as any).scrollIntoView = () => {
		locations++;
	};
	const adapter = createCXQuestionRetryAdapter<any>({
		layout: 'practice',
		type: () => type,
		optionText: (option) => option.textContent || ''
	});
	const worker = new OCSWorker({
		root: [root],
		elements: { title: 'h3', options: '.option', type: 'input[type=hidden]' },
		answerer: async () => {
			calls++;
			if (gate) await gate.promise;
			if (failure) throw new Error(failure);
			return clone(response);
		},
		work: {
			type,
			optionText: adapter.optionText,
			handler: async () => {
				assert.fail('review must never auto-fill');
			}
		},
		onResultsInit: (_current, _index, results) => {
			all = results;
		},
		onResultsUpdate: (current) => {
			if (failNextStore && current.result?.finish) {
				failNextStore = false;
				throw new Error('offline final store failed');
			}
			persisted = clone(current.ctx?.searchInfos || []);
		}
	});
	if (supported) enableSingleQuestionRetry(worker, adapter);
	const task = worker.doWork().then(() => {
		settled = true;
	});
	await until(() => !!all[0]?.resolved);
	return {
		worker,
		root,
		all,
		task,
		result: () => all[0],
		calls: () => calls,
		settled: () => settled,
		locations: () => locations,
		persisted: () => persisted,
		failNextStore: () => {
			failNextStore = true;
		},
		setResponse: (infos: SearchInformation[]) => {
			response = infos;
		},
		setFailure: (error: string) => {
			failure = error;
		},
		gate: () => {
			gate = deferred();
			return gate;
		},
		values: () =>
			type === 'completion'
				? [...root.querySelectorAll('textarea')].map((field) => field.value)
				: [...root.querySelectorAll('.option')].map((option) => option.classList.contains('active')),
		cleanup: async () => {
			gate?.resolve();
			worker.emit('close');
			await task;
			root.remove();
		}
	};
}
let checks = 0;
async function test(name: string, action: () => Promise<void>) {
	await action();
	checks++;
	console.log('PASS ' + name);
}

async function main() {
	for (const type of ['single', 'multiple', 'judgement', 'completion'] as const)
		await test('explicit candidate uses a validated replacement plan and releases review: ' + type, async () => {
			const f = await fixture(type);
			try {
				const oldConfirm = f.result().confirmReview!;
				const candidate =
					type === 'completion'
						? ['new-0', 'new-1']
						: type === 'judgement'
						? ['错误']
						: type === 'multiple'
						? ['BC']
						: ['B'];
				const actions = registerReviewActions(f.result());
				await requestReviewAction(actions.adopt!, candidate);
				await f.task;
				assert.equal(f.result().result?.finish, true);
				assert.equal(f.result().result?.manual, true);
				assert.equal(f.result().ctx!.searchInfos[0].results[0].answer, candidate.join('#'));
				assert.deepEqual(f.result().ctx!.searchInfos[0].results[0].extra_data, {
					ai: true,
					ai_native: true,
					answers: candidate,
					manual_adopted: true
				});
				assert.deepEqual(f.persisted()[0].results[0].extra_data, f.result().ctx!.searchInfos[0].results[0].extra_data);
				assert.equal(f.calls(), 1, 'adopting a candidate must not call another model');
				assert.deepEqual(
					f.values(),
					type === 'completion'
						? candidate
						: type === 'judgement'
						? [false, true]
						: type === 'multiple'
						? [false, true, true, false]
						: [false, true, false, false]
				);
				await assert.rejects(oldConfirm, /已经确认/);
			} finally {
				await f.cleanup();
			}
		});
	await test('answers absent from current candidates are rejected without querying or page changes', async () => {
		const f = await fixture();
		try {
			const before = f.values();
			await assert.rejects(f.result().applyReviewAnswer!(['D']), /候选回答已变化/);
			await assert.rejects(f.result().applyReviewAnswer!(null as any), /格式无效/);
			assert.deepEqual(f.values(), before);
			assert.equal(f.calls(), 1);
			assert.equal(f.settled(), false);
		} finally {
			await f.cleanup();
		}
	});
	for (const [type, candidate] of [
		['single', ['Z']],
		['multiple', ['AA']],
		['completion', ['one-only']]
	] as const)
		await test('an existing but invalid candidate preserves old page values: ' + type, async () => {
			const f = await fixture(type, true, [[...candidate]]);
			try {
				const before = f.values();
				await assert.rejects(f.result().applyReviewAnswer!([...candidate]));
				assert.deepEqual(f.values(), before);
				assert.equal(f.result().ctx!.searchInfos[0].ensemble!.status, 'review');
				assert.deepEqual(f.result().ctx!.searchInfos[0].results, []);
				assert.equal(f.settled(), false);
			} finally {
				await f.cleanup();
			}
		});
	await test('retry can resolve a pending review without confirming the old candidates', async () => {
		const f = await fixture();
		try {
			const oldInfos = f.result().ctx!.searchInfos;
			const oldConfirm = f.result().confirmReview!;
			f.setResponse(agreed(['C']));
			await f.result().retry!();
			await f.task;
			assert.equal(f.calls(), 2);
			assert.equal(f.result().result!.finish, true);
			assert.equal(oldInfos[0].ensemble!.status, 'review', 'old review was not falsely confirmed');
			assert.equal(oldConfirm.pending!(), false);
			assert.deepEqual(f.values(), [false, false, true, false]);
		} finally {
			await f.cleanup();
		}
	});
	await test('repeated retries that still disagree keep the original queue attached to current reports', async () => {
		const f = await fixture();
		try {
			const oldInfos = f.result().ctx!.searchInfos;
			const confirm = f.result().confirmReview!;
			for (const candidates of [
				[['B'], ['C']],
				[['C'], ['D']]
			]) {
				f.setResponse(review(candidates));
				await assert.rejects(f.result().retry!, /人工/);
				assert.equal(f.result().confirmReview, confirm);
				assert.equal(f.settled(), false);
			}
			(f.root.querySelectorAll('.option')[3] as HTMLElement).click();
			await confirm();
			await f.task;
			assert.equal(f.result().ctx!.searchInfos[0].ensemble!.status, 'confirmed');
			assert.deepEqual(
				f.result().ctx!.searchInfos[0].results,
				[],
				'manual page confirmation must not invent an adopted model answer'
			);
			assert.equal(oldInfos[0].ensemble!.status, 'review');
			assert.deepEqual(f.values(), [false, false, false, true]);
		} finally {
			await f.cleanup();
		}
	});
	await test('a failed retry preserves old values and leaves a usable manual confirmation', async () => {
		const f = await fixture('completion');
		try {
			const before = f.values();
			const confirm = f.result().confirmReview!;
			f.setFailure('offline network failure');
			await assert.rejects(f.result().retry!, /offline network failure/);
			assert.deepEqual(f.values(), before);
			assert.equal(f.result().confirmReview, confirm);
			assert.equal(f.settled(), false);
			await confirm();
			await f.task;
		} finally {
			await f.cleanup();
		}
	});
	await test('pending requests reject duplicate adoption, retry and premature old confirmation', async () => {
		const f = await fixture();
		try {
			const confirm = f.result().confirmReview!;
			const gate = f.gate();
			f.setResponse(agreed(['C']));
			const retry = f.result().retry!();
			await until(() => f.calls() === 2);
			await assert.rejects(f.result().retry!, /等待/);
			await assert.rejects(f.result().applyReviewAnswer!(['A']), /等待/);
			await assert.rejects(confirm, /正在重新请求/);
			gate.resolve();
			await retry;
			await f.task;
		} finally {
			await f.cleanup();
		}
	});
	await test('unsupported platforms expose location and manual confirmation with an explicit reason', async () => {
		const f = await fixture('single', false);
		try {
			const actions = registerReviewActions(f.result());
			assert.equal(actions.adopt, undefined);
			assert.equal(actions.retry, undefined);
			assert.match(actions.unsupportedReason!, /安全替换适配/);
			await requestReviewAction(actions.locate!);
			assert.equal(f.locations(), 1);
			const control = createManualReviewControl({
				reviewActions: actions,
				reviewControl: { id: '', frame: '' },
				resolved: true,
				searchInfos: [{ ensemble: f.result().ctx!.searchInfos[0].ensemble, name: 'review', results: [] }]
			} as any);
			assert.match(control.textContent!, /安全替换适配/);
			await f.result().confirmReview!();
			await f.task;
		} finally {
			await f.cleanup();
		}
	});
	await test('adoption rejects changed question content before any write', async () => {
		const f = await fixture();
		try {
			const before = f.values();
			f.root.querySelector('img')!.src = 'https://example.test/another.png';
			await assert.rejects(f.result().applyReviewAnswer!(['B']), /图片已变化/);
			assert.deepEqual(f.values(), before);
		} finally {
			await f.cleanup();
		}
	});
	for (const type of ['multiple', 'completion'] as const)
		for (const finishBy of ['continue', 'close'] as const)
			await test('candidate application respects pauses between writes: ' + type + '/' + finishBy, async () => {
				const f = await fixture(type);
				const first = deferred();
				try {
					if (type === 'multiple')
						(f.root.querySelector('.option') as HTMLElement).addEventListener(
							'click',
							() => {
								f.worker.emit('stop');
								first.resolve();
							},
							{ once: true }
						);
					else
						f.root.querySelector('textarea')!.addEventListener(
							'input',
							() => {
								f.worker.emit('stop');
								first.resolve();
							},
							{ once: true }
						);
					const candidate = type === 'multiple' ? ['AB'] : ['new-0', 'new-1'];
					const applying = f.result().applyReviewAnswer!(candidate);
					const outcome = applying.then(
						() => undefined,
						(error) => error
					);
					await first.promise;
					await delay(250);
					assert.deepEqual(f.values(), type === 'multiple' ? [true, false, false, false] : ['new-0', 'old-1']);
					assert.equal(f.settled(), false);
					f.worker.emit(finishBy === 'continue' ? 'continuate' : 'close');
					const error = await outcome;
					if (finishBy === 'continue') {
						assert.equal(error, undefined);
						await f.task;
						assert.deepEqual(f.values(), type === 'multiple' ? [true, true, false, false] : candidate);
					} else {
						assert.match(String(error), /关闭|失效/);
						await f.task;
						assert.deepEqual(f.values(), type === 'multiple' ? [true, false, false, false] : ['new-0', 'old-1']);
					}
				} finally {
					await f.cleanup();
				}
			});
	for (const throwProgress of [false, true])
		await test(
			'progress stores serialize, drain before final and ignore late notifications: throw=' + throwProgress,
			async () => {
				const root = document.createElement('section');
				root.innerHTML = '<h3>question</h3><label>A. value</label>';
				document.body.append(root);
				let notify: ((infos: SearchInformation[]) => Promise<void>) | undefined;
				let stored = '';
				let updates = 0;
				let writes = 0;
				const worker = new OCSWorker({
					root: [root],
					elements: { title: 'h3', options: 'label' },
					answerer: async (_elements, ctx) => {
						notify = ctx.onSearchProgress;
						notify!([{ name: 'progress-one', results: [] }]);
						notify!([{ name: 'progress-two', results: [] }]);
						return [{ name: 'final', results: [{ question: 'question', answer: 'A' }] }];
					},
					work: {
						type: 'single',
						optionText: (option) => option.textContent || '',
						handler: () => {
							writes++;
						}
					},
					onResultsUpdate: async (result) => {
						const name = result.ctx?.searchInfos[0]?.name || 'initial';
						updates++;
						if (name.startsWith('progress')) {
							await delay(name.endsWith('one') ? 50 : 10);
							if (throwProgress) throw new Error('offline progress store failure');
						}
						stored = name;
					}
				});
				try {
					await worker.doWork();
					assert.equal(stored, 'final');
					assert.equal(writes, 1);
					const before = updates;
					await notify!([{ name: 'late', results: [] }]);
					assert.equal(updates, before);
					assert.equal(stored, 'final');
				} finally {
					worker.emit('close');
					root.remove();
				}
			}
		);
	await test('a current summary candidate can also be explicitly adopted', async () => {
		const f = await fixture();
		try {
			f.result().ctx!.searchInfos[0].ensemble!.summary = { name: 'summary', answers: ['C'] };
			await f.result().applyReviewAnswer!(['C']);
			await f.task;
			assert.deepEqual(f.values(), [false, false, true, false]);
			assert.equal(f.calls(), 1);
		} finally {
			await f.cleanup();
		}
	});
	await test('review actions wait for all automatic question processing to finish', async () => {
		const f = await fixture();
		try {
			f.all.push({ requested: false, resolved: false });
			await assert.rejects(f.result().applyReviewAnswer!(['B']), /等待当前/);
			await assert.rejects(f.result().retry!, /等待当前/);
			assert.equal(f.calls(), 1);
			f.all.pop();
		} finally {
			await f.cleanup();
		}
	});
	for (const failure of [false, true])
		await test('cross-frame adoption returns actual adapter completion, including failure=' + failure, async () => {
			const f = await fixture();
			const gate = deferred();
			const originalApply = f.result().applyReviewAnswer!;
			f.result().applyReviewAnswer = async (answers) => {
				await gate.promise;
				if (failure) throw new Error('remote adapter failed');
				await originalApply(answers);
			};
			try {
				const address = registerReviewActions(f.result()).adopt!;
				const handler = remoteHandlers.get(address.frame)!;
				assert.equal(typeof handler, 'function');
				cors.emit = (name, args, callback) => {
					assert.equal(name, 'remote-owner');
					Promise.resolve(handler(args!)).then((value) => callback!(value));
				};
				let settled = false;
				const requesting = requestReviewAction({ ...address, frame: 'remote-owner' }, ['B']).then(
					() => {
						settled = true;
						return '';
					},
					(error) => {
						settled = true;
						return String(error);
					}
				);
				await delay(30);
				assert.equal(settled, false, 'transport must not report success from an initial receipt');
				assert.deepEqual(f.values(), [false, false, false, false]);
				gate.resolve();
				const error = await requesting;
				if (failure) {
					assert.match(error, /remote adapter failed/);
					assert.equal(f.settled(), false);
				} else {
					assert.equal(error, '');
					await f.task;
					assert.deepEqual(f.values(), [false, true, false, false]);
				}
			} finally {
				gate.resolve();
				cors.emit = originalEmit;
				await f.cleanup();
			}
		});
	await test('failed adapter application leaves no adopted answer result', async () => {
		const f = await fixture();
		try {
			(f.root.querySelectorAll('.option')[1] as HTMLElement).onclick = () => {};
			await assert.rejects(f.result().applyReviewAnswer!(['B']), /未同步成功/);
			assert.deepEqual(f.result().ctx!.searchInfos[0].results, []);
			assert.equal(f.result().ctx!.searchInfos[0].ensemble!.status, 'review');
			assert.equal(f.settled(), false);
		} finally {
			await f.cleanup();
		}
	});
	await test('adopted answer is cleared if final persistence fails and manual confirmation stays honest', async () => {
		const f = await fixture();
		try {
			f.failNextStore();
			await assert.rejects(f.result().applyReviewAnswer!(['B']), /offline final store failed/);
			assert.deepEqual(f.result().ctx!.searchInfos[0].results, []);
			assert.deepEqual(f.persisted()[0].results, []);
			assert.equal(f.result().ctx!.searchInfos[0].ensemble!.status, 'review');
			assert.equal(f.settled(), false);
			await f.result().confirmReview!();
			await f.task;
			assert.deepEqual(f.result().ctx!.searchInfos[0].results, []);
		} finally {
			await f.cleanup();
		}
	});
	console.log(`AI review actions and ordered progress: ${checks} scenarios passed.`);
}
main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		$.sleep = originalSleep;
		cors.on = originalOn;
		cors.emit = originalEmit;
	});
