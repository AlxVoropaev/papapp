// Run with PLAYWRIGHT_MODULE pointing to an installed playwright ESM entry point.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server/index.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const cloudRoot = new URL('../dist/firebase/', import.meta.url);
const cloudVersion = JSON.parse(await readFile(new URL('version.json', cloudRoot), 'utf8')).version;
let cloudBuild = false;
const app = createApp({ databasePath: ':memory:', metadata: false });
const handler = app.listeners('request')[0];
app.removeAllListeners('request');
let version = 'v1';
let versionUnavailable = false;
let saveGate;
let saveStarted;
app.on('request', async (req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (cloudBuild) return res.end(await readFile(new URL('index.html', cloudRoot)));
    return res.end(html.replace('<head>', '<head><meta name="polka-version" content="' + version + '">'));
  }
  if (cloudBuild && req.url === '/__/firebase/init.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ projectId: 'demo-papina-polka', apiKey: 'test-key', appId: '1:1:web:test' }));
  }
  if (cloudBuild && [
    '/releases/' + cloudVersion + '/app.js', '/releases/' + cloudVersion + '/style.css'
  ].includes(req.url)) {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.js') ? 'text/javascript' : 'text/css' });
    return res.end(await readFile(new URL(req.url.slice(1), cloudRoot)));
  }
  if (req.url === '/version.json') {
    res.writeHead(versionUnavailable ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ version }));
  }
  if (req.method === 'POST' && req.url === '/api/videos' && saveGate) {
    saveStarted?.();
    await saveGate;
  }
  handler(req, res);
});
app.listen(0, '127.0.0.1');
await once(app, 'listening');
const address = 'http://127.0.0.1:' + app.address().port;
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 412, height: 885 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Isolate update behaviour from YouTube availability and autoplay restrictions.
  await page.route('https://www.youtube.com/iframe_api', route => route.fulfill({
    contentType: 'text/javascript',
    body: `window.YT = {
      PlayerState: { ENDED: 0 },
      Player: class {
        constructor(mount, options) {
          this.frame = document.createElement('iframe');
          this.frame.src = 'https://www.youtube-nocookie.com/embed/test';
          mount.replaceWith(this.frame);
          window.testEndVideo = () => options.events.onStateChange({ data: 0 });
          setTimeout(() => options.events.onReady(), 0);
        }
        destroy() { this.frame.remove(); }
        pauseVideo() { window.testVideoPaused = true; }
      }
    }; window.onYouTubeIframeAPIReady();`
  }));
  await page.route('https://www.youtube-nocookie.com/embed/test', route => route.fulfill({
    contentType: 'text/html', body: '<p>Test player</p>'
  }));
  await page.goto(address);
  await page.getByRole('heading', { name: 'Видео от папы' }).waitFor();
  const loadedVersion = () => page.locator('meta[name="polka-version"]').getAttribute('content');
  const check = () => page.evaluate(() => window.dispatchEvent(new Event('online')));
  const waitForVersion = expected => page.waitForFunction(value =>
    document.querySelector('meta[name="polka-version"]').content === value && window.polkaReady, expected);

  // A received YouTube share must survive until login and adding the video.
  await page.evaluate(() => window.polkaReceiveShare('https://youtu.be/M7lc1UVf-VE'));
  version = 'v2';
  await check();
  await page.waitForTimeout(1800);
  assert.equal(await loadedVersion(), 'v1');
  await page.getByRole('button', { name: 'Создать полку' }).click();
  await page.getByLabel('Название полки').fill('Проверка обновлений');
  await page.getByLabel('Пароль родителя').fill('update-test-password');
  await check();
  await page.waitForTimeout(1800);
  assert.equal(await page.getByLabel('Название полки').inputValue(), 'Проверка обновлений');
  assert.equal(await page.getByLabel('Пароль родителя').inputValue(), 'update-test-password');
  assert.equal(await loadedVersion(), 'v1');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.getByRole('heading', { name: 'Добавить видео', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Ссылка на YouTube').inputValue(), 'https://youtu.be/M7lc1UVf-VE');
  await page.locator('input[name="title"]').fill('Первое видео');
  await page.getByLabel('Заметка для сына').fill('Не потерять заметку');
  await check();
  await page.waitForTimeout(1800);
  assert.equal(await page.getByLabel('Заметка для сына').inputValue(), 'Не потерять заметку');
  await page.getByRole('button', { name: 'Добавить на полку' }).click();
  await waitForVersion('v2');
  await page.getByText('Первое видео', { exact: true }).waitFor();
  console.log('PASS: pending share, filled forms, successful save, and login survive the update.');

  await page.locator('.card-main').filter({ hasText: 'Первое видео' }).click();
  await page.locator('iframe').waitFor();
  version = 'v3';
  await check();
  await page.waitForTimeout(1800);
  assert.equal(await loadedVersion(), 'v2');
  assert.equal(await page.locator('iframe').count(), 1);
  await page.evaluate(() => window.polkaPausePlayback());
  await check();
  await page.waitForTimeout(1800);
  assert.equal(await loadedVersion(), 'v2');
  assert.equal(await page.evaluate(() => window.testVideoPaused), true);
  await page.evaluate(() => window.testEndVideo());
  await waitForVersion('v3');
  await page.getByText('Первое видео', { exact: true }).waitFor();
  console.log('PASS: playing and paused player defer the update; video end releases it.');

  await page.getByRole('button', { name: 'Добавить видео' }).click();
  await page.getByLabel('Ссылка на YouTube').fill('https://youtu.be/aqz-KE-bpKQ');
  await page.locator('input[name="title"]').fill('Медленное сохранение');
  let finishSave;
  saveGate = new Promise(resolve => { finishSave = resolve; });
  const started = new Promise(resolve => { saveStarted = resolve; });
  await page.getByRole('button', { name: 'Добавить на полку' }).click();
  await started;
  await page.getByRole('button', { name: 'Закрыть' }).click();
  version = 'v4';
  await check();
  await page.waitForTimeout(1800);
  assert.equal(await loadedVersion(), 'v3');
  finishSave();
  saveGate = undefined;
  await waitForVersion('v4');
  await page.getByText('Медленное сохранение', { exact: true }).waitFor();
  console.log('PASS: closing a dialog during an in-flight save does not allow premature reload.');

  version = 'v5';
  versionUnavailable = true;
  await check();
  await page.waitForTimeout(1800);
  assert.equal(await loadedVersion(), 'v4');
  versionUnavailable = false;
  await check();
  await waitForVersion('v5');
  await page.getByText('Медленное сохранение', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: unavailable version endpoint keeps the app working; recovery applies the update.');

  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Подключить устройство' }).click();
  const code = await page.locator('.pair-code').textContent();
  await page.getByRole('button', { name: 'Закрыть' }).click();
  const child = await browser.newPage();
  child.on('pageerror', error => errors.push(error.message));
  await child.goto(address);
  await child.getByRole('heading', { name: 'Видео от папы' }).waitFor();
  await child.evaluate(() => window.polkaReceiveShare('https://youtu.be/M7lc1UVf-VE'));
  await child.getByRole('button', { name: 'Ввести код с телефона папы' }).click();
  await child.getByLabel('Код из 6 цифр').fill(code);
  await child.getByRole('button', { name: 'Подключить', exact: true }).click();
  await child.getByText('Первое видео', { exact: true }).waitFor();
  version = 'v6';
  await child.evaluate(() => window.dispatchEvent(new Event('online')));
  await child.waitForFunction(() => document.querySelector('meta[name="polka-version"]').content === 'v6' && window.polkaReady);
  await child.getByText('Первое видео', { exact: true }).waitFor();
  assert.equal(await child.getByRole('button', { name: 'Настройки' }).count(), 0);
  await child.close();
  console.log('PASS: child connection survives reload; unsupported incoming share does not block updates.');

  cloudBuild = true;
  version = cloudVersion;
  await page.reload();
  await page.getByRole('heading', { name: 'Видео от папы' }).waitFor();
  assert.equal(await loadedVersion(), cloudVersion);
  await page.getByRole('button', { name: 'Создать полку' }).click();
  await page.getByLabel('Почта родителя').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: the production bundle boots with the Firebase backend and matching versioned assets.');
} finally {
  await browser.close();
  await new Promise(resolve => app.close(resolve));
}
