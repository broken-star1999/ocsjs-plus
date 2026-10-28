import { h, $modal } from 'easy-us';
import { clearAICallRecords, getAICallRecords, observeAICallRecords } from '@ocsjs/core';

export function openAICallLog() {
	const root = h('div');
	const summary = h('p', { role: 'status' });
	const list = h('div', { style: { maxHeight: '58vh', overflow: 'auto' } });
	const clear = h('button', { className: 'base-style-button-secondary' }, '清空记录');
	clear.onclick = clearAICallRecords;
	root.append(
		h('p', '仅保留本页面会话最近 100 次 AI 答题/测试记录，刷新后清空。子页面请求会汇总到这里。'),
		h('p', '不记录密钥、完整请求和图片内容；“已返回答案”仅表示通过格式检查，仍需核对答案。'),
		clear,
		summary,
		list
	);
	const render = () => {
		const records = getAICallRecords();
		summary.textContent = `共 ${records.length} 条 · 等待中 ${records.filter((r) => r.status === 'pending').length}`;
		list.replaceChildren(
			...records.map((record) => {
				const status = { pending: '请求中', success: '已返回答案', uncertain: '无法确定', error: '失败' }[
					record.status
				];
				const usage = record.usage;
				return h('article', { style: { borderTop: '1px solid #80808033', padding: '12px 0' } }, [
					h('strong', `${status} · ${record.provider} / ${record.model}`),
					h('div', { style: { margin: '6px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, record.question),
					h(
						'small',
						`${new Date(record.startedAt).toLocaleTimeString()} · ${record.imageCount} 张图片 · ` +
							(record.durationMs === undefined ? '等待响应' : `${(record.durationMs / 1000).toFixed(2)} 秒`)
					),
					h(
						'div',
						usage
							? `Token：输入 ${usage.input ?? '未返回'} / 输出 ${usage.output ?? '未返回'} / 总计 ${
									usage.total ?? '未返回'
							  }`
							: 'Token：接口未返回用量'
					),
					...(record.error ? [h('div', { style: { color: '#c0392b', marginTop: '6px' } }, record.error)] : [])
				]);
			})
		);
		if (!records.length) list.append(h('p', '暂无调用记录。发起 AI 搜题或测试模型后会显示在这里。'));
	};
	render();
	const stop = observeAICallRecords(render);
	const close = h('button', { className: 'base-style-button-secondary' }, '关闭');
	const modal: HTMLDivElement | undefined = $modal.simple({
		title: 'AI 调用记录',
		content: root,
		width: 760,
		onClose: stop,
		footer: h('div', [close])
	});
	close.onclick = () => {
		stop();
		modal?.remove();
	};
}
