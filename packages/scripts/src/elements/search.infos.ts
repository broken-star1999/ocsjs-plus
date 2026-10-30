import { SimplifyWorkResult, splitAnswer, $, QuestionTypes } from '@ocsjs/core';
import { $ui, h } from 'easy-us';
import { createQuestionTitleExtra } from '../utils';
import { createAccordionCard } from '../utils/ui';
import DOMPurify from 'dompurify';
import { createAICallDetails } from './ai-call-details';
import {
	createAIEnsembleDetails,
	createAIEnsembleSummary,
	createAIAnswerCopyButton,
	AIReviewActions
} from './ai-ensemble-details';
import { transformImgLinkOfQuestion } from '../utils/search-result-images';

/**
 * 移除特殊字符、空格、换行，用于判断题库返回的题目是否和原题完全匹配
 *
 * 图片题的题干就是图片 URL，同一张图在不同场景下可能返回 http 或 https 协议，
 * 但属于同一道题、应折叠去重，因此先统一抹平协议前缀再剔除非字母数字字符。
 */
const normalizeQuestion = (question: string) => question.replace(/https?:\/\//gi, '//').replace(/[^\p{L}\p{N}]/gu, '');

// Progress rebuilds result elements. Retain disclosure choices without retaining
// complete question text, image bytes or detached DOM in a long-lived session.
const disclosureStates = new Map<string, boolean>();
function disclosureKey(text: string) {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
	return (hash >>> 0).toString(36) + ':' + text.length;
}
function rememberDisclosure(key: string, expanded: boolean) {
	disclosureStates.delete(key);
	disclosureStates.set(key, expanded);
	if (disclosureStates.size > 200) disclosureStates.delete(disclosureStates.keys().next().value!);
}

/**
 * 搜索结果元素
 */
export class SearchInfosElement extends HTMLElement {
	/** 搜索结果 [题目，答案] */
	infos: SimplifyWorkResult['searchInfos'] = [];
	/** 当前的题目 */
	question: string = '';

	type: QuestionTypes;

	/** Wired by the owning task; only an explicit candidate button invokes it. */
	reviewActions?: AIReviewActions;

	connectedCallback() {
		const question = transformImgLinkOfQuestion(this.question || '无');

		const type_text = {
			single: '单选题',
			multiple: '多选题',
			judgement: '判断题',
			completion: '填空题'
		};
		const type_label = this.type ? Reflect.get(type_text, this.type) : '';

		this.append(
			h(
				'div',
				[
					h('div', { className: 'title-content' }, [
						...question
							.split('\n')
							.map((l) => l.trim())
							.filter(Boolean)
							.map((l) => h('div', { innerHTML: DOMPurify.sanitize(l) }))
					]),
					// 题型标签放到操作行内"复制"按钮左侧，避免独占一行高度
					createQuestionTitleExtra(
						this.question,
						...(type_label ? [h('span', { className: 'search-result-question-type' }, type_label)] : [])
					)
				],
				(div) => {
					div.className = 'search-info-title';
				}
			)
		);

		this.append(
			...this.infos.map((info) => {
				// 题库主页链接：点击跳转，不触发卡片展开/收起
				const homeLink = info.homepage
					? $ui.tooltip(
							h('a', { href: info.homepage, innerText: info.name, target: '_blank', title: '点击前往题库官网' })
					  )
					: h('span', { innerText: info.name });
				if (info.homepage) homeLink.onclick = (e) => e.stopPropagation();

				const isAI =
					!!info.ai || !!info.ensemble || info.results.some((ans) => (ans[2] as { ai_native?: boolean })?.ai_native);
				const repeatedReviewReason = info.ensemble?.status === 'review' && info.error === info.ensemble.reason;
				const results = (
					info.error && !repeatedReviewReason
						? /** 显示错误信息 */
						  [h('span', { className: 'error' }, [info.error || '网络错误或者未知错误'])]
						: /** 显示结果列表 */
						  []
				).concat([
					...info.results.map((ans) => {
						const title = transformImgLinkOfQuestion(ans[0] || this.question || '无');
						// 先按答案分隔符拆分原始答案，再逐段转换图片：
						// 反之若先转换，img 标签的 src 中 & 被转义为 &amp;，其分号会被 splitAnswer 的 ';' 分隔符误切
						const aiData = ans[2] as { ai_native?: boolean; answers?: string[] } | undefined;
						const parts = aiData?.ai_native && aiData.answers ? aiData.answers : splitAnswer(ans[1] || '无');
						const answer = parts.map((a) => transformImgLinkOfQuestion(a));
						/** 返回的题目和原题完全匹配时，不再重复显示题目 */
						const isSameQuestion = normalizeQuestion(ans[0] || '') === normalizeQuestion(this.question || '');
						const extra_data = JSON.parse(JSON.stringify(ans[2] || {}));

						if (extra_data.ai) {
							extra_data.tags = extra_data.tags || [];
							extra_data.tags.push({
								text: 'AI',
								title: '此答案由 AI 生成，仅供参考',
								color: 'blue'
							});
						}

						if (extra_data.cache) {
							extra_data.tags = extra_data.tags || [];
							extra_data.tags.push({
								text: '题库缓存',
								title:
									'此答案来自本地缓存，由在线题库搜索后保存在本地。\n- 清空缓存：请前往通用-全局设置-题库缓存功能-管理缓存\n- 关闭缓存：请前往通用-全局设置-题库缓存功能',
								color: 'gray'
							});
						}

						return h('div', { className: 'search-result' }, [
							/** 题目（和原题完全匹配时不显示，避免重复） */
							...(isSameQuestion
								? []
								: [h('div', { className: 'question' }, [h('span', { innerHTML: DOMPurify.sanitize(title) })])]),
							/** 答案 */
							h('div', { className: 'answer' }, [
								h('span', '答案：'),
								...(extra_data.tags
									? extra_data.tags.map((tag: { text: string; title: string; color: string }) =>
											$ui.tooltip(
												h('span', {
													className: 'search-result-answer-tag ' + tag.color,
													innerHTML: DOMPurify.sanitize(tag.text),
													title: tag.title,
													dataset: { title: tag.title }
												})
											)
									  )
									: []),
								...answer.map((a, index) =>
									h(
										'span',
										{
											style:
												aiData?.ai_native && this.type === 'completion' ? { display: 'block', margin: '4px 0' } : {}
										},
										[
											...(aiData?.ai_native && this.type === 'completion'
												? [h('strong', { textContent: `第 ${index + 1} 空：` })]
												: []),
											h(
												'code',
												aiData?.ai_native ? { textContent: parts[index] } : { innerHTML: DOMPurify.sanitize(a) }
											)
										]
									)
								),
								...(aiData?.ai_native ? [createAIAnswerCopyButton(parts)] : [])
							])
						]);
					})
				]);
				// AI 答案/错误常驻，头部箭头只控制调用详情和思考内容。
				const stateKey = disclosureKey(this.question + '\n' + info.name);
				const card = createAccordionCard({
					className: 'search-info-details' + (isAI ? ' ai-search-info' : ''),
					expanded: disclosureStates.get(stateKey) ?? !info.ensemble,
					header: [
						homeLink,
						...(info.error || (info.ensemble && !info.results.length)
							? []
							: [h('span', { className: 'text-secondary' }, ` 共 ${info.results.length} 个结果`)])
					],
					alwaysVisibleBody: isAI
						? [...results, ...(info.ensemble ? [createAIEnsembleSummary(info.ensemble, this.type)] : [])]
						: undefined,
					body: info.ensemble
						? [
								createAIEnsembleDetails(info.ensemble, {
									type: this.type,
									reviewActions: this.reviewActions,
									includeSummary: false
								})
						  ]
						: isAI
						? info.ai
							? [createAICallDetails(info.ai)]
							: []
						: results
				});
				const header = card.querySelector<HTMLElement>('.accordion-card-header')!;
				const toggle = header.onclick;
				header.onclick = (event) => {
					toggle?.call(header, event);
					rememberDisclosure(stateKey, card.classList.contains('expanded'));
				};
				for (const detail of Array.from(card.querySelectorAll('details'))) {
					const labels: string[] = [];
					let current: HTMLElement | null = detail;
					while (current && card.contains(current)) {
						if (current.tagName.toLowerCase() === 'details')
							labels.unshift(current.querySelector('summary')?.textContent || '');
						current = current.parentElement;
					}
					const key = stateKey + ':' + disclosureKey(labels.join('\n'));
					if (disclosureStates.has(key)) detail.open = disclosureStates.get(key)!;
					detail.addEventListener('toggle', () => rememberDisclosure(key, detail.open));
				}
				return card;
			})
		);

		$.onresize(this, (sr) => {
			sr.style.maxHeight = window.innerHeight / 2 + 'px';
		});
	}
}
