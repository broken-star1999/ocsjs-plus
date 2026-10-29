import assert from 'node:assert/strict';
import { $store } from 'easy-us';
import { CommonEvents, CommonProject } from '../packages/scripts/src/projects/common';

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
		console.log(`AI result storage: ${checks} scenarios passed.`);
	} finally {
		$store.getTab = originalGet;
		$store.setTab = originalSet;
		CommonEvents.emitWorkerChanged = originalEmit;
	}
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
