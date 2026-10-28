export interface AICallRecord {
	id: string;
	startedAt: number;
	durationMs?: number;
	provider: string;
	model: string;
	question: string;
	imageCount: number;
	status: 'pending' | 'success' | 'uncertain' | 'error';
	error?: string;
	usage?: { input?: number; output?: number; total?: number };
}

/** Per-question response details; reasoning never participates in answer matching. */
export interface AICallDetails {
	call: AICallRecord;
	reasoning?: string;
	reasoningTruncated?: boolean;
}

export const AI_REASONING_MAX_LENGTH = 20_000;

const records = new Map<string, AICallRecord>();
const listeners = new Set<(record?: AICallRecord) => void>();

/** Session only. Never retain headers, keys, image bytes or raw responses. */
export function updateAICallRecord(record: AICallRecord): void {
	records.set(record.id, { ...record });
	if (records.size > 100) records.delete(records.keys().next().value!);
	for (const listener of listeners) {
		try {
			listener(record);
		} catch {
			// Diagnostics must never interrupt an answer request.
		}
	}
}

export function getAICallRecords(): AICallRecord[] {
	return Array.from(records.values())
		.reverse()
		.sort((a, b) => b.startedAt - a.startedAt);
}

export function clearAICallRecords(): void {
	records.clear();
	for (const listener of listeners) listener();
}

export function observeAICallRecords(listener: (record?: AICallRecord) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function readAIUsage(value: any): AICallRecord['usage'] {
	const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);
	const usage = {
		input: count(value?.prompt_tokens),
		output: count(value?.completion_tokens),
		total: count(value?.total_tokens)
	};
	return Object.values(usage).some((n) => n !== undefined) ? usage : undefined;
}
