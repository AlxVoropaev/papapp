import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/index.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = createApp({ databasePath: ':memory:', metadata: false });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://www.youtube.com/iframe_api', route => route.fulfill({ contentType: 'text/javascript', body: `
    window.YT={PlayerState:{ENDED:0},Player:class {
      constructor(mount,options){this.frame=document.createElement('iframe');mount.replaceWith(this.frame);setTimeout(()=>options.events.onReady(),0)}
      destroy(){this.frame.remove()} pauseVideo(){}
    }};window.onYouTubeIframeAPIReady();` }));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.polkaReady);
  const begin = () => page.evaluate(() => window.polkaBeginApkUpdate());
  const end = () => page.evaluate(() => window.polkaEndApkUpdate());
  assert.equal(await begin(), true);
  assert.equal(await page.locator('body').evaluate(body => body.inert), true);
  await end();
  assert.equal(await page.locator('body').evaluate(body => body.inert), false);
  await page.getByRole('button', { name: 'Создать полку' }).click();
  await page.locator('input[name="name"]').fill('APK safety test');
  await page.locator('input[name="password"]').fill('apk-safety-password');
  assert.equal(await begin(), false);
  assert.equal(await page.locator('input[name="name"]').inputValue(), 'APK safety test');
  let releaseRequest;
  const gate = new Promise(resolve => { releaseRequest = resolve; });
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route('**/api/families', async route => { started(); await gate; await route.continue(); });
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await requestStarted;
  await page.getByRole('button', { name: 'Закрыть' }).click();
  assert.equal(await begin(), false, 'closed form with pending write must block APK installation');
  releaseRequest();
  await page.getByRole('heading', { name: 'Полка пока пуста' }).waitFor();
  assert.equal(await begin(), true);
  await end();
  await page.evaluate(async () => {
    const response = await fetch('/api/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://youtu.be/M7lc1UVf-VE', title: 'APK player test', category: 'Другое' }) });
    if (!response.ok) throw new Error(await response.text());
  });
  await page.reload();
  await page.locator('.card-main').filter({ hasText: 'APK player test' }).click();
  await page.locator('iframe').waitFor();
  assert.equal(await begin(), false, 'player blocks APK installation');
  await page.evaluate(() => window.polkaPausePlayback());
  assert.equal(await begin(), false, 'paused player still blocks APK installation');
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await page.waitForFunction(() => window.polkaBeginApkUpdate());
  await end();
  assert.deepEqual(errors, []);
  console.log('PASS: actual web app blocks APK installation for forms, pending saves and playing/paused video; idle lock is reversible.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
