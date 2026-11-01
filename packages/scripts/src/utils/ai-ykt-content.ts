import { extractTextWithImages } from './work';

/** AI-only formula extraction; traditional question-bank text stays on the upstream path. */
export function extractYktAIContent(element: HTMLElement, blankInputSelector?: string) {
	const clone = element.cloneNode(true) as HTMLElement;
	for (const image of Array.from(clone.querySelectorAll('img.kfformula'))) {
		const latex =
			image.getAttribute('data-latex')?.trim() ||
			(image.getAttribute('data-slatex') || '').trim().replace(/\\\\/g, '\\');
		// A missing formula source is still a valid image input for a vision model.
		if (latex) image.replaceWith(` $${latex}$ `);
	}
	if (blankInputSelector) {
		for (const input of Array.from(clone.querySelectorAll(blankInputSelector))) input.replaceWith('____');
	}
	return extractTextWithImages(clone);
}
