import type { AIEnsembleResult } from '@ocsjs/core';
import { h } from 'easy-us';
import { createAICallDetails } from './ai-call-details';

export interface AIReviewActions {
	/** Explicit user action only; rendering never adopts an answer. */
	adopt?: (answers: string[]) => Promise<void>;
}

interface EnsembleDisplayOptions {
	type?: string;
	reviewActions?: AIReviewActions;
	includeSummary?: boolean;
}

function answerGroups(ensemble: AIEnsembleResult) {
	const groups = new Map<string, { answers: string[]; members: AIEnsembleResult['members'] }>();
	for (const member of ensemble.members) {
		if (member.error || !member.answers?.length) continue;
		const normalized = member.normalizedAnswers || member.answers.map((answer) => answer.trim());
		const key = JSON.stringify(normalized);
		const group = groups.get(key) || { answers: member.answers, members: [] };
		group.members.push(member);
		groups.set(key, group);
	}
	return [...groups.values()].sort((left, right) => right.members.length - left.members.length);
}

function shortAnswers(answers: string[], type?: string) {
	const text = answers
		.map((answer, index) => (type === 'completion' ? `第 ${index + 1} 空：` : '') + answer.replace(/\s+/g, ' '))
		.join(' / ');
	return text.length > 100 ? text.slice(0, 100) + '…' : text;
}

/** Copy exact values, without human-readable blank labels. */
export function createAIAnswerCopyButton(answers: string[]): HTMLButtonElement {
	const button = h('button', { type: 'button', className: 'base-style-button-secondary' }, '复制答案');
	button.onclick = async () => {
		try {
			await navigator.clipboard.writeText(answers.join('\n'));
			button.textContent = '已复制';
		} catch {
			button.textContent = '复制失败，请手动复制';
		}
	};
	return button;
}

/** Short decision and progress stay visible when the candidates are collapsed. */
export function createAIEnsembleSummary(ensemble: AIEnsembleResult, type?: string): HTMLElement {
	const progress = ensemble.progress;
	const title =
		ensemble.status === 'running'
			? progress?.stage === 'summary'
				? '正在总结核对'
				: '模型正在作答'
			: ensemble.status === 'agreed'
			? '✓ 已达到一致率阈值'
			: ensemble.status === 'summarized'
			? '总结模型已给出结果'
			: ensemble.status === 'selected'
			? '已采用指定的主观题回答'
			: ensemble.status === 'confirmed'
			? '已人工处理'
			: '待人工评判 · 不自动填写';
	const root = h(
		'section',
		{
			className: 'ai-ensemble-summary',
			style: { padding: '10px 12px', overflowWrap: 'anywhere', fontSize: '12px', lineHeight: '1.7' }
		},
		[h('strong', { textContent: title }), h('div', { textContent: ensemble.reason })]
	);
	if (progress)
		root.append(
			h('div', {
				className: 'ai-ensemble-progress',
				role: 'status',
				textContent:
					`独立作答 ${progress.completed}/${progress.total} 已返回` +
					(progress.stage === 'summary' ? ' · 正在调用总结模型' : progress.stage === 'members' ? ' · 等待其余回答' : '')
			})
		);
	const groups = answerGroups(ensemble);
	const failed = ensemble.members.filter((member) => member.error).length;
	if (groups.length || failed)
		root.append(
			h('div', {
				className: 'ai-ensemble-groups-summary',
				textContent:
					(type === 'completion' ? '文本分组（仅供对照）：' : '候选分组：') +
					groups.map((group) => `${shortAnswers(group.answers, type)} × ${group.members.length}`).join('；') +
					(failed ? `${groups.length ? '；' : ''}失败/无效 ${failed} 次` : '')
			})
		);
	if (ensemble.vote && ensemble.vote.total > 0)
		root.append(
			h('div', {
				textContent: `最多相同回答：${ensemble.vote.count}/${ensemble.vote.total} 次（${
					Math.round((ensemble.vote.count / ensemble.vote.total) * 10000) / 100
				}% 一致率）`
			})
		);
	return root;
}

/** Candidate values and provider output are text nodes, never HTML. */
export function createAIEnsembleDetails(ensemble: AIEnsembleResult, options: EnsembleDisplayOptions = {}): HTMLElement {
	const root = h('section', { className: 'ai-ensemble-details', style: { overflowWrap: 'anywhere' } });
	if (options.includeSummary !== false) root.append(createAIEnsembleSummary(ensemble, options.type));
	const canAdopt =
		ensemble.status === 'review' &&
		['single', 'multiple', 'judgement', 'completion'].includes(options.type || '') &&
		!!options.reviewActions?.adopt;
	const adoptButtons: HTMLButtonElement[] = [];
	let adopting = false;
	let adopted = false;
	const answerBlock = (answers: string[]) =>
		h(
			'div',
			{ className: 'ai-candidate-answer' },
			answers.map((answer, index) =>
				h('div', { style: { whiteSpace: 'pre-wrap', margin: '6px 0' } }, [
					...(options.type === 'completion' ? [h('strong', { textContent: `第 ${index + 1} 空：` })] : []),
					h('code', { textContent: answer })
				])
			)
		);
	const controls = (answers: string[]) => {
		const area = h('div', {
			style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '8px 0' }
		});
		area.append(createAIAnswerCopyButton(answers));
		if (canAdopt) {
			const button = h('button', { type: 'button', className: 'base-style-button' }, '采用此答案填入本题');
			const status = h('span', { role: 'status', style: { fontSize: '12px' } });
			adoptButtons.push(button);
			button.onclick = async () => {
				if (adopting || adopted) return;
				adopting = true;
				adoptButtons.forEach((control) => {
					control.disabled = true;
				});
				status.textContent = '正在填入本题…';
				try {
					await options.reviewActions!.adopt!([...answers]);
					adopted = true;
					status.textContent = '已采用此答案';
				} catch (error) {
					status.textContent = error instanceof Error ? error.message : '填入失败，请在原题处理';
				} finally {
					adopting = false;
					adoptButtons.forEach((control) => {
						control.disabled = adopted;
					});
				}
			};
			area.append(button, status);
		}
		return area;
	};
	const article = (heading: string) =>
		h('article', { style: { borderTop: '1px solid #80808029', padding: '10px 0' } }, [
			h('strong', { textContent: heading })
		]);
	if (ensemble.summary) {
		const summary = ensemble.summary;
		const card = article('总结模型：' + summary.name);
		if (summary.answers?.length) {
			card.append(answerBlock(summary.answers));
			if (!summary.error) card.append(controls(summary.answers));
		}
		if (summary.error) card.append(h('div', { className: 'error', textContent: summary.error }));
		if (summary.ai)
			card.append(h('details', [h('summary', '总结调用详情与思考内容'), createAICallDetails(summary.ai)]));
		root.append(card);
	}
	const groups = answerGroups(ensemble);
	for (const [index, group] of groups.entries()) {
		const card = article(`候选 ${index + 1} · ${group.members.length} 次相同回答`);
		card.append(answerBlock(group.answers), controls(group.answers));
		for (const member of group.members) {
			card.append(
				member.ai
					? h('details', [
							h('summary', { textContent: member.name + ' · 调用详情与思考内容' }),
							createAICallDetails(member.ai)
					  ])
					: h('div', { textContent: member.name })
			);
		}
		root.append(card);
	}
	for (const member of ensemble.members.filter((item) => item.error || !item.answers?.length)) {
		const card = article(member.name);
		card.append(
			h('div', {
				className: member.error ? 'error' : '',
				textContent: member.error || (ensemble.status === 'running' ? '等待回答…' : '未返回有效答案')
			})
		);
		if (member.ai) card.append(h('details', [h('summary', '调用详情与思考内容'), createAICallDetails(member.ai)]));
		root.append(card);
	}
	return root;
}
