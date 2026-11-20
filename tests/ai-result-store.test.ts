import assert from 'node:assert/strict';
import { $message, $store, cors } from 'easy-us';
import { OCSWorker } from '../packages/core/src/core/worker/worker';
import type { SimplifyWorkResult, WorkResult } from '../packages/core/src/core/worker/interface';
import {
	registerQuestionRetry,
	requestReviewAction,
	serializeManualReview
} from '../packages/scripts/src/utils/question-retry-control';

// Exercise the top-frame handler directly while replacing the userscript transport.
const defineTopFunction = cors.defineTopFunction;
cors.defineTopFunction = (handler) => handler;
const { CommonEvents, CommonProject } =
	require('../packages/scripts/src/projects/common') as typeof import('../packages/scripts/src/projects/common');
const { dynamicWorkTips, simplifyWorkResult, updateDynamicResult } =
	require('../packages/scripts/src/utils/work') as typeof import('../packages/scripts/src/utils/work');
cors.defineTopFunction = defineTopFunction;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let checks = 0;
const result = (question: string, completed: number): any => ({
	question,
	type: 'single',
	requested: false,
	resolved: false,
	searching: true,
	searchInfos: [
		{
			name: '联合答题',
			results: [],
			ensemble: { status: 'running', reason: '', members: [], progress: { stage: 'members', completed, total: 4 } }
		}
	]
});
async function main() {
	const originalGet = $store.getTab;
	const originalSet = $store.setTab;
	const originalEmit = CommonEvents.emitWorkerChanged;
	const originalOn = cors.on;
	const originalTabListener = $store.addTabChangeListener;
	const originalWarning = $message.warn;
	const frameHandlers = new Map<string, (args: any[]) => Promise<any>>();
	let tabChanged: ((current: unknown, previous: unknown) => void) | undefined;
	let stored: any[] = [];
	let fail = false;
	($store as any).getTab = async () => {
		const snapshot = copy(stored);
		await delay(5);
		return snapshot;
	};
	($store as any).setTab = async (_key: string, next: any[]) => {
		await delay(5);
		if (fail) {
			fail = false;
			throw new Error('fixture write failed');
		}
		stored = copy(next);
	};
	(CommonEvents as any).emitWorkerChanged = () => {};
	cors.on = async (name, handler) => {
		frameHandlers.set(name, async (args) => handler(args));
		return 0;
	};
	($store as any).addTabChangeListener = (_key: string, handler: typeof tabChanged) => {
		tabChanged = handler;
	};
	($message as any).warn = () => undefined;
	const fromPanel = (address: NonNullable<SimplifyWorkResult['reviewControl']>) => {
		const handler = frameHandlers.get(address.frame);
		assert.ok(handler, 'the owner frame registered its receive handler');
		return handler([address.id, Date.now() + 3000]);
	};
	const methods = CommonProject.scripts.workResults.methods;
	try {
		await Promise.all([methods.update(0, result('第一题', 1)), methods.update(1, result('第二题', 2))]);
		assert.equal(stored[0].question, '第一题');
		assert.equal(stored[1].question, '第二题');
		checks++;
		console.log('PASS concurrent question progress preserves both stored rows');
		await Promise.all([methods.update(0, result('第一题', 2)), methods.update(0, result('第一题', 4))]);
		assert.equal(stored[0].searchInfos[0].ensemble.progress.completed, 4);
		checks++;
		console.log('PASS same-question progress preserves submission order');
		const update = methods.update(0, result('即将清空', 3));
		const clear = methods.clearResults();
		await Promise.all([update, clear]);
		assert.deepEqual(stored, []);
		checks++;
		console.log('PASS clearing results follows already queued progress');
		fail = true;
		await assert.rejects(methods.update(0, result('失败写入', 1)), /fixture write failed/);
		await methods.update(0, result('后续结果', 4));
		assert.equal(stored[0].question, '后续结果');
		checks++;
		console.log('PASS a rejected write does not poison subsequent result updates');
		const pending = methods.update(1, result('读取等待', 4));
		const read = methods.getResults();
		const data = await read;
		await pending;
		assert.equal(data[1].question, '读取等待');
		checks++;
		console.log('PASS result reads wait for queued writes');
		await Promise.all([methods.append(result('动态第一题', 1)), methods.append(result('动态第二题', 2))]);
		assert.ok(stored.find((row) => row.question === '动态第一题'));
		assert.ok(stored.find((row) => row.question === '动态第二题'));
		checks++;
		console.log('PASS dynamic question appends preserve concurrent reports');

		let skipped = 0;
		const failed = {
			question: '可跳过的题',
			type: 'single' as const,
			requested: true,
			resolved: true,
			finish: false,
			searchInfos: [],
			_skip: async () => {
				skipped++;
			}
		};
		await methods.fillAll([failed]);
		const action = stored[0].skipControl;
		assert.equal(stored[0]._skip, undefined);
		await requestReviewAction(action);
		assert.equal(skipped, 1);
		await methods.clearResults();
		await assert.rejects(requestReviewAction(action), /跳过入口已失效/);
		assert.equal(skipped, 1);
		checks++;
		console.log('PASS serialized skip controls expire when a work-result list is cleared');

		let retries = 0;
		const owner: WorkResult<{}> = {
			requested: true,
			resolved: true,
			result: { finish: true },
			retry: async () => {
				retries++;
			}
		};
		const standalone = registerQuestionRetry(owner)!;
		await methods.update(
			0,
			simplifyWorkResult(owner, () => '同题两种登记')
		);
		const managed = stored[0].retry;
		assert.notEqual(standalone.id, managed.id);
		assert.equal(await fromPanel(managed), '');
		await methods.clearResults();
		assert.match(await fromPanel(managed), /题目操作入口已失效/);
		await requestReviewAction(standalone);
		assert.equal(retries, 2);
		await assert.rejects(
			methods.update(
				0,
				simplifyWorkResult(owner, () => '旧结果')
			),
			/已清空或替换/
		);
		assert.deepEqual(await methods.getResults(), []);
		checks++;
		console.log('PASS only the managed address retires, and a cleared result cannot be republished');

		let state = '';
		const reviewOwner: WorkResult<{}> = {
			requested: true,
			resolved: true,
			result: { finish: false },
			confirmReview: async () => {
				state = 'published callback';
			}
		};
		const reviewSummary = () => simplifyWorkResult(reviewOwner, () => '人工确认');
		const notPublished = serializeManualReview(reviewSummary(), methods.getResults).reviewControl!;
		fail = true;
		await assert.rejects(methods.update(0, reviewSummary()), /fixture write failed/);
		assert.match(await fromPanel(notPublished), /题目操作入口已失效/);
		assert.equal(state, '');
		await methods.update(0, reviewSummary());
		const published = stored[0].reviewControl;
		assert.equal(published.id, notPublished.id);
		reviewOwner.confirmReview = async () => {
			state = 'updated callback';
		};
		fail = true;
		await assert.rejects(methods.update(0, reviewSummary()), /fixture write failed/);
		assert.equal(await fromPanel(published), '');
		assert.equal(state, 'published callback');
		const nextWrite = methods.update(0, reviewSummary());
		assert.ok(tabChanged);
		tabChanged([], []);
		await nextWrite;
		assert.equal(await fromPanel(published), '');
		assert.equal(state, 'updated callback');
		const previous = stored;
		stored = [];
		tabChanged(stored, previous);
		assert.match(await fromPanel(published), /题目操作入口已失效/);
		assert.deepEqual(await methods.getResults(), []);
		checks++;
		console.log('PASS cross-frame receipts use committed callbacks and ignore stale tab notifications');

		const ready = { ...failed, _skip: undefined };
		for (const busy of [
			{ ...ready, requested: false, resolved: false, searching: true },
			{ ...ready, retrying: true },
			{ ...ready, searchInfos: [{ name: 'AI', results: [], ensemble: { status: 'review', members: [] } }] }
		]) {
			await methods.fillAll([busy]);
			await assert.rejects(methods.clearInactiveResults(), /完成后再清空/);
			assert.equal((await methods.getResults()).length, 1);
		}
		await methods.fillAll([ready]);
		await methods.clearInactiveResults();
		assert.deepEqual(await methods.getResults(), []);
		checks++;
		console.log('PASS manual clear protects automatic processing, retry and pending review');

		const root = document.createElement('section');
		root.innerHTML = '<h3>人工处理中的题目</h3><label>A</label><label>B</label>';
		document.body.append(root);
		const worker = new OCSWorker({
			root: [root],
			elements: { title: 'h3', options: 'label' },
			work: { type: 'single', handler: () => assert.fail('review never fills automatically') },
			answerer: async () => [
				{
					name: 'fixture models',
					results: [],
					ensemble: {
						status: 'review',
						members: [
							{ name: 'a', answers: ['A'] },
							{ name: 'b', answers: ['B'] }
						]
					}
				}
			],
			onResultsUpdate: (row) => updateDynamicResult(row, (titles) => titles[0]?.textContent ?? '')
		});
		dynamicWorkTips(worker);
		const task = worker.doWork();
		try {
			for (let index = 0; index < 100 && !stored[0]?.reviewControl; index++) await delay(10);
			const confirm = stored[0]?.reviewControl;
			assert.ok(confirm, 'the worker entered human review');
			worker.emit('stop');
			await assert.rejects(methods.clearInactiveResults(), /完成后再清空/);
			worker.emit('close');
			await task;
			worker.emit('done'); // Some consumers emit done while unwinding a closed worker.
			await methods.clearInactiveResults();
			assert.match(await fromPanel(confirm), /题目操作入口已失效/);
			assert.deepEqual(await methods.getResults(), []);
		} finally {
			if (!worker.isClose) worker.emit('close');
			await task.catch(() => {});
			root.remove();
		}
		checks++;
		console.log('PASS pause preserves a live review; close allows clear and stale confirmation cannot restore it');
		console.log(`AI result storage: ${checks} scenarios passed.`);
	} finally {
		$store.getTab = originalGet;
		$store.setTab = originalSet;
		CommonEvents.emitWorkerChanged = originalEmit;
		cors.on = originalOn;
		$store.addTabChangeListener = originalTabListener;
		$message.warn = originalWarning;
	}
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
