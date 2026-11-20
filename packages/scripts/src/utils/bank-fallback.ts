import {
	AnswererWrapper,
	SearchInformation,
	StringUtils,
	WorkContext,
	createDefaultQuestionResolver,
	normalizeStringKeepSign,
	removeRedundant,
	resolveMultiple,
	resolvePlainAnswer,
	splitAnswer
} from '@ocsjs/core';

export function withBankFallback(banks: AnswererWrapper[], ai: AnswererWrapper | undefined): AnswererWrapper[] {
	if (!banks.length) return ai ? [ai] : [];
	return [
		{
			...(ai || { name: 'AI 兜底', url: '', method: 'post', type: 'GM_xmlhttpRequest', headers: {}, handler: '' }),
			fallbackBanks: banks
		}
	];
}

export function unavailableBankFallback(): SearchInformation[] {
	return [{ name: 'AI 兜底', results: [], error: '题库没有可用答案，请配置并启用 AI 兜底模型。' }];
}

export async function searchBanksThenAI(
	banks: AnswererWrapper[],
	searchBank: (bank: AnswererWrapper) => Promise<SearchInformation[]>,
	matchBank: (infos: SearchInformation[]) => SearchInformation[] | undefined | Promise<SearchInformation[] | undefined>,
	searchAI: () => Promise<SearchInformation[]>
): Promise<SearchInformation[]> {
	for (const bank of banks) {
		const infos = (await searchBank(bank)).map((info) => ({
			...info,
			results: info.error
				? []
				: info.results.filter((result) => typeof result.answer === 'string' && result.answer.trim())
		}));
		if (infos.some((info) => info.results.length)) {
			const matched = await matchBank(infos);
			if (matched) return matched;
		}
	}
	return searchAI();
}

/** Check the current controls for a platform whose answer format uses ordered groups of fields. */
export function matchBankSelections(
	infos: SearchInformation[],
	count: number,
	canSelect: (answer: string, index: number) => boolean,
	individualResults = false
): SearchInformation[] | null {
	if (!count) return null;
	for (const info of infos) {
		const resultGroups = individualResults ? info.results.map((result) => [result]) : [info.results];
		for (const results of resultGroups) {
			const answers = results.length === 1 ? splitAnswer(results[0].answer) : results.map((result) => result.answer);
			if (answers.length === count && answers.every((answer, index) => answer.trim() && canSelect(answer, index))) {
				return [{ ...info, results }];
			}
		}
	}
	return null;
}

const writableAnswerSelector =
	'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not(:disabled):not([readonly]), textarea:not(:disabled):not([readonly]), iframe, [contenteditable="true"], .real-editor';

function hasWritableAnswerField(option: HTMLElement): boolean {
	const field = option.matches(writableAnswerSelector) ? option : option.querySelector(writableAnswerSelector);
	if (!field) return false;
	if (field.tagName === 'IFRAME') {
		const iframe = field as HTMLIFrameElement;
		return (
			!!iframe.contentDocument?.body ||
			(!!iframe.closest('[id^="ueditor-"]') &&
				typeof (iframe.ownerDocument.defaultView as any)?.UE?.getEditor === 'function')
		);
	}
	if (field.classList.contains('real-editor')) return typeof (field as any).ckeditorInstance?.data?.set === 'function';
	return true;
}

/** Reuse the answer resolver without clicking options or filling fields during a lookup. */
export async function matchBankAnswer(
	ctx: WorkContext<any>,
	infos: SearchInformation[],
	optionText: (option: HTMLElement, index: number) => string
): Promise<SearchInformation[] | undefined> {
	const { type } = ctx;
	const options = (ctx.elements.options || []).filter((option): option is HTMLElement => !!option);
	if (!type || !['single', 'multiple', 'judgement', 'completion'].includes(type) || !options.length) return;
	if (type === 'multiple') {
		const texts = options.map(optionText);
		infos = infos.map((info) => ({
			...info,
			results: info.results.filter(({ answer }) => {
				const match = resolveMultiple([answer], texts, ctx.answerSeparators);
				if (!match.finish) return false;
				const group = match.groups?.[0];
				const parts = splitAnswer(answer, ctx.answerSeparators);
				const choice = resolvePlainAnswer(StringUtils.nowrap(answer, ''));
				if (choice && [...choice].some((letter) => letter.charCodeAt(0) - 65 >= options.length)) {
					// An apparent letter combination may be actual option text (e.g. DNS).
					// Accept it only when every selected option matches a complete answer part.
					return (
						group?.options.length === parts.length &&
						parts.every((part) => group.answers.includes(part)) &&
						group.options.every((option, index) => {
							const answerText = normalizeStringKeepSign(group.answers[index]);
							return (
								answerText === normalizeStringKeepSign(option) ||
								answerText === normalizeStringKeepSign(removeRedundant(option))
							);
						})
					);
				}
				return !group || parts.length === 1 || parts.every((part) => group.answers.includes(part));
			})
		}));
	}
	let matched = false;
	let usable = true;
	const result = await createDefaultQuestionResolver(ctx, optionText)[type](
		infos,
		options,
		async (kind, answer, option) => {
			matched = true;
			const control = option?.querySelector('input[type="radio"],input[type="checkbox"]');
			const disabled = ':disabled,[aria-disabled="true"]';
			usable &&= !!option && !option.matches(disabled) && !control?.matches(disabled);
			if (kind === 'completion') {
				usable &&= !!option && !!answer?.trim() && hasWritableAnswerField(option);
			}
		}
	);
	return result.finish && matched && usable ? infos : undefined;
}
