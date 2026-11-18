import test from 'node:test';
import assert from 'node:assert/strict';
import { diffWords, hintOf, isRight, labelMisses, sentenceLabel, tokens, toConfirm } from '../src/lib/intensive';

const status = (r: ReturnType<typeof diffWords>) => r.words.map((w) => `${w.w}:${w.status}`).join(' ');

test('diffWords marks missing and wrong words', () => {
	const r = diffWords('What did you do last night?', 'what do last night');
	assert.equal(status(r), 'what:ok did:missing you:missing do:ok last:ok night:ok');
	assert.equal(r.right, 4);
	assert.equal(r.total, 6);
});

test('apostrophes, case and small slips are fine', () => {
	const r = diffWords("I didn't pick up the phone", 'I didnt pick up the phome');
	assert.equal(r.right, 6, status(r));
	assert.equal(diffWords('the weather', 'the wether').right, 2);
});

test('a different word is wrong, with what was typed', () => {
	const r = diffWords("It's room fourteen", "its room forty");
	assert.equal(r.words[2]!.status, 'wrong');
	assert.equal(r.words[2]!.typed, 'forty');
});

test('tokens drop punctuation and quotes', () => {
	assert.deepEqual(tokens("It's 'quoted' two-thirty."), ["it's", 'quoted', 'two', 'thirty']);
});

test('labels: vocab, trap, speed, overload, sound', () => {
	const ref = 'What did you do last night';
	const r = diffWords(ref, 'what do last night');
	const traps = [{ text: 'did you', kind: 'linking' as const, real: '/dɪdʒə/' }];
	const m = labelMisses(ref, traps, r.words);
	assert.deepEqual(m.map((x) => x.label), ['linking', 'linking']);
	assert.equal(m[0]!.real, '/dɪdʒə/');
	assert.equal(labelMisses(ref, traps, r.words, ['did'])[0]!.label, 'vocab');
	const slow = diffWords(ref, 'what did you do last night').words;
	assert.deepEqual(labelMisses(ref, traps, r.words, [], slow).map((x) => x.label), ['speed', 'speed']);
	const long = 'we are going to meet at the station tomorrow morning before the early train leaves';
	const lm = labelMisses(long, [], diffWords(long, 'we are going to meet at the station tomorrow morning before').words);
	assert.ok(lm.length >= 2 && lm.every((x) => x.label === 'overload'));
	assert.equal(labelMisses('see you tomorrow', [], diffWords('see you tomorrow', 'see tomorrow').words)[0]!.label, 'weak');
	assert.equal(labelMisses('see the mountain', [], diffWords('see the mountain', 'see the').words)[0]!.label, 'sound');
	assert.equal(sentenceLabel([{ word: 'a', label: 'vocab' }, { word: 'b', label: 'linking' }]), 'linking');
	assert.equal(isRight({ right: 5, total: 6 }), false);
	assert.equal(isRight({ right: 6, total: 6 }), true);
});

test('a missing or extra ending is a miss, not a typo', () => {
	assert.equal(diffWords("You can't unboil an egg", 'you can unboil an egg').right, 4);
	assert.equal(diffWords('Eggs are made of proteins', 'eggs are made of protein').right, 4);
	assert.equal(diffWords('She walked home', 'she walk home').right, 2);
	assert.equal(diffWords('the weather', 'the wether').right, 2);
});

test('spelling is heard, another real word is not', () => {
	assert.equal(diffWords('I want to go there', 'i want to go their').right, 5);
	assert.equal(diffWords('better than that', 'better then that').right, 2);
	assert.equal(diffWords('my friend', 'my freind').right, 2);
	assert.equal(diffWords('do you sense them', 'do you sens them').right, 4);
});

test('labels: split, ending, spelling, informal', () => {
	const ref = 'She has a nice house';
	const typed = 'she has an ice house';
	const m = labelMisses(ref, [], diffWords(ref, typed).words, [], null, typed);
	assert.ok(m.length && m.every((x) => x.label === 'linking'), JSON.stringify(m));
	const e = 'You can\'t unboil an egg';
	assert.equal(labelMisses(e, [], diffWords(e, 'you can unboil an egg').words)[0]!.label, 'ending');
	const s = 'that was really uncomfortable';
	// Letters for other letters (rt -> ter): letters cannot tell, so the learner is asked
	assert.deepEqual(toConfirm(labelMisses(s, [], diffWords(s, 'that was really uncomfterble').words)).map((c) => c.word), ['uncomfortable']);
	assert.equal(labelMisses(s, [], diffWords(s, 'that was really uncomfterble').words, [], null, '', [], { uncomfortable: 'spelling' })[0]!.label, 'spelling');
	assert.equal(diffWords("I'm going to call you", 'im gonna call you').right, 5);
});

test('marks say which typed words are wrong and where words are missing', () => {
	const r = diffWords('Do you understand power', 'you understand flower');
	assert.deepEqual(r.marks.map((m) => `${m.status}:${m.gap}`), ['ok:1', 'ok:0', 'wrong:0']);
	assert.equal(r.tailGap, 0);
	assert.equal(diffWords('see you soon', '').tailGap, 3);
});

test('the hint is stars only, one per letter, and only when something was missed', () => {
	const ref = 'Mostly because I wanted to, well-known.';
	assert.deepEqual(hintOf(ref, diffWords(ref, 'mostly i').words), ['Mostly', '*******', 'I', '******', '**,', '****-*****.']);
	assert.equal(hintOf('see you', diffWords('see you', 'see you').words), null);
	// A word fixed only after the hint showed it is not "speed"
	const r = 'do you sense them';
	const first = diffWords(r, 'you sense them').words;
	const slow = diffWords(r, 'do you sense them').words;
	assert.equal(labelMisses(r, [], first, [], slow, '', [0])[0]!.label, 'weak');
	assert.equal(labelMisses(r, [], first, [], slow, '', [])[0]!.label, 'speed');
});

test('a letter for another sound is a miss, a spelling slip that keeps the sound is not', () => {
	assert.equal(diffWords('they reside there', 'they resize there').right, 2);
	assert.equal(diffWords('a sense', 'a sens').right, 2);
	assert.equal(diffWords('my community', 'my comunity').right, 2);
	assert.equal(diffWords('a receive', 'a recieve').right, 2);
	assert.equal(diffWords('the weather', 'the wether').right, 2);
	assert.equal(diffWords('he is thirty', 'he is thirteen').right, 2);
});

test('a close miss asks "misheard or misspelt?", and the answer sets the label', () => {
	const r = 'they reside there';
	const w = diffWords(r, 'they resize there').words;
	const plain = labelMisses(r, [], w, [], null, 'they resize there');
	assert.deepEqual(toConfirm(plain), [{ word: 'reside', typed: 'resize', guess: 'misheard' }]);
	assert.equal(labelMisses(r, [], w, [], null, '', [], { reside: 'spelling' })[0]!.label, 'spelling');
	assert.equal(labelMisses(r, [], w, [], null, '', [], { reside: 'misheard' })[0]!.label, 'confusable');
	// A far miss is not asked about
	assert.deepEqual(toConfirm(labelMisses('a reside', [], diffWords('a reside', 'a table').words)), []);
});
