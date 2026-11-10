import { extractTextWithImages } from './work';
import { prepareMathContent } from './mathjax-content';

/** Extract complete MathJax expressions for AI while leaving the page and bank input untouched. */
export function extractCxAIContent(element: HTMLElement): { text: string; images: string[] } {
	const clone = element.cloneNode(true) as HTMLElement;
	prepareMathContent(clone);
	return extractTextWithImages(clone);
}
