import assert from 'node:assert/strict';
import { prepareMathContent, serializeFormulaSVG } from '../packages/scripts/src/utils/mathjax-content';

const host = document.createElement('div');
document.body.appendChild(host);
const svg = (body: string, size = 'viewBox="0 0 100 50"') => {
	const node = document.createElement('div');
	node.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" ${size}>${body}</svg>`;
	host.appendChild(node);
	return node.firstElementChild!;
};
const decode = (element: Element) => decodeURIComponent(escape(atob(serializeFormulaSVG(element).split(',')[1])));
try {
	svg('<defs><path id="shared-glyph" d="M0 0H100V50H0Z"/><use id="shared-alias" href="#shared-glyph"/></defs>');
	const formula = svg('<use href="#shared-alias"/>');
	const original = formula.outerHTML;
	const source = decode(formula);
	assert.ok(source.includes('id="shared-glyph"'));
	assert.ok(source.includes('id="shared-alias"'));
	assert.equal(formula.outerHTML, original);
	console.log('PASS nested page-global glyph aliases are embedded without changing source DOM');
	const clipped = decode(
		svg(
			'<defs><clipPath id="local-clip"><rect width="10" height="50"/></clipPath></defs><rect width="100" height="50" clip-path="url(#local-clip)"/>'
		)
	);
	assert.ok(clipped.includes('clip-path="url(#local-clip)"'));
	svg('<defs><clipPath id="page-clip"><rect width="20" height="50"/></clipPath></defs>');
	assert.ok(decode(svg('<rect width="100" height="50" clip-path="url(#page-clip)"/>')).includes('id="page-clip"'));
	console.log('PASS local and page-global clipping definitions preserve graphic meaning');
	const png =
		'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
	assert.ok(decode(svg(`<image href="${png}" width="100" height="50"/>`)).includes(png));
	assert.throws(() => serializeFormulaSVG(svg('<image href="https://example.invalid/image.png"/>')), /image source/);
	assert.throws(() => serializeFormulaSVG(svg('<use href="https://example.invalid/glyph.svg#g"/>')), /External/);
	console.log('PASS embedded raster retained; external resources reject instead of disappearing');
	assert.throws(() => serializeFormulaSVG(svg('<use href="#missing-glyph"/>')), /Missing/);
	assert.throws(
		() =>
			serializeFormulaSVG(
				svg('<defs><use id="cycle-a" href="#cycle-b"/><use id="cycle-b" href="#cycle-a"/></defs><use href="#cycle-a"/>')
			),
		/Circular/
	);
	for (const body of [
		'<script>alert(1)</script>',
		'<foreignObject/>',
		'<style>path{fill:red}</style>',
		'<rect fill="url(https://example.invalid/paint)"/>'
	]) {
		const root = document.createElement('div');
		root.appendChild(svg(body));
		prepareMathContent(root);
		assert.match(root.textContent || '', /公式无法识别/);
		assert.equal(root.querySelector('img'), null);
	}
	console.log('PASS missing/cyclic/unsupported definitions become a visible failure marker');
	assert.throws(() => serializeFormulaSVG(svg('<rect/>', 'width="99999999" height="99999999"')), /limits/);
	assert.throws(() => serializeFormulaSVG(svg('<rect/>', 'width="0" height="20"')), /limits/);
	const sized = document.createElement('div');
	sized.innerHTML = decode(svg('<rect width="100" height="50"/>'));
	assert.ok(Number(sized.querySelector('svg')!.getAttribute('width')) <= 2048);
	assert.ok(Number(sized.querySelector('svg')!.getAttribute('height')) <= 256);
	console.log('PASS generated bitmap dimensions bounded and invalid sizes blocked');
} finally {
	host.remove();
}
