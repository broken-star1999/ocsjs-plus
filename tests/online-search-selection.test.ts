import assert from 'node:assert/strict';
import {
	readSearchSelection,
	readSearchQuestion,
	expandSearchImages
} from '../packages/scripts/src/utils/online-search-selection';

// browser-env uses an older DOM without native Range. Test selected fragments here;
// actual browser ranges are exercised in the local preview fixture.
const capture = (html: string) => {
	const element = document.createElement('div');
	element.innerHTML = html;
	const fragment = document.createDocumentFragment();
	while (element.firstChild) fragment.appendChild(element.firstChild);
	return readSearchSelection({
		isCollapsed: false,
		rangeCount: 1,
		getRangeAt: () => ({
			commonAncestorContainer: { getRootNode: () => document },
			cloneContents: () => fragment
		})
	} as unknown as Selection)!;
};
const captured = capture(
	'<p>题干前<img src="https://example.com/image?id=1">题干后</p>' +
		'<p>A. 甲</p><p>B. 乙<img src="https://example.com/image?id=2"></p>'
);
assert.equal(captured.text, '题干前 [图片1] 题干后\n\nA. 甲\n\nB. 乙 [图片2]');
assert.equal(captured.images.length, 2);
assert.match(expandSearchImages(captured.text, captured.images), /image\?id=1/);
assert.throws(() => expandSearchImages('[图片1]', []), /失效/);
assert.equal(expandSearchImages('只搜索文字', captured.images), '只搜索文字');
assert.equal(capture('<img src="https://example.com/image?id=1">').text, '[图片1]');
assert.equal(capture('题干').images.length, 0);
assert.equal(capture('<img src="javascript:alert(1)">'), undefined);
assert.equal(readSearchSelection(null), undefined);
const math =
	'<mjx-container class="MathJax"><svg><g data-mml-node="math" data-latex="x+1"><g data-latex="BAD-PART"></g></g></svg></mjx-container>';
assert.equal(capture('若' + math + '则').text, '若 $x+1$ 则');
assert.equal(capture(math).images.length, 0);
assert.match(capture('<mjx-container><svg></svg></mjx-container>').text, /公式无法识别/);
const question = document.createElement('div');
question.className = 'questionLi';
question.innerHTML =
	'<h3>若' + math + '则</h3><div class="answerBg">A.甲</div><div class="mark_answer">正确答案B</div>';
document.body.appendChild(question);
const whole = readSearchQuestion(question.querySelector('g')!)!;
assert.ok(whole.text.includes('$x+1$'));
assert.ok(whole.text.includes('A.甲'));
assert.equal(whole.text.includes('正确答案'), false);
assert.equal(question.querySelectorAll('mjx-container').length, 1);
question.remove();
assert.equal(capture('<p>甲<img src="https://example.com/a"></p><img src="https://example.com/a">').images.length, 1);
console.log(
	'Selection fragment checks passed: order, extensionless URLs, image-only, duplicate images and stale markers.'
);
