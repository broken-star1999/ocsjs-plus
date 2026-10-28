import { h } from 'easy-us';
import type { AICallDetails } from '@ocsjs/core';

/** Render provider output as plain text, separate from answers and never as HTML. */
export function createAICallDetails(details: AICallDetails): HTMLElement {
	const { call, reasoning } = details;
	const status = { pending: '请求中', success: '已返回答案', uncertain: '无法确定', error: '失败' }[call.status];
	const root = h('section', {
		className: 'ai-call-details',
		style: { borderTop: '1px solid #80808026', marginTop: '10px', paddingTop: '10px', fontSize: '12px' }
	});
	const line = (label: string, value: string) =>
		h('div', {
			textContent: `${label}：${value}`,
			style: { margin: '4px 0', overflowWrap: 'anywhere' }
		});
	root.append(
		h('strong', { textContent: 'AI 调用信息' }),
		line('提供商', call.provider),
		line('模型', call.model),
		line('状态', status),
		line(
			'耗时 / 图片',
			`${call.durationMs === undefined ? '等待响应' : (call.durationMs / 1000).toFixed(2) + ' 秒'} / ${
				call.imageCount
			} 张`
		)
	);
	const usage = call.usage;
	root.append(
		line(
			'Token',
			usage
				? `输入 ${usage.input ?? '未返回'} / 输出 ${usage.output ?? '未返回'} / 总计 ${usage.total ?? '未返回'}`
				: '接口未返回用量'
		)
	);
	if (reasoning) {
		const disclosure = h('details', { className: 'ai-reasoning', style: { marginTop: '8px' } });
		disclosure.append(
			h('summary', { textContent: '思考内容', style: { cursor: 'pointer', padding: '5px 0' } }),
			h('div', {
				className: 'ai-reasoning-content',
				textContent: reasoning,
				style: {
					whiteSpace: 'pre-wrap',
					overflowWrap: 'anywhere',
					maxHeight: '240px',
					overflowY: 'auto',
					padding: '8px',
					borderRadius: '6px',
					background: '#8080800d',
					lineHeight: '1.7'
				}
			})
		);
		if (details.reasoningTruncated) {
			disclosure.append(h('small', { textContent: `思考内容较长，仅保留前 ${reasoning.length} 个字符。` }));
		}
		root.append(disclosure);
	} else {
		root.append(line('思考内容', '接口未返回思考内容'));
	}
	return root;
}
