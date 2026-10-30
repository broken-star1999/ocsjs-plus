import assert from 'node:assert/strict';
import { OCSWorker, CustomOCSWorker } from '../packages/core/src/core/worker/worker';
import { AnswerWrapperHandlerConfig } from '../packages/core/src/core/answer-wrapper/answer.wrapper.handler';
import { CommonProject } from '../packages/scripts/src/projects/common';
import { BackgroundProject } from '../packages/scripts/src/projects/background';
import { isAIQuestionCacheSource } from '../packages/scripts/src/utils/question-cache';
import { $, $store } from 'easy-us';

let checks = 0;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function test(name: string, action: () => Promise<void> | void) {
	await action();
	checks++;
	console.log('PASS ' + name);
}
async function finishes(task: Promise<unknown>): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			task.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), 1200);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, resolve: release };
}

async function main() {
	await test('fresh upload settings use 80 percent while existing explicit settings are preserved', () => {
		const originalGet = $store.get;
		const originalSet = $store.set;
		const stored = new Map<string, unknown>();
		$store.get = ((key: string, fallback: unknown) => (stored.has(key) ? stored.get(key) : fallback)) as any;
		$store.set = ((key: string, value: unknown) => stored.set(key, value)) as any;
		try {
			const initialize = () =>
				$.createConfigProxy({
					namespace: 'test.upload-default',
					configs: { upload: CommonProject.scripts.settings.configs.upload },
					cfg: {}
				} as any);
			assert.equal(initialize().upload, 80);
			for (const choice of ['save', 'nomove', 100]) {
				stored.set('test.upload-default.upload', choice);
				assert.equal(initialize().upload, choice);
			}
		} finally {
			$store.get = originalGet;
			$store.set = originalSet;
		}
	});
	await test('default upload policy submits at 80 percent of successful fills after answering finishes', () => {
		const type = CommonProject.scripts.settings.configs.upload.defaultValue;
		assert.equal(type, 80);
		const worker = new OCSWorker({
			root: [],
			elements: { title: 'h3', options: 'label' },
			answerer: async () => [],
			work: { type: 'single', handler: () => {} }
		});
		for (const finished of [0, 79, 80, 81, 100]) {
			const calls: [number, boolean][] = [];
			worker.uploadHandler({
				type,
				results: Array.from({ length: 100 }, (_, index) => ({
					requested: true,
					resolved: true,
					ctx: { searchInfos: [{ name: 'found', results: [{ question: 'q', answer: 'A' }] }] },
					result: { finish: index < finished }
				})) as any,
				callback: (rate, uploadable) => {
					calls.push([rate, uploadable]);
				}
			});
			assert.deepEqual(calls, [[finished, finished >= 80]], `successful fills: ${finished}/100`);
		}
		const emptyCalls: [number, boolean][] = [];
		worker.uploadHandler({
			type,
			results: [],
			callback: (rate, uploadable) => {
				emptyCalls.push([rate, uploadable]);
			}
		});
		assert.deepEqual(emptyCalls, [[0, false]]);
	});
	await test('default 80 percent upload still waits for pending human review and respects worker closure', () => {
		const worker = new OCSWorker({
			root: [],
			elements: { title: 'h3', options: 'label' },
			answerer: async () => [],
			work: { type: 'single', handler: () => {} }
		});
		const results: any[] = Array.from({ length: 5 }, (_, index) => ({
			ctx: { searchInfos: [] },
			result: { finish: index < 4 }
		}));
		results[4].ctx.searchInfos = [
			{ name: 'AI', results: [], ensemble: { status: 'review', reason: '模型答案不一致', members: [] } }
		];
		let calls = 0;
		const options = {
			type: CommonProject.scripts.settings.configs.upload.defaultValue,
			results,
			callback: () => {
				calls++;
			}
		};
		worker.uploadHandler(options);
		assert.equal(calls, 0, '80 percent filled must not bypass a pending review');
		results[4].ctx.searchInfos = [];
		worker.isClose = true;
		worker.uploadHandler(options);
		assert.equal(calls, 0, 'closed worker must not save or submit');
	});
	for (const [name, source] of [
		['native metadata', { results: [['question', 'B', { ai_native: true, answers: ['B'] }]] }],
		['AI metadata', { results: [['question', 'B', { ai: true }]] }],
		['call details', { ai: { call: {} }, results: [['question', 'B', {}]] }],
		['ensemble details', { ensemble: { status: 'agreed' }, results: [['question', 'B', {}]] }]
	] as const) {
		await test('AI cache provenance survives a disabled global switch: ' + name, async () => {
			const info: any = { name: 'user-renamed-provider', ...source };
			assert.equal(isAIQuestionCacheSource(info), true);
			CommonProject.scripts.settings.cfg.aiEnabled = false;
			CommonProject.scripts.settings.cfg.enableQuestionCaches = true;
			BackgroundProject.scripts.data.cfg.localQuestionCaches = [];
			const result: any = {
				question: 'question',
				type: 'single',
				finish: true,
				requested: true,
				resolved: true,
				searchInfos: [info]
			};
			const originalGet = $store.getTab;
			const originalSet = $store.setTab;
			let tab: unknown[] = [];
			$store.getTab = (async () => tab) as any;
			$store.setTab = (async (_key: string, value: unknown[]) => {
				tab = value;
			}) as any;
			try {
				await CommonProject.scripts.workResults.methods.update(0, result);
				assert.equal(BackgroundProject.scripts.data.cfg.localQuestionCaches.length, 0);
				BackgroundProject.scripts.data.methods.addQuestionCacheFromWorkResult([result]);
				assert.equal(BackgroundProject.scripts.data.cfg.localQuestionCaches.length, 0);
			} finally {
				$store.getTab = originalGet;
				$store.setTab = originalSet;
			}
		});
	}
	await test('ordinary answers still enter the legacy cache and mixed results exclude only AI sources', () => {
		const legacy: any = { name: 'ordinary', results: [['question', 'text answer', {}]] };
		const ai: any = { name: 'AI', results: [['question', 'B', { ai_native: true }]] };
		assert.equal(isAIQuestionCacheSource(legacy), false);
		BackgroundProject.scripts.data.cfg.localQuestionCaches = [];
		BackgroundProject.scripts.data.methods.addQuestionCacheFromWorkResult([
			{ question: 'question', searchInfos: [legacy, ai] } as any
		]);
		assert.deepEqual(
			BackgroundProject.scripts.data.cfg.localQuestionCaches.map((item) => item.answer),
			['text answer']
		);
	});
	for (const kind of ['default', 'custom'] as const)
		await test('closing a paused worker releases it without querying or filling: ' + kind, async () => {
			let queries = 0;
			let fills = 0;
			const root = document.createElement('section');
			root.innerHTML = '<h3>question</h3><label>A</label>';
			document.body.append(root);
			const worker: OCSWorker<any> | CustomOCSWorker =
				kind === 'default'
					? new OCSWorker({
							root: [root],
							elements: { title: 'h3', options: 'label' },
							thread: 1,
							onResultsInit: async () => {
								worker.emit('stop');
							},
							answerer: async () => {
								queries++;
								return [{ name: 'mock', results: [{ question: 'question', answer: 'A' }] }];
							},
							work: {
								type: 'single',
								handler: async () => {
									fills++;
								}
							}
					  })
					: new CustomOCSWorker({
							questions: () => {
								worker.emit('stop');
								return [{ text: 'question', type: 'single' }];
							},
							answerer: async () => {
								queries++;
								return [];
							},
							resolver: async () => {
								fills++;
								return { finish: true };
							},
							period: 0
					  });
			const task = worker.doWork();
			try {
				await delay(250);
				worker.emit('close');
				assert.equal(await finishes(task), true, 'closed paused task must settle');
				worker.emit('continuate');
				await delay(30);
				assert.equal(queries, 0);
				assert.equal(fills, 0);
				assert.equal(worker.isRunning, false);
			} finally {
				worker.emit('close');
				worker.emit('continuate');
				await task;
				root.remove();
			}
		});
	await test('closing during the searching status callback cannot start an answer request', async () => {
		let queries = 0;
		const root = document.createElement('section');
		root.innerHTML = '<h3>question</h3><label>A</label>';
		document.body.append(root);
		const worker = new OCSWorker({
			root: [root],
			elements: { title: 'h3', options: 'label' },
			thread: 1,
			answerer: async () => {
				queries++;
				return [];
			},
			work: { type: 'single', handler: async () => {} },
			onResultsUpdate: async (result) => {
				if (result.searching) worker.emit('close');
			}
		});
		try {
			assert.equal(await finishes(worker.doWork()), true);
			assert.equal(queries, 0);
		} finally {
			worker.emit('close');
			root.remove();
		}
	});
	for (const asynchronous of [false, true])
		await test('custom status callback closes before resolving, async=' + asynchronous, async () => {
			let queries = 0;
			let fills = 0;
			const worker = new CustomOCSWorker({
				questions: () => [
					{ text: 'first', type: 'single' },
					{ text: 'second', type: 'single' }
				],
				answerer: async () => {
					queries++;
					return [];
				},
				resolver: async () => {
					fills++;
					return { finish: true };
				},
				onResultsUpdate: async (result) => {
					if (result.requested && !result.resolved) {
						if (asynchronous) await delay(20);
						worker.emit('close');
					}
				},
				period: 0
			});
			try {
				assert.equal(await finishes(worker.doWork()), true);
				assert.equal(queries, 1);
				assert.equal(fills, 0);
			} finally {
				worker.emit('close');
			}
		});
	for (const type of ['multiple', 'completion'] as const)
		for (const native of [false, true])
			await test(
				'closing after the first fill blocks later writes and status updates: ' + type + '/native=' + native,
				async () => {
					let fills = 0;
					let lateUpdates = 0;
					const root = document.createElement('section');
					root.innerHTML = '<h3>question</h3><label>A. first</label><label>B. second</label>';
					document.body.append(root);
					const answers = type === 'multiple' ? ['AB'] : ['one', 'two'];
					const worker = new OCSWorker({
						root: [root],
						elements: { title: 'h3', options: 'label' },
						thread: 1,
						answerSeparators: ['#'],
						answerer: async () => [
							{
								name: 'mock',
								results: [
									{
										question: 'question',
										answer: answers.join('#'),
										extra_data: native ? { ai_native: true, answers } : {}
									}
								]
							}
						],
						work: {
							type,
							optionText: (option) => option.textContent || '',
							handler: async () => {
								fills++;
								worker.emit('close');
							}
						},
						onResultsUpdate: async () => {
							if (worker.isClose) lateUpdates++;
						}
					});
					try {
						assert.equal(await finishes(worker.doWork()), true);
						assert.equal(fills, 1);
						assert.equal(lateUpdates, 0);
					} finally {
						worker.emit('close');
						root.remove();
					}
				}
			);
	await test('resuming without closing still queries and fills normally', async () => {
		let queries = 0;
		let fills = 0;
		const worker = new CustomOCSWorker({
			questions: () => {
				worker.emit('stop');
				return [{ text: 'question', type: 'single' }];
			},
			answerer: async () => {
				queries++;
				return [];
			},
			resolver: async () => {
				fills++;
				return { finish: true };
			},
			period: 0
		});
		const task = worker.doWork();
		await delay(50);
		worker.emit('continuate');
		try {
			assert.equal(await finishes(task), true);
			assert.equal(queries, 1);
			assert.equal(fills, 1);
		} finally {
			worker.emit('close');
		}
	});
	for (const kind of ['default', 'custom'] as const)
		for (const finishBy of ['continue', 'close'] as const)
			await test('response arriving while paused cannot fill or finish: ' + kind + '/' + finishBy, async () => {
				const started = deferred();
				const response = deferred();
				const root = document.createElement('section');
				root.innerHTML = '<h3>question</h3><label>A. first</label><label>B. second</label>';
				document.body.append(root);
				let fills = 0;
				let settled = false;
				const answerer = async () => {
					started.resolve();
					await response.promise;
					return [
						{
							name: 'AI',
							results: [{ question: 'question', answer: 'B', extra_data: { ai_native: true, answers: ['B'] } }]
						}
					];
				};
				const worker =
					kind === 'default'
						? new OCSWorker({
								root: [root],
								elements: { title: 'h3', options: 'label' },
								answerer,
								work: {
									type: 'single',
									optionText: (option) => option.textContent || '',
									handler: () => {
										fills++;
									}
								}
						  })
						: new CustomOCSWorker({
								questions: () => [{ text: 'question', type: 'single' }],
								answerer,
								resolver: async () => {
									fills++;
									return { finish: true };
								},
								period: 0
						  });
				const task = worker.doWork().then(() => {
					settled = true;
				});
				try {
					await started.promise;
					worker.emit('stop');
					response.resolve();
					await delay(300);
					assert.equal(fills, 0, 'paused response must not reach a page handler');
					assert.equal(settled, false, 'last question must not complete while paused');
					assert.equal(worker.isRunning, true);
					worker.emit(finishBy === 'continue' ? 'continuate' : 'close');
					assert.equal(await finishes(task), true);
					assert.equal(fills, finishBy === 'continue' ? 1 : 0);
					assert.equal(worker.isRunning, false);
				} finally {
					response.resolve();
					worker.emit('close');
					await task;
					root.remove();
				}
			});
	for (const kind of ['default', 'custom'] as const)
		for (const finishBy of ['continue', 'close'] as const)
			await test(
				'pause from an asynchronous requested-status callback gates the resolver: ' + kind + '/' + finishBy,
				async () => {
					const paused = deferred();
					const root = document.createElement('section');
					root.innerHTML = '<h3>question</h3><label>A. first</label>';
					document.body.append(root);
					let fills = 0;
					let settled = false;
					const update = async (result: any) => {
						if (result.requested && !result.resolved) {
							await delay(20);
							worker.emit('stop');
							paused.resolve();
						}
					};
					const worker: OCSWorker<any> | CustomOCSWorker =
						kind === 'default'
							? new OCSWorker({
									root: [root],
									elements: { title: 'h3', options: 'label' },
									answerer: async () => [{ name: 'mock', results: [{ question: 'question', answer: 'A' }] }],
									work: {
										type: 'single',
										optionText: (option) => option.textContent || '',
										handler: () => {
											fills++;
										}
									},
									onResultsUpdate: update
							  })
							: new CustomOCSWorker({
									questions: () => [{ text: 'question', type: 'single' }],
									answerer: async () => [],
									resolver: async () => {
										fills++;
										return { finish: true };
									},
									onResultsUpdate: update,
									period: 0
							  });
					const task = worker.doWork().then(() => {
						settled = true;
					});
					try {
						await paused.promise;
						await delay(300);
						assert.equal(fills, 0);
						assert.equal(settled, false);
						worker.emit(finishBy === 'continue' ? 'continuate' : 'close');
						assert.equal(await finishes(task), true);
						assert.equal(fills, finishBy === 'continue' ? 1 : 0);
					} finally {
						worker.emit('close');
						await task;
						root.remove();
					}
				}
			);
	for (const type of ['multiple', 'completion'] as const)
		for (const native of [false, true])
			for (const finishBy of ['continue', 'close'] as const)
				await test(
					'pause between page writes keeps remaining choices/blanks untouched: ' +
						type +
						'/native=' +
						native +
						'/' +
						finishBy,
					async () => {
						const paused = deferred();
						const root = document.createElement('section');
						root.innerHTML = '<h3>question</h3><label>A. first</label><label>B. second</label>';
						document.body.append(root);
						const answers = type === 'multiple' ? ['AB'] : ['one', 'two'];
						const written: number[] = [];
						let queries = 0;
						let settled = false;
						const worker = new OCSWorker({
							root: [root],
							elements: { title: 'h3', options: 'label' },
							answerSeparators: ['#'],
							answerer: async () => {
								queries++;
								return [
									{
										name: 'mock',
										results: [
											{
												question: 'question',
												answer: answers.join('#'),
												extra_data: native ? { ai_native: true, answers } : {}
											}
										]
									}
								];
							},
							work: {
								type,
								optionText: (option) => option.textContent || '',
								handler: async (_type, _answer, option, ctx) => {
									written.push(ctx.elements.options!.indexOf(option));
									if (written.length === 1) {
										worker.emit('stop');
										await delay(20);
										paused.resolve();
									}
								}
							}
						});
						const task = worker.doWork().then(() => {
							settled = true;
						});
						try {
							await paused.promise;
							await delay(250);
							assert.deepEqual(written, [0]);
							assert.equal(settled, false);
							worker.emit(finishBy === 'continue' ? 'continuate' : 'close');
							assert.equal(await finishes(task), true);
							assert.deepEqual(
								written,
								finishBy === 'continue' ? [0, 1] : [0],
								'resume continues only the remaining writes'
							);
							assert.equal(queries, 1, 'resume must not re-query or restart the question');
						} finally {
							worker.emit('close');
							await task;
							root.remove();
						}
					}
				);
	for (const kind of ['default', 'custom'] as const)
		await test('pausing in the last resolved-status callback prevents task completion: ' + kind, async () => {
			const paused = deferred();
			const root = document.createElement('section');
			root.innerHTML = '<h3>question</h3><label>A. first</label>';
			document.body.append(root);
			let settled = false;
			const update = async (result: any) => {
				if (result.resolved) {
					await delay(20);
					worker.emit('stop');
					paused.resolve();
				}
			};
			const worker: OCSWorker<any> | CustomOCSWorker =
				kind === 'default'
					? new OCSWorker({
							root: [root],
							elements: { title: 'h3', options: 'label' },
							answerer: async () => [{ name: 'mock', results: [{ question: 'question', answer: 'A' }] }],
							work: { type: 'single', optionText: (option) => option.textContent || '', handler: () => {} },
							onResultsUpdate: update
					  })
					: new CustomOCSWorker({
							questions: () => [{ text: 'question', type: 'single' }],
							answerer: async () => [],
							resolver: async () => ({ finish: true }),
							onResultsUpdate: update,
							period: 0
					  });
			const task = worker.doWork().then(() => {
				settled = true;
			});
			try {
				await paused.promise;
				await delay(250);
				assert.equal(settled, false);
				assert.equal(worker.isRunning, true);
				worker.emit('continuate');
				assert.equal(await finishes(task), true);
			} finally {
				worker.emit('close');
				await task;
				root.remove();
			}
		});
	await test('pausing during the asynchronous searching status prevents the request until resumed', async () => {
		const paused = deferred();
		const root = document.createElement('section');
		root.innerHTML = '<h3>question</h3><label>A. first</label>';
		document.body.append(root);
		let queries = 0;
		const worker = new OCSWorker({
			root: [root],
			elements: { title: 'h3', options: 'label' },
			answerer: async () => {
				queries++;
				return [];
			},
			work: { type: 'single', handler: () => {} },
			onResultsUpdate: async (result) => {
				if (result.searching) {
					await delay(20);
					worker.emit('stop');
					paused.resolve();
				}
			}
		});
		const task = worker.doWork();
		try {
			await paused.promise;
			await delay(250);
			assert.equal(queries, 0);
			worker.emit('continuate');
			assert.equal(await finishes(task), true);
			assert.equal(queries, 1);
		} finally {
			worker.emit('close');
			await task;
			root.remove();
		}
	});
	await test('a long pause before querying does not exhaust the resolver wait window', async () => {
		const beforeTimeout = AnswerWrapperHandlerConfig.timeout_seconds;
		// Keep a 200ms ordinary grace window so this test can pause beyond it.
		AnswerWrapperHandlerConfig.timeout_seconds = -9.8;
		const paused = deferred();
		const root = document.createElement('section');
		root.innerHTML = '<h3>question</h3><label>A. first</label>';
		document.body.append(root);
		let fills = 0;
		const worker = new OCSWorker({
			root: [root],
			elements: { title: 'h3', options: 'label' },
			answerer: async () => {
				await delay(60);
				return [{ name: 'mock', results: [{ question: 'question', answer: 'A' }] }];
			},
			work: {
				type: 'single',
				optionText: (option) => option.textContent || '',
				handler: () => {
					fills++;
				}
			},
			onResultsUpdate: async (result) => {
				if (result.searching) {
					worker.emit('stop');
					paused.resolve();
				}
			}
		});
		const task = worker.doWork();
		try {
			await paused.promise;
			await delay(500);
			assert.equal(fills, 0);
			worker.emit('continuate');
			assert.equal(await finishes(task), true);
			assert.equal(fills, 1, 'resume must still wait for and apply the fresh response');
		} finally {
			worker.emit('close');
			await task;
			root.remove();
			AnswerWrapperHandlerConfig.timeout_seconds = beforeTimeout;
		}
	});
	console.log(`Work safety: ${checks} scenarios passed.`);
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
