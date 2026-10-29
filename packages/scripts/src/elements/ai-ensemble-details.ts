import type { AIEnsembleResult } from '@ocsjs/core';
import { h } from 'easy-us';
import { createAICallDetails } from './ai-call-details';

export function createAIEnsembleDetails(ensemble: AIEnsembleResult): HTMLElement {
	return h('section', { className: 'ai-ensemble-details', style: { overflowWrap: 'anywhere' } }, [
		h(
			'strong',
			ensemble.status === 'agreed'
				? '✓ 已达到一致率阈值'
				: ensemble.status === 'summarized'
				? '总结模型已给出结果'
				: ensemble.status === 'confirmed'
				? '已人工处理'
				: '待人工评判 · 不自动填写'
		),
		h('p', ensemble.reason),
		...(ensemble.vote
			? [
					h(
						'p',
						`最多相同回答：${ensemble.vote.count}/${ensemble.vote.total} 次（${
							Math.round((ensemble.vote.count / ensemble.vote.total) * 10000) / 100
						}% 一致率）`
					)
			  ]
			: []),
		...(ensemble.summary ? [ensemble.summary, ...ensemble.members] : ensemble.members).map((member) =>
			h('article', { style: { borderTop: '1px solid #ddd', padding: '8px 0' } }, [
				h('strong', (member === ensemble.summary ? '总结模型：' : '') + member.name),
				h('div', '答案：' + (member.answers?.join(' ｜ ') || '未返回有效答案')),
				...(member.error ? [h('div', { className: 'error' }, member.error)] : []),
				...(member.ai ? [h('details', [h('summary', '调用详情与思考内容'), createAICallDetails(member.ai)])] : [])
			])
		)
	]);
}
