import assert from 'node:assert/strict';
import { readCXQuestionTypeCode } from '../packages/scripts/src/utils/cx-question-type';

const input = (name: string, id: string, value: string) => {
	const node = document.createElement('input');
	node.name = name;
	node.id = id;
	node.value = value;
	return node;
};
let checks = 0;
function test(name: string, action: () => void) {
	action();
	checks++;
	console.log('PASS ' + name);
}
for (const value of ['0', '1', '3', '4'])
	test('reads the platform hidden field code: ' + value, () => {
		assert.equal(readCXQuestionTypeCode([input('type123', '', value)]), Number(value));
	});
test('query and filling both skip a distracting first input', () => {
	assert.equal(readCXQuestionTypeCode([input('type', '', '0'), input('type123', '', '3')]), 3);
});
test('chapter hidden ID is accepted when no question-specific name exists', () => {
	assert.equal(readCXQuestionTypeCode([input('type', '', '0'), input('', 'answertype123', '3')]), 3);
});
test('reads the current DOM property after the attribute becomes stale', () => {
	const node = input('type123', '', '0');
	node.setAttribute('value', '0');
	node.value = '3';
	assert.equal(node.getAttribute('value'), '0');
	assert.equal(readCXQuestionTypeCode([node]), 3);
});
for (const value of ['', '3x', '-1'])
	test('malformed page field is not partially parsed: ' + JSON.stringify(value), () => {
		assert.equal(readCXQuestionTypeCode([input('type123', '', value)]), -1);
	});
test('conflicting authoritative fields fail instead of guessing from order', () => {
	assert.equal(readCXQuestionTypeCode([input('type123', '', '0'), input('type456', '', '3')]), -1);
});
test('duplicate agreeing fields retain their type', () => {
	assert.equal(readCXQuestionTypeCode([input('type123', '', '3'), input('type456', '', '3')]), 3);
});
test('missing or ambiguous generic fields remain unknown', () => {
	assert.equal(readCXQuestionTypeCode(), -1);
	assert.equal(readCXQuestionTypeCode([input('', '', '0'), input('', '', '3')]), -1);
});
console.log(`CX DOM question types: ${checks} scenarios passed.`);
