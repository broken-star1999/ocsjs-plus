/** Preserve complete formulas; never piece together nested glyph metadata. */
export function prepareMathContent(root: HTMLElement | DocumentFragment): void {
	const nodes = Array.from(root.querySelectorAll('mjx-container, .MathJax, svg'));
	for (const node of nodes) {
		if (nodes.some((parent) => parent !== node && parent.contains(node))) continue;
		const latex =
			node.getAttribute('data-latex')?.trim() ||
			node.querySelector('[data-mml-node="math"]')?.getAttribute('data-latex')?.trim() ||
			node.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ||
			node.querySelector('math')?.getAttribute('alttext')?.trim();
		if (latex) {
			node.replaceWith(` $${latex}$ `);
			continue;
		}
		const svg = node.localName === 'svg' ? node : node.querySelector('svg');
		try {
			if (!svg) throw new Error('Missing SVG');
			const image = node.ownerDocument.createElement('img');
			image.src = serializeFormulaSVG(svg);
			image.alt = '公式';
			node.replaceWith(image);
		} catch {
			node.replaceWith(' [公式无法识别] ');
		}
	}
}

/** Make page-global glyph references local before decoding the SVG as a standalone image. */
export function serializeFormulaSVG(source: Element): string {
	const clone = source.cloneNode(true) as Element;
	const doc = source.ownerDocument;
	const defs = doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
	clone.insertBefore(defs, clone.firstChild);
	// Refuse unsupported active content rather than silently changing the visible formula.
	if (clone.querySelector('script, foreignObject, style, animate, animateTransform, set')) {
		throw new Error('Unsupported active SVG content');
	}
	const local = new Map(Array.from(clone.querySelectorAll('[id]')).map((element) => [element.id, element]));
	const resolved = new Set<string>();
	const visiting = new Set<string>();
	const resolveId = (id: string) => {
		if (visiting.has(id)) throw new Error('Circular SVG reference');
		if (resolved.has(id)) return;
		let target = local.get(id);
		if (!target) {
			const original = doc.getElementById(id);
			if (!original) throw new Error('Missing SVG definition');
			target = original.cloneNode(true) as Element;
			defs.appendChild(target);
			local.set(id, target);
			for (const child of Array.from(target.querySelectorAll('[id]'))) local.set(child.id, child);
		}
		visiting.add(id);
		visit(target);
		visiting.delete(id);
		resolved.add(id);
	};
	const visit = (element: Element) => {
		if (['script', 'foreignObject', 'style', 'animate', 'animateTransform', 'set'].includes(element.localName)) {
			throw new Error('Unsupported active SVG definition');
		}
		for (const attribute of Array.from(element.attributes)) {
			if (/^on/i.test(attribute.name)) {
				element.removeAttribute(attribute.name);
				continue;
			}
			if (/^(?:href|xlink:href)$/.test(attribute.name)) {
				if (element.localName === 'image') {
					if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i.test(attribute.value)) {
						throw new Error('Unsupported SVG image source');
					}
				} else {
					if (!attribute.value.startsWith('#')) throw new Error('External SVG reference');
					resolveId(attribute.value.slice(1));
				}
			}
			for (const match of attribute.value.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi)) {
				if (!match[1].startsWith('#')) throw new Error('External SVG style reference');
				resolveId(match[1].slice(1));
			}
		}
		for (const child of Array.from(element.children)) visit(child);
	};
	visit(clone);
	const viewBox = (clone.getAttribute('viewBox') || '')
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
		const ratio = viewBox[2] / viewBox[3];
		const height = Math.min(256, 2048 / ratio);
		clone.setAttribute('width', String(Math.max(1, Math.ceil(height * ratio))));
		clone.setAttribute('height', String(Math.max(1, Math.ceil(height))));
	} else if (
		!/^\d+(?:\.\d+)?(?:px)?$/.test(clone.getAttribute('width') || '') ||
		!/^\d+(?:\.\d+)?(?:px)?$/.test(clone.getAttribute('height') || '')
	)
		throw new Error('Invalid SVG dimensions');
	else {
		const width = Number.parseFloat(clone.getAttribute('width')!);
		const height = Number.parseFloat(clone.getAttribute('height')!);
		if (width <= 0 || height <= 0 || width > 4096 || height > 4096) throw new Error('SVG dimensions exceed limits');
	}
	clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
	clone.setAttribute('color', '#000');
	const xml = new XMLSerializer().serializeToString(clone);
	return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
}
