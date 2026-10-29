import assert from 'node:assert/strict';
import { transformImgLinkOfQuestion } from '../packages/scripts/src/utils/search-result-images';

let checks = 0;
function check(name: string, run: () => void) {
	run();
	checks++;
	console.log('PASS ' + name);
}
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///w==';
function rendered(text: string) {
	const root = document.createElement('div');
	root.innerHTML = transformImgLinkOfQuestion(text);
	return root;
}

check('ordinary text is unchanged', () => assert.equal(transformImgLinkOfQuestion('题目 1 + 1'), '题目 1 + 1'));
check('embedded Base64 image is an image, not a text wall', () => {
	const root = rendered('题干 ' + png);
	assert.equal(root.querySelector('img')?.getAttribute('src'), png);
	assert.equal(root.textContent, '题干 ');
});
check('multiple embedded images preserve order and surrounding Chinese', () => {
	const root = rendered('题干' + png + '选项' + gif + '结束');
	assert.deepEqual(
		Array.from(root.querySelectorAll('img')).map((img) => img.getAttribute('src')),
		[png, gif]
	);
	assert.equal(root.textContent, '题干选项结束');
});
check('existing embedded img tags are not nested or lost', () => {
	const root = rendered(`<p>题干<img src="${png}" /></p>`);
	assert.equal(root.querySelectorAll('img').length, 1);
	assert.equal(root.querySelector('img')?.getAttribute('src'), png);
	assert.equal(root.textContent?.trim(), '题干');
});
check('signed HTTP image URLs keep the full query and fragment', () => {
	const url = 'https://example.com/image.png?token=abc&size=2#page';
	assert.equal(rendered(url).querySelector('img')?.getAttribute('src'), url);
	assert.ok(!transformImgLinkOfQuestion(url).includes('&amp;'));
});
check('an embedded data URL inside an HTTP query is not wrapped twice', () => {
	const url = 'https://example.com/image.png?fallback=' + png;
	const root = rendered(url);
	assert.equal(root.querySelectorAll('img').length, 1);
	assert.equal(root.querySelector('img')?.getAttribute('src'), url);
});
check('existing HTTP and Base64 img tags survive together', () => {
	const root = rendered(`<img src="https://example.com/image.png?a=1&amp;b=2"><img src="${gif}">`);
	assert.equal(root.querySelectorAll('img').length, 2);
	assert.equal(root.querySelectorAll('img')[0].getAttribute('src'), 'https://example.com/image.png?a=1&b=2');
	assert.equal(root.querySelectorAll('img')[1].getAttribute('src'), gif);
});
check('non-image data URLs are not converted', () => {
	assert.equal(rendered('data:text/html;base64,PHNjcmlwdD4=').querySelector('img'), null);
});
check('JavaScript URLs are not converted', () => {
	assert.equal(rendered('javascript:alert(1)').querySelector('img'), null);
});
check('uppercase image URL suffixes are supported', () => {
	assert.equal(
		rendered('https://example.com/IMAGE.PNG').querySelector('img')?.getAttribute('src'),
		'https://example.com/IMAGE.PNG'
	);
});
console.log(`Search-result image checks passed: ${checks}.`);
