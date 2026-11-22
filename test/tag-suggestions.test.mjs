import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryList } from '../public/catalog.js';
import { suggestTags, createTagSuggestions } from '../public/tag-suggestions.js';

const categories = categoryList([
  { id: 'space', name: 'Космос', active: true },
  { id: 'dinos', name: 'Динозавры', active: true }
]);

test('suggests several relevant existing tags, including custom names and Russian endings', () => {
  assert.deepEqual(new Set(suggestTags('Смешарики: научный мультфильм о планетах', categories)), new Set(['Наука', 'Мультфильмы', 'space']));
  assert.ok(suggestTags('Мир динозавров', categories).includes('dinos'));
  assert.ok(suggestTags('Оригами: рисуем и делаем поделки', categories).includes('Творчество'));
  assert.ok(suggestTags('SPACE: planets and galaxies', categories).includes('space'));
});

test('does not invent tags or match pieces inside unrelated words', () => {
  assert.deepEqual(suggestTags('', categories), []);
  assert.deepEqual(suggestTags('Новый выпуск 123', categories), []);
  assert.deepEqual(suggestTags('Космонавтика', [{ id: 'short', name: 'Кот' }]), []);
  assert.deepEqual(suggestTags('Мир динозавров', [{ id: 'Другое', name: 'Динозавры' }]), []);
  assert.deepEqual(suggestTags('Мир динозавров', categoryList([{ id: 'dinos', name: 'Динозавры', active: false }])), ['Природа']);
  assert.deepEqual(suggestTags('Научный эксперимент', [{ id: 'Наука', name: 'Рецепты' }]), []);
  assert.equal(suggestTags('Лего', Array.from({ length: 12 }, (_, n) => ({ id: String(n), name: 'Лего' }))).length, 9);
});

test('keeps manual choices protected until the user explicitly applies suggestions', () => {
  const state = createTagSuggestions();
  assert.equal(state.update('Космос', categories).apply, true);
  state.markManual();
  const updated = state.update('Рисуем', categories);
  assert.equal(updated.apply, false);
  assert.deepEqual(updated.suggested, ['Творчество']);
  assert.deepEqual(state.accept(), ['Творчество']);
  assert.equal(state.update('Космос', categories).apply, true);
  // A new form never inherits manual state from the previous video.
  assert.equal(createTagSuggestions().update('Космос', categories).apply, true);
});

test('LLM response updates hints while preserving manual selection state', async () => {
  let answer;
  let changed;
  const updated = new Promise(resolve => { changed = resolve; });
  const state = createTagSuggestions({ delay: 0,
    request: () => new Promise(resolve => { answer = resolve; }), onChange: changed });
  state.update('Необычное название', categories);
  await new Promise(resolve => setTimeout(resolve, 5));
  state.markManual();
  answer({ enabled: true, tags: ['space'] });
  const view = await updated;
  assert.equal(view.apply, false);
  assert.equal(view.source, 'llm');
  assert.deepEqual(view.suggested, ['space']);
  assert.deepEqual(state.accept(), ['space']);
  state.dispose();
});

test('late LLM results cannot replace hints for another title or a closed form', async () => {
  const resolvers = [];
  const changes = [];
  const state = createTagSuggestions({ delay: 0,
    request: () => new Promise(resolve => resolvers.push(resolve)), onChange: result => changes.push(result) });
  state.update('Первая тема', categories);
  await new Promise(resolve => setTimeout(resolve, 5));
  state.update('Вторая тема', categories);
  await new Promise(resolve => setTimeout(resolve, 5));
  resolvers[0]({ enabled: true, tags: ['space'] });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(changes.length, 0);
  state.dispose();
  resolvers[1]({ enabled: true, tags: ['Наука'] });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(changes.length, 0);
});

test('invalid or unavailable model responses retain keyword fallback', async () => {
  for (const request of [async () => ({ enabled: true, tags: ['invented'] }), async () => { throw new Error('quota'); }]) {
    let changed;
    const updated = new Promise(resolve => { changed = resolve; });
    const state = createTagSuggestions({ delay: 0, request, onChange: changed });
    state.update('Космос', categories);
    const view = await updated;
    assert.equal(view.source, 'local');
    assert.equal(view.unavailable, true);
    assert.ok(view.suggested.includes('space'));
    state.dispose();
  }
});
