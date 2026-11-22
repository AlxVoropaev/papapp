import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.mjs';

test('a parent shares one library with a read-only child account', async t => {
  let time = Date.now();
  const server = createApp({ databasePath: ':memory:', metadata: false, now: () => time });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  function client() {
    let cookie;
    return async (path, method = 'GET', data) => {
      const headers = { Origin: origin };
      if (cookie) headers.Cookie = cookie;
      if (data !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(origin + '/api/' + path, { method, headers, body: JSON.stringify(data) });
      if (response.headers.has('Set-Cookie')) cookie = response.headers.get('Set-Cookie').split(';')[0];
      return { status: response.status, data: await response.json() };
    };
  }

  const parent = client();
  const child = client();
  const unrelated = client();
  const password = 'example-test-parent';
  assert.equal((await child('videos')).status, 401);
  const created = await parent('families', 'POST', { name: 'Семейная полка', password });
  assert.equal(created.status, 201);
  assert.equal((await unrelated('families', 'POST', { name: 'Другая полка', password })).status, 201);

  const expired = await parent('pair-code', 'POST');
  time += 11 * 60 * 1000;
  assert.equal((await child('join', 'POST', { code: expired.data.code })).status, 400);
  const pairing = await parent('pair-code', 'POST');
  assert.equal(pairing.status, 201);
  assert.match(pairing.data.code, /^[0-9]{6}$/);
  const connected = await child('join', 'POST', { code: pairing.data.code.replace(/^(...)/, '$1 ') });
  assert.equal(connected.data.role, 'child');
  assert.equal(connected.data.family, created.data.family);
  assert.equal((await unrelated('join', 'POST', { code: pairing.data.code })).status, 400);

  const video = { url: 'https://youtu.be/M7lc1UVf-VE?si=anything', title: 'Проверка просмотра #наука #shorts', category: 'Наука' };
  assert.equal((await parent('videos', 'POST', { ...video, url: 'https://example.com/watch?v=M7lc1UVf-VE' })).status, 400);
  assert.equal((await parent('videos', 'POST', { ...video, title: '#shorts' })).status, 400);
  const added = await parent('videos', 'POST', video);
  assert.equal(added.status, 201);
  assert.equal(added.data.title, 'Проверка просмотра');
  assert.equal((await parent('videos', 'POST', { ...video, url: 'https://youtube.com/shorts/M7lc1UVf-VE' })).status, 409);
  assert.deepEqual((await child('videos')).data.videos, [added.data]);
  assert.deepEqual((await unrelated('videos')).data.videos, []);
  assert.equal((await child('videos', 'POST', video)).status, 403);
  assert.equal((await child('videos/' + added.data.id, 'DELETE')).status, 403);
  assert.equal((await unrelated('videos/' + added.data.id, 'DELETE')).status, 404);
  const initial = (await parent('categories')).data.categories;
  assert.equal(initial.length, 5);
  assert.equal((await child('categories', 'POST', { name: 'Космос' })).status, 403);
  const createdTags = await parent('categories', 'POST', { name: 'Космос' });
  const space = createdTags.data.categories.find(c => c.name === 'Космос');
  assert.ok(space.id);
  assert.equal((await parent('categories', 'POST', { name: 'космос' })).status, 409);
  assert.equal((await parent('categories', 'POST', { name: '  ' })).status, 400);
  assert.equal((await parent('categories', 'POST', { name: 'Все' })).status, 400);
  assert.equal((await unrelated('categories')).data.categories.length, 5);
  const edited = { title: 'Космос и наука', categories: [space.id, 'Наука'], note: 'Новая заметка' };
  assert.equal((await child('videos/' + added.data.id, 'PATCH', edited)).status, 403);
  assert.equal((await unrelated('videos/' + added.data.id, 'PATCH', edited)).status, 404);
  assert.equal((await parent('videos/' + added.data.id, 'PATCH', edited)).status, 200);
  assert.deepEqual((await child('videos')).data.videos[0].categories, [space.id, 'Наука']);
  assert.equal((await parent('videos/' + added.data.id, 'PATCH', { ...edited, categories: Array(11).fill('Наука') })).status, 400);
  const renamed = await parent('categories/' + space.id, 'PATCH', { name: 'Вселенная' });
  assert.equal(renamed.data.categories.find(c => c.id === space.id).name, 'Вселенная');
  assert.equal((await parent('categories/' + space.id, 'DELETE')).status, 200);
  assert.equal((await parent('categories/' + encodeURIComponent('Другое'), 'DELETE')).status, 400);
  const library = (await child('videos')).data;
  assert.equal(library.videos[0].title, edited.title);
  assert.equal(library.categories.some(c => c.id === space.id), false);
  assert.equal((await parent('videos/' + added.data.id, 'DELETE')).status, 200);
  assert.deepEqual((await child('videos')).data.videos, []);
  assert.equal((await parent('child-devices', 'DELETE')).status, 200);
  assert.equal((await child('videos')).status, 401);

  const recovered = client();
  const login = await recovered('login', 'POST', { family: created.data.family, password });
  assert.equal(login.data.role, 'parent');
  assert.equal((await recovered('logout', 'POST')).status, 200);
  assert.equal((await recovered('session')).status, 401);
});

test('opening an existing SQLite shelf preserves its videos and single category', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'polka-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE families(id TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL);
    CREATE TABLE videos(id TEXT PRIMARY KEY, family TEXT NOT NULL, youtube TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, note TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(family, youtube));
    INSERT INTO families VALUES ('old', 'Old shelf', 'salt', 'hash');
    INSERT INTO videos VALUES ('video', 'old', 'M7lc1UVf-VE', 'Старое видео', 'Наука', 'Заметка', 123);`);
  old.close();
  const server = createApp({ databasePath: path, metadata: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await new Promise(resolve => server.close(resolve));
  const migrated = new DatabaseSync(path);
  try {
    const video = migrated.prepare('SELECT * FROM videos').get();
    assert.equal(video.title, 'Старое видео');
    assert.equal(video.category, 'Наука');
    assert.equal(video.categories, null);
    assert.equal(video.note, 'Заметка');
    assert.equal(video.created, 123);
  } finally { migrated.close(); }
});
