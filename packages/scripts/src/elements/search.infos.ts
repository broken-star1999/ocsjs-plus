import { SimplifyWorkResult, splitAnswer, $, QuestionTypes } from '@ocsjs/core';
import { $ui, h } from 'easy-us';
import { createQuestionTitleExtra } from '../utils';
import { createAccordionCard } from '../utils/ui';
import DOMPurify from 'dompurify';
import { createAICallDetails } from './ai-call-details';
import { createAIEnsembleDetails } from './ai-ensemble-details';
import { transformImgLinkOfQuestion } from '../utils/search-result-images';

/**
 * 移除特殊字符、空格、换行，用于判断题库返回的题目是否和原题完全匹配
 *
 * 图片题的题干就是图片 URL，同一张图在不同场景下可能返回 http 或 https 协议，
 * 但属于同一道题、应折叠去重，因此先统一抹平协议前缀再剔除非字母数字字符。
 */
const normalizeQuestion = (question: string) => question.replace(/https?:\/\//gi, '//').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * 搜索结果元素
 */
export class SearchInfosElement extends HTMLElement {
	/** 搜索结果 [题目，答案] */
	infos: SimplifyWorkResult['searchInfos'] = [];
	/** 当前的题目 */
	question: string = '';

	type: QuestionTypes;

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
							.map((l) => h('div', { innerHTML: l }))
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
				homeLink.onclick = (e) => e.stopPropagation();

				const isAI =
					!!info.ai || !!info.ensemble || info.results.some((ans) => (ans[2] as { ai_native?: boolean })?.ai_native);
				const results = (
					info.error
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
							...(isSameQuestion ? [] : [h('div', { className: 'question' }, [h('span', { innerHTML: title })])]),
							/** 答案 */
							h('div', { className: 'answer' }, [
								h('span', '答案：'),
								...(extra_data.tags
									? extra_data.tags.map((tag: { text: string; title: string; color: string }) =>
											$ui.tooltip(
												h('span', {
													className: 'search-result-answer-tag ' + tag.color,
													innerHTML: tag.text,
													title: tag.title,
													dataset: { title: tag.title }
												})
											)
									  )
									: []),
								...answer.map((a, index) =>
									h('code', aiData?.ai_native ? { textContent: parts[index] } : { innerHTML: DOMPurify.sanitize(a) })
								)
							])
						]);
					})
				]);
				// AI 答案/错误常驻，头部箭头只控制调用详情和思考内容。
				return createAccordionCard({
					className: 'search-info-details' + (isAI ? ' ai-search-info' : ''),
					expanded: true,
					header: [
						homeLink,
						...(info.error ? [] : [h('span', { className: 'text-secondary' }, ` 共 ${info.results.length} 个结果`)])
					],
					alwaysVisibleBody: isAI
						? [...results, ...(info.ensemble ? [createAIEnsembleDetails(info.ensemble)] : [])]
						: undefined,
					body: isAI ? (info.ai ? [createAICallDetails(info.ai)] : []) : results
				});
			})
		);

		$.onresize(this, (sr) => {
			sr.style.maxHeight = window.innerHeight / 2 + 'px';
		});
	}
}
