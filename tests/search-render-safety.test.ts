import assert from 'node:assert/strict';
import { SearchInfosElement } from '../packages/scripts/src/elements/search.infos';

/** Exercise the actual result element; all inputs and image URLs are local fixtures, never fetched. */
const hostile =
	'<details open ontoggle="window.__renderAudit=1"><summary>details</summary></details>' +
	'<svg onload="window.__renderAudit=1"></svg>' +
	'<script>window.__renderAudit=1</script>' +
	'<iframe srcdoc="<script>parent.__renderAudit=1</script>"></iframe>' +
	'<a href="javascript:window.__renderAudit=1">unsafe link</a>';
const png =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAIElEQVQ4T2NkoDJgpLJ5DKMGjBo6atCoQaMGjRo0ahB8AgDLbAEpXteJowAAAABJRU5ErkJggg==';
let checks = 0;

function render(question: string, title = question, answer = 'B', extra: Record<string, any> = {}) {
	const element = document.createElement('section') as unknown as SearchInfosElement;
	element.question = question;
	element.type = 'single';
	element.infos = [{ name: 'Local render fixture', results: [[title, answer, extra]] }];
	SearchInfosElement.prototype.connectedCallback.call(element);
	return element;
}

function assertNoExecutableContent(root: Element) {
	assert.equal(root.querySelector('script, iframe, object, embed'), null);
	for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
		for (const attribute of Array.from(element.attributes)) {
			assert.ok(!/^on/i.test(attribute.name), 'event handler must not remain: ' + attribute.name);
			if (/^(href|src|xlink:href)$/i.test(attribute.name))
				assert.ok(!/^\s*javascript:/i.test(attribute.value), 'executable URL must not remain');
		}
	}
}

function test(name: string, run: () => void) {
	run();
	checks++;
	console.log('PASS ' + name);
}

test('current question HTML loses handlers, scripts, frames and executable links', () => {
	const element = render('Question ' + hostile);
	const title = element.querySelector('.title-content')!;
	assert.ok(title.textContent!.includes('Question'));
	assertNoExecutableContent(title);
});

test('a differing question returned by a bank is independently sanitized', () => {
	const element = render('Original plain question', 'Returned question ' + hostile);
	const returned = element.querySelector('.search-result .question')!;
	assert.ok(returned.textContent!.includes('Returned question'));
	assertNoExecutableContent(returned);
});

test('bank tag text cannot introduce executable HTML', () => {
	const element = render('Tag question', undefined, 'B', {
		tags: [{ text: hostile, title: 'description', color: 'blue' }]
	});
	const tag = element.querySelector('.search-result-answer-tag')!;
	assert.equal(tag.getAttribute('title'), 'description');
	assertNoExecutableContent(tag);
});

test('current question keeps benign formatting and generated signed image URLs', () => {
	const url = 'https://fixture.invalid/formula.png?token=local&size=20';
	const element = render('<strong>Question heading</strong>\n' + url);
	const title = element.querySelector('.title-content')!;
	assert.equal(title.querySelector('strong')?.textContent, 'Question heading');
	assert.equal(title.querySelector('img')?.getAttribute('src'), url);
	assertNoExecutableContent(title);
});

test('returned question keeps benign formatting and Base64 images', () => {
	const element = render('Original question', '<em>Returned heading</em> ' + png);
	const returned = element.querySelector('.search-result .question')!;
	assert.equal(returned.querySelector('em')?.textContent, 'Returned heading');
	assert.equal(returned.querySelector('img')?.getAttribute('src'), png);
	assertNoExecutableContent(returned);
});

test('tag text keeps compatible inline formatting', () => {
	const element = render('Tag question', undefined, 'B', {
		tags: [{ text: '<strong>Reference</strong>', title: 'description', color: 'blue' }]
	});
	const tag = element.querySelector('.search-result-answer-tag')!;
	assert.equal(tag.querySelector('strong')?.textContent, 'Reference');
	assertNoExecutableContent(tag);
});

test('bank answer keeps its existing sanitization and formatting', () => {
	const element = render('Bank answer question', undefined, '<strong>Safe answer</strong>' + hostile);
	const answer = element.querySelector('.answer code')!;
	assert.equal(answer.querySelector('strong')?.textContent, 'Safe answer');
	assertNoExecutableContent(answer);
});

test('native AI answer remains exact plain text including HTML and program punctuation', () => {
	const answer = '<strong>literal</strong>; ' + hostile;
	const element = render('Native answer question', undefined, answer, { ai: true, ai_native: true, answers: [answer] });
	const code = element.querySelector('.answer code')!;
	assert.equal(code.textContent, answer);
	assert.equal(code.children.length, 0);
	assertNoExecutableContent(code);
});

console.log(`Search result rendering safety: ${checks} scenarios passed.`);
