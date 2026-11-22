import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryList, videoTags, selectedTags } from '../public/catalog.js';
import { normalizeYoutubeTitle, youtubeId, youtubeTitle } from '../public/youtube.js';

test('legacy categories migrate to tags and deletion preserves remaining tags', () => {
  const list = categoryList([{ id: 'space', name: 'Космос', active: true }, { id: 'Наука', name: 'Научное', active: true }]);
  assert.deepEqual(videoTags({ category: 'Наука' }, list), ['Наука']);
  assert.deepEqual(videoTags({ categories: ['space', 'Наука', 'space'] }, list), ['space', 'Наука']);
  const removed = categoryList([{ id: 'space', name: 'Космос', active: false }]);
  assert.deepEqual(videoTags({ categories: ['space', 'Наука'] }, removed), ['Наука']);
  assert.deepEqual(videoTags({ categories: ['space'] }, removed), []);
  assert.deepEqual(selectedTags({ categories: [] }, list), []);
  assert.throws(() => selectedTags({ categories: Array(11).fill('space') }, list));
});

test('cleans hashtags from video titles and preserves episode numbers and C#', () => {
  assert.equal(normalizeYoutubeTitle('#шортс Выпуск #12: C# | #shorts #fun_2'), 'Выпуск #12: C#');
  assert.equal(normalizeYoutubeTitle('Песня | #музыка | Андрей [#концерт]'), 'Песня | Андрей');
  assert.equal(normalizeYoutubeTitle('#Shorts, (#мультфильм)'), '');
  assert.equal(normalizeYoutubeTitle('#shorts ' + 'а'.repeat(161)), 'а'.repeat(160));
});

test('extracts a cleaned and bounded title using a canonical YouTube URL only', async () => {
  let called;
  const result = await youtubeTitle('https://youtube.com/shorts/M7lc1UVf-VE?si=x', {
    fetcher: async (url, options) => {
      called = new URL(url);
      assert.equal(options.credentials, 'omit');
      return { ok: true, json: async () => ({ title: '  Проверка видео #shorts  ' }) };
    }
  });
  assert.deepEqual(result, { id: 'M7lc1UVf-VE', title: 'Проверка видео' });
  assert.equal(called.hostname, 'www.youtube.com');
  assert.equal(called.searchParams.get('url'), 'https://www.youtube.com/watch?v=M7lc1UVf-VE');
  assert.equal(youtubeId('https://youtube.com.evil.example/watch?v=M7lc1UVf-VE'), null);
  await assert.rejects(youtubeTitle('https://example.com/video', { fetcher: () => assert.fail('unexpected request') }));
  for (const response of [{ ok: false }, { ok: true, json: async () => ({}) }, { ok: true, json: async () => ({ title: '#shorts' }) }]) {
    await assert.rejects(youtubeTitle('https://youtu.be/M7lc1UVf-VE', { fetcher: async () => response }), /вручную/);
  }
});

test('loads a shared Shorts title through the metadata service and falls back to YouTube if needed', async () => {
  const input = 'https://youtube.com/shorts/jt6sgcW5rL4?si=ul6VohtykYSAWhdQ';
  const metadataEndpoint = 'https://tags.example/video-title';
  const expected = { id: 'jt6sgcW5rL4', title: 'Название видео' };
  const serviceUrl = metadataEndpoint + '?id=' + expected.id;
  for (const source of ['www.youtube-nocookie.com', 'tags.example', 'www.youtube.com']) {
    const calls = [];
    const result = await youtubeTitle(input, { metadataEndpoint, fetcher: async (url, options) => {
      calls.push(url.href);
      assert.equal(options.credentials, 'omit');
      if (url.hostname !== source) return new Response(null, { status: 502 });
      return Response.json({ title: expected.title });
    } });
    assert.deepEqual(result, expected);
    assert.equal(new URL(calls[0]).hostname, 'www.youtube-nocookie.com');
    assert.equal(new URL(calls.at(-1)).hostname, source);
    if (calls.length > 1) assert.equal(calls[1], serviceUrl);
    if (source === 'www.youtube.com') assert.equal(new URL(calls[2]).searchParams.get('url'), 'https://www.youtube.com/watch?v=' + expected.id);
  }
});

test('cancelled metadata lookups do not start a direct request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const lookup = youtubeTitle('https://youtu.be/jt6sgcW5rL4', {
    metadataEndpoint: 'https://tags.example/video-title',
    signal: controller.signal,
    fetcher: async (url, { signal }) => {
      calls++;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  });
  controller.abort();
  await assert.rejects(lookup, { name: 'AbortError' });
  assert.equal(calls, 1);
});
