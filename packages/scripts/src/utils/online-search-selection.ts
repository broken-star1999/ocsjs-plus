import { prepareMathContent } from './mathjax-content';

export interface SelectedSearchImage {
	marker: string;
	url: string;
}

export interface SearchSelection {
	text: string;
	images: SelectedSearchImage[];
}

/** Read only the selected DOM range, preserving text/image order and block boundaries. */
export function readSearchSelection(selection: Selection | null): SearchSelection | undefined {
	if (!selection || selection.isCollapsed || !selection.rangeCount) return;
	const images: SelectedSearchImage[] = [];
	const parts: string[] = [];
	for (let i = 0; i < selection.rangeCount; i++) {
		const sourceRange = selection.getRangeAt(i);
		const range = sourceRange.cloneRange ? sourceRange.cloneRange() : sourceRange;
		// Never turn selections made inside the script's own shadow UI into a new question.
		if (range.commonAncestorContainer.getRootNode().nodeType !== 9) continue;
		// A selection beginning inside a glyph must include its complete expression.
		const formulaAt = (node: Node) =>
			(node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest('mjx-container, .MathJax, svg');
		const first = range.startContainer && formulaAt(range.startContainer);
		const last = range.endContainer && formulaAt(range.endContainer);
		if (first) range.setStartBefore(first.closest('mjx-container, .MathJax') || first);
		if (last) range.setEndAfter(last.closest('mjx-container, .MathJax') || last);
		const fragment = range.cloneContents();
		const root = range.commonAncestorContainer;
		const originalImages = [
			...(root.nodeType === 1 && (root as Element).tagName === 'IMG' ? [root as HTMLImageElement] : []),
			...Array.from((root as Element).querySelectorAll?.('img') || [])
		].filter((img) => range.intersectsNode(img));
		let imageIndex = 0;
		for (const element of Array.from(fragment.querySelectorAll('img'))) {
			const original = originalImages[imageIndex++];
			if (original) element.setAttribute('src', original.currentSrc || original.src);
		}
		prepareMathContent(fragment);
		const visit = (node: Node) => {
			if (node.nodeType === 3) {
				parts.push(node.textContent || '');
				return;
			}
			const element = node as Element;
			if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(element.tagName)) return;
			if (element.tagName === 'IMG') {
				const img = element as HTMLImageElement;
				const raw = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src');
				if (!raw) return;
				let url: string;
				try {
					url = new URL(raw, img.baseURI).href;
				} catch {
					return;
				}
				if (!/^(https?:|blob:|data:image\/)/i.test(url)) return;
				let image = images.find((item) => item.url === url);
				if (!image) {
					image = { marker: `[图片${images.length + 1}]`, url };
					images.push(image);
				}
				parts.push(' ' + image.marker + ' ');
				return;
			}
			const block = /^(P|DIV|LI|TR|H[1-6]|SECTION|ARTICLE|BR)$/.test(element.tagName);
			if (block) parts.push('\n');
			for (const child of Array.from(node.childNodes)) visit(child);
			if (block) parts.push('\n');
		};
		visit(fragment);
		parts.push('\n');
	}
	const text = parts
		.join('')
		.replace(/[ \t]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return text ? { text, images } : undefined;
}

/** Explicit whole-question capture avoids browser-dependent SVG drag selection. */
export function readSearchQuestion(target: Element): SearchSelection | undefined {
	const question = target.closest('.questionLi, .TiMu, .question-item');
	if (!question) return;
	const clone = question.cloneNode(true) as Element;
	clone.querySelectorAll('.mark_answer, .analysis, .asFlagBtn, script, style').forEach((node) => node.remove());
	return readSearchSelection({
		isCollapsed: false,
		rangeCount: 1,
		getRangeAt: () => ({
			commonAncestorContainer: question,
			cloneContents: () => {
				const fragment = question.ownerDocument.createDocumentFragment();
				fragment.appendChild(clone);
				return fragment;
			},
			intersectsNode: (node: Node) =>
				question.contains(node) && !(node as Element).closest?.('.mark_answer, .analysis, .asFlagBtn')
		})
	} as unknown as Selection);
}

export function expandSearchImages(text: string, images: SelectedSearchImage[]): string {
	return text.replace(/\[图片\d+\]/g, (marker) => {
		const image = images.find((item) => item.marker === marker);
		if (!image) throw new Error(`${marker} 对应的图片已失效，请重新划选题目或移除此标记。`);
		return image.url;
	});
}
