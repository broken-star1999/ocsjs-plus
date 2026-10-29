import type { SimplifyWorkResult } from '@ocsjs/core';

/** AI letters depend on options and model state; the legacy title-only cache cannot preserve that contract. */
export function isAIQuestionCacheSource(info: SimplifyWorkResult['searchInfos'][number]): boolean {
	return !!(
		info.ai ||
		info.ensemble ||
		info.results.some(([, , extra]) => {
			const data = extra as { ai?: unknown; ai_native?: unknown } | undefined;
			return data?.ai === true || data?.ai_native === true;
		})
	);
}
