// Uses temporary local data or Firebase emulators; never connects to the live shelf.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createApp } from '../server/index.mjs';
import { createWorker, PairingCodes } from '../cloudflare/worker.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cloud = process.argv.includes('--emulator');
const setup = 'catalog-emulator-only';
let server;
if (cloud) {
  const claim = createHash('sha256').update(setup).digest('hex');
  const seed = await fetch('http://127.0.0.1:8089/v1/projects/demo-papina-polka/databases/(default)/documents/setupSecrets/' + claim, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { enabled: { booleanValue: true } } })
  });
  assert.equal(seed.status, 200);
  const headers = JSON.parse(await readFile('firebase.json', 'utf8')).hosting.headers[0].headers;
  const csp = headers.find(h => h.key === 'Content-Security-Policy').value
    .replace('connect-src ', 'connect-src http://127.0.0.1:9099 http://127.0.0.1:8089 ' + (process.env.POLKA_TAGS_ENDPOINT ? new URL(process.env.POLKA_TAGS_ENDPOINT).origin + ' ' : ''));
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.includes('..')) { res.writeHead(404); return res.end(); }
    const name = path === '/' ? 'index.html' : path.slice(1);
    try {
      const content = await readFile('dist/firebase-emulator/' + name);
      res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/json', 'Content-Security-Policy': csp });
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
} else server = createApp({ databasePath: ':memory:', metadata: false });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: 'chrome' });
await mkdir('output/playwright', { recursive: true });
try {
  const parent = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const child = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  for (const page of [parent, child]) { page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); }
  const aiEndpoint = process.env.POLKA_TAGS_ENDPOINT;
  const sharedShorts = 'https://youtube.com/shorts/jt6sgcW5rL4?si=ul6VohtykYSAWhdQ';
  const shortsTitle = 'Почему бедные беднеют, а богатые всё больше богатеют';
  let privacyEndpointAvailable = true;
  if (cloud) {
    const storage = new Map();
    const codes = new PairingCodes({ storage: { transaction: fn => fn({
      get: key => structuredClone(storage.get(key)), put: (key, value) => storage.set(key, structuredClone(value))
    }) } });
    const worker = createWorker({ fetcher: (url, settings) => fetch(new URL(new URL(url).pathname, 'http://127.0.0.1:8089'), settings) });
    const env = { ALLOWED_ORIGINS: base, FIREBASE_PROJECT_ID: 'demo-papina-polka',
      PAIRING: { idFromName: name => name, get: () => ({ fetch: (url, init) => codes.fetch(new Request(url, init)) }) } };
    for (const page of [parent, child]) await page.route((process.env.POLKA_PAIRING_SERVER ?? 'https://papina-polka-tags.alx-voropaev.workers.dev') + '/pairing/*', async route => {
      const req = route.request();
      const headers = new Headers(await req.allHeaders());
      headers.set('Origin', base);
      const response = await worker.fetch(new Request(req.url(), {
        method: req.method(), headers, body: req.postData() ?? undefined
      }), env);
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await parent.route('https://www.youtube-nocookie.com/oembed?*', route => {
      const video = new URL(route.request().url()).searchParams.get('url');
      if (!privacyEndpointAvailable || !video.endsWith('jt6sgcW5rL4')) return route.abort('connectionfailed');
      return route.fulfill({ headers: { 'Access-Control-Allow-Origin': base }, json: { title: shortsTitle } });
    });
    const { endpoint } = JSON.parse(await readFile('public/ai-config.json', 'utf8'));
    const titleEndpoint = new URL('/video-title', aiEndpoint ?? endpoint).href;
    await parent.route(titleEndpoint + '?*', async route => {
      const id = new URL(route.request().url()).searchParams.get('id');
      const headers = { 'Access-Control-Allow-Origin': base };
      if (id === 'jt6sgcW5rL4') return route.fulfill({ headers, json: { title: shortsTitle } });
      return route.fulfill({ status: 502, headers });
    });
  }
  if (aiEndpoint) await parent.route(aiEndpoint, async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: {
      'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Headers': 'Authorization, Content-Type'
    } });
    const { title } = route.request().postDataJSON();
    const tags = title === 'Ночь в музее' ? ['Мультфильмы'] : ['Творчество'];
    if (title === 'Утро в музее') await new Promise(resolve => setTimeout(resolve, 500));
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base }, body: JSON.stringify({ enabled: true, tags, source: 'llm' }) });
  });
  let releaseSlow;
  let slowStarted;
  const started = new Promise(resolve => { slowStarted = resolve; });
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  await parent.route('https://www.youtube.com/oembed?*', async route => {
    const video = new URL(route.request().url()).searchParams.get('url');
    if (video.endsWith('jt6sgcW5rL4')) return route.abort('connectionfailed');
    if (video.endsWith('aqz-KE-bpKQ')) { slowStarted(); await slow; }
    if (video.endsWith('abcdefghijk')) return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
    await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ title: video.endsWith('jNQXAC9IVRw') ? 'Динозавры — научный мультфильм' : video.endsWith('aqz-KE-bpKQ') ? 'Медленный ответ' : 'Название с YouTube | #shorts #видео' }) }).catch(() => {});
  });
  await parent.goto(base);
  await parent.getByRole('button', { name: 'Создать полку' }).click();
  if (cloud) {
    await parent.getByLabel('Почта родителя').fill('catalog-' + Date.now() + '@example.com');
    await parent.getByLabel('Ключ создания').fill(setup);
  }
  await parent.getByLabel('Пароль родителя').fill('catalog-only-test');
  await parent.getByRole('button', { name: 'Создать', exact: true }).click();
  await parent.getByRole('heading', { name: 'Полка пока пуста' }).waitFor();
  assert.deepEqual(await parent.getByRole('banner').getByRole('button').allTextContents(), ['', '', '']);
  assert.equal(await parent.locator('#app .hero').count(), 0);
  assert.equal(await parent.getByRole('heading', { name: 'Видео', exact: true }).count(), 0);
  if (cloud) {
    for (const available of [true, false]) {
      privacyEndpointAvailable = available;
      await parent.evaluate(url => window.polkaReceiveShare(url), sharedShorts);
      await parent.waitForFunction(title => document.querySelector('input[name=title]')?.value === title, shortsTitle);
      await parent.getByRole('button', { name: 'Закрыть' }).click();
    }
  }
  await parent.getByRole('button', { name: 'Настройки' }).click();
  await parent.getByRole('button', { name: 'Подключить устройство', exact: true }).click();
  const code = await parent.locator('.pair-code').textContent();
  assert.match(code, /^[0-9]{3} [0-9]{3}$/);
  await parent.getByRole('button', { name: 'Закрыть' }).click();
  await child.goto(base);
  await child.getByRole('button', { name: 'Ввести код с телефона папы' }).click();
  await child.getByLabel(cloud ? 'Код подключения' : 'Код из 6 цифр').fill(code);
  await child.getByRole('button', { name: 'Подключить', exact: true }).click();
  await child.getByRole('heading', { name: 'Полка пока пуста' }).waitFor();
  await child.getByRole('banner').getByRole('button', { name: 'Обновить', exact: true }).waitFor();
  assert.equal(await child.getByRole('banner').getByRole('button').count(), 1);
  await parent.getByRole('button', { name: 'Настройки' }).click();
  await parent.getByRole('button', { name: 'Темы видео', exact: true }).click();
  await parent.getByLabel('Новая тема').fill('Космос');
  await parent.getByRole('button', { name: 'Добавить тему' }).click();
  await parent.getByText('Космос', { exact: true }).waitFor();
  await parent.getByLabel('Новая тема').fill('космос');
  await parent.getByRole('button', { name: 'Добавить тему' }).click();
  await parent.getByText('Тема с таким названием уже есть.').waitFor();
  await parent.getByRole('button', { name: 'Закрыть' }).click();
  await parent.evaluate(() => window.polkaReceiveShare('https://youtu.be/M7lc1UVf-VE'));
  await parent.waitForFunction(() => document.querySelector('input[name=title]').value === 'Название с YouTube');
  await parent.getByRole('checkbox', { name: 'Наука', exact: true }).check();
  await parent.getByRole('checkbox', { name: 'Космос', exact: true }).check();
  assert.equal(await parent.locator('body').evaluate(el => el.scrollWidth <= innerWidth), true);
  await parent.screenshot({ path: 'output/playwright/tags-' + (cloud ? 'cloud' : 'local') + '.png' });
  await parent.getByRole('button', { name: 'Добавить на полку' }).click();
  if (!cloud) await child.getByRole('button', { name: 'Обновить', exact: true }).click();
  await child.getByText('Название с YouTube', { exact: true }).waitFor();
  const cardText = await parent.locator('.card-text').boundingBox();
  const headerAction = await parent.getByRole('button', { name: 'Обновить', exact: true }).boundingBox();
  for (const name of ['Изменить видео Название с YouTube', 'Удалить видео Название с YouTube']) {
    const button = parent.getByRole('button', { name, exact: true });
    assert.equal(await button.textContent(), '');
    const bounds = await button.boundingBox();
    assert.ok(bounds.y + bounds.height <= cardText.y, 'Card actions belong above the text');
    assert.ok(bounds.width < headerAction.width && bounds.height < headerAction.height, 'Card actions are smaller than header buttons');
  }
  for (const name of ['Космос', 'Наука']) {
    await child.getByRole('button', { name, exact: true }).click();
    assert.equal(await child.locator('.card').count(), 1);
  }
  assert.equal(await child.getByRole('button', { name: /Изменить|Настройки/ }).count(), 0);
  await parent.getByRole('button', { name: 'Настройки' }).click();
  await parent.getByRole('button', { name: 'Темы видео', exact: true }).click();
  await parent.locator('.category-row').filter({ hasText: 'Космос' }).getByRole('button', { name: 'Изменить', exact: true }).click();
  await parent.getByLabel('Название темы').fill('Вселенная');
  await parent.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await parent.getByRole('dialog').getByText('Вселенная', { exact: true }).waitFor();
  if (!cloud) await child.getByRole('button', { name: 'Обновить', exact: true }).click();
  await child.getByRole('button', { name: 'Вселенная', exact: true }).waitFor();
  await parent.getByRole('button', { name: 'Удалить тему Вселенная' }).click();
  await parent.getByRole('button', { name: 'Удалить тему', exact: true }).click();
  await parent.getByRole('heading', { name: 'Темы видео', exact: true }).waitFor();
  if (!cloud) await child.getByRole('button', { name: 'Обновить', exact: true }).click();
  await child.getByRole('button', { name: 'Наука', exact: true }).click();
  assert.equal(await child.locator('.card').count(), 1);
  await parent.getByRole('button', { name: 'Закрыть' }).click();
  await parent.getByRole('button', { name: 'Изменить видео Название с YouTube' }).click();
  await parent.getByRole('checkbox', { name: 'Наука', exact: true }).uncheck();
  await parent.getByRole('button', { name: 'Сохранить', exact: true }).click();
  if (!cloud) await child.getByRole('button', { name: 'Обновить', exact: true }).click();
  await child.getByRole('button', { name: 'Другое', exact: true }).waitFor();
  await child.reload();
  await child.getByText('Название с YouTube', { exact: true }).waitFor();
  await parent.getByRole('banner').getByRole('button', { name: 'Добавить видео', exact: true }).click();
  await parent.getByLabel('Ссылка на YouTube').fill('https://youtu.be/aqz-KE-bpKQ');
  await started;
  await parent.getByLabel('Название', { exact: true }).fill('Моё название #проверка');
  releaseSlow();
  await parent.getByText('Название оставлено как вы ввели.').waitFor();
  assert.equal(await parent.getByLabel('Название', { exact: true }).inputValue(), 'Моё название #проверка');
  await parent.getByLabel('Ссылка на YouTube').fill('https://youtu.be/abcdefghijk');
  await parent.getByRole('button', { name: 'Повторить загрузку названия' }).waitFor();
  assert.equal(await parent.getByLabel('Название', { exact: true }).inputValue(), 'Моё название #проверка');
  await parent.getByRole('button', { name: 'Добавить на полку' }).click();
  await parent.getByText('Моё название', { exact: true }).waitFor();
  await parent.getByRole('button', { name: 'Удалить видео Моё название', exact: true }).click();
  await parent.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
  await parent.getByText('Моё название', { exact: true }).waitFor({ state: 'hidden' });
  await parent.getByRole('button', { name: 'Настройки' }).click();
  await parent.getByRole('button', { name: 'Темы видео', exact: true }).click();
  await parent.getByLabel('Новая тема').fill('Динозавры');
  await parent.getByRole('button', { name: 'Добавить тему' }).click();
  await parent.getByText('Динозавры', { exact: true }).waitFor();
  await parent.getByRole('button', { name: 'Закрыть' }).click();
  await parent.evaluate(() => window.polkaReceiveShare('https://youtu.be/jNQXAC9IVRw'));
  await parent.getByText('По названию выбраны:', { exact: false }).waitFor();
  for (const tag of ['Наука', 'Природа', 'Мультфильмы', 'Динозавры']) {
    assert.equal(await parent.getByRole('checkbox', { name: tag, exact: true }).isChecked(), true);
  }
  await parent.getByRole('checkbox', { name: 'Природа', exact: true }).uncheck();
  await parent.getByLabel('Название', { exact: true }).fill('Рисуем динозавров');
  assert.equal(await parent.getByRole('checkbox', { name: 'Природа', exact: true }).isChecked(), false);
  assert.equal(await parent.getByRole('checkbox', { name: 'Мультфильмы', exact: true }).isChecked(), true);
  assert.equal(await parent.getByRole('checkbox', { name: 'Творчество', exact: true }).isChecked(), false);
  await parent.getByRole('button', { name: 'Применить подсказки' }).click();
  assert.equal(await parent.getByRole('checkbox', { name: 'Мультфильмы', exact: true }).isChecked(), false);
  assert.equal(await parent.getByRole('checkbox', { name: 'Творчество', exact: true }).isChecked(), true);
  await parent.getByRole('checkbox', { name: 'Природа', exact: true }).uncheck();
  await parent.screenshot({ path: 'output/playwright/tag-suggestions-' + (cloud ? 'cloud' : 'local') + '.png' });
  await parent.getByRole('button', { name: 'Добавить на полку' }).click();
  const saved = parent.locator('.card').filter({ hasText: 'Рисуем динозавров' });
  await saved.waitFor();
  assert.equal(await saved.locator('.category').textContent(), 'Творчество · Динозавры');
  if (!cloud) await child.getByRole('button', { name: 'Обновить', exact: true }).click();
  // The previous filter must not hide the new card during sync verification.
  await child.getByRole('button', { name: 'Все', exact: true }).click();
  await child.getByText('Рисуем динозавров', { exact: true }).waitFor();
  if (cloud && aiEndpoint) {
    await parent.getByRole('banner').getByRole('button', { name: 'Добавить видео', exact: true }).click();
    await parent.getByLabel('Название', { exact: true }).fill('Ночь в музее');
    await parent.getByText('AI предложил:', { exact: false }).waitFor();
    assert.equal(await parent.getByRole('checkbox', { name: 'Мультфильмы', exact: true }).isChecked(), true);
    await parent.getByLabel('Название', { exact: true }).fill('Утро в музее');
    await parent.getByRole('checkbox', { name: 'Природа', exact: true }).check();
    await parent.getByText('Проверяем подсказки с AI', { exact: false }).waitFor({ state: 'hidden' });
    assert.equal(await parent.getByRole('checkbox', { name: 'Природа', exact: true }).isChecked(), true);
    assert.equal(await parent.getByRole('checkbox', { name: 'Творчество', exact: true }).isChecked(), false);
    await parent.screenshot({ path: 'output/playwright/ai-suggestions.png' });
    await parent.getByRole('button', { name: 'Применить подсказки' }).click();
    assert.equal(await parent.getByRole('checkbox', { name: 'Творчество', exact: true }).isChecked(), true);
    await parent.getByRole('button', { name: 'Закрыть' }).click();
  }
  assert.deepEqual(errors, []);
  console.log('PASS ' + (cloud ? 'Firebase' : 'SQLite') + ': shared-link title, manual override, metadata failure, multiple tags, filters, rename, delete, untagged videos, child sync, reload, title-based tag suggestions and manual overrides.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
