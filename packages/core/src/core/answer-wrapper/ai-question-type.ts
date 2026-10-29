export type AIQuestionType = 'single' | 'multiple' | 'judgement' | 'completion' | 'unknown';

/** A platform-provided type always wins. Only untyped selections may use a leading type label. */
export function resolveAIQuestionType(question: { type?: string; title: string }): AIQuestionType {
	if (['single', 'multiple', 'judgement', 'completion'].includes(question.type || '')) {
		return question.type as AIQuestionType;
	}
	if (question.type && question.type !== 'unknown') return 'unknown';
	const label = question.title.match(
		/^\s*(?:(?:\d+|[一二三四五六七八九十]+)\s*[.、．]\s*)?(?:\(|（|【|\[)?\s*(单选题|多选题|判断题|填空题|简答题)(?=$|[\s,，:：()（）【】[\]])/
	)?.[1];
	return label === '单选题'
		? 'single'
		: label === '多选题'
		? 'multiple'
		: label === '判断题'
		? 'judgement'
		: label === '填空题' || label === '简答题'
		? 'completion'
		: 'unknown';
}
