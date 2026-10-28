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
		const range = selection.getRangeAt(i);
		// Never turn selections made inside the script's own shadow UI into a new question.
		if (range.commonAncestorContainer.getRootNode().nodeType !== 9) continue;
		const fragment = range.cloneContents();
		const root = range.commonAncestorContainer;
		const originalImages = [
			...(root.nodeType === 1 && (root as Element).tagName === 'IMG' ? [root as HTMLImageElement] : []),
			...Array.from((root as Element).querySelectorAll?.('img') || [])
		].filter((img) => range.intersectsNode(img));
		let imageIndex = 0;
		const visit = (node: Node) => {
			if (node.nodeType === 3) {
				parts.push(node.textContent || '');
				return;
			}
			const element = node as Element;
			if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(element.tagName)) return;
			if (element.tagName === 'IMG') {
				const img = originalImages[imageIndex++] || (element as HTMLImageElement);
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

export function expandSearchImages(text: string, images: SelectedSearchImage[]): string {
	return text.replace(/\[图片\d+\]/g, (marker) => {
		const image = images.find((item) => item.marker === marker);
		if (!image) throw new Error(`${marker} 对应的图片已失效，请重新划选题目或移除此标记。`);
		return image.url;
	});
}
