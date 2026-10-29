/** Read the same current DOM value for querying, filling and retrying a CX question. */
export function readCXQuestionTypeCode(inputs: HTMLInputElement[] = []): number {
	const named = inputs.filter((input) => /^type\d+$/.test(input.name));
	const identified = inputs.filter((input) => /^answertype/.test(input.id));
	const candidates = named.length ? named : identified.length ? identified : inputs.length === 1 ? inputs : [];
	if (!candidates.length) return -1;
	const codes = candidates.map((input) => (/^\d+$/.test(input.value.trim()) ? Number(input.value.trim()) : -1));
	return codes.every((code) => code >= 0 && code === codes[0]) ? codes[0] : -1;
}
