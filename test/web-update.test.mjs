import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebUpdater } from '../public/web-update.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = { safe: true, latest: 'v1', reloads: 0, reads: 0 };
  const updater = createWebUpdater({
    version: 'v1',
    canReload: () => state.safe,
    reload: () => state.reloads++,
    fetchVersion: async () => {
      state.reads++;
      if (state.latest instanceof Error) throw state.latest;
      return state.latest;
    }
  });
  t.after(() => updater.stop());
  return { state, updater, tick: async () => { t.mock.timers.tick(1500); await settle(); } };
}

test('reloads once after detecting and confirming a different release', async t => {
  const { state, updater, tick } = fixture(t);
  await updater.check();
  await tick();
  assert.equal(state.reloads, 0);
  state.latest = 'v2';
  await updater.check();
  assert.equal(state.reloads, 0);
  await tick();
  assert.equal(state.reloads, 1);
  assert.equal(state.reads, 3);
  await updater.check();
  updater.reconsider();
  await tick();
  assert.equal(state.reloads, 1);
});

test('keeps a pending update until playback, forms, requests, and visibility allow it', async t => {
  const { state, updater, tick } = fixture(t);
  state.latest = 'v2';
  state.safe = false;
  await updater.check();
  await tick();
  assert.equal(state.reloads, 0);
  state.safe = true;
  updater.reconsider();
  // A form/video can open during the grace period.
  state.safe = false;
  await tick();
  assert.equal(state.reloads, 0);
  state.safe = true;
  updater.reconsider();
  await tick();
  assert.equal(state.reloads, 1);
});

test('rechecks safety after an asynchronous version confirmation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let safe = true;
  let reads = 0;
  let confirm;
  let reloads = 0;
  const updater = createWebUpdater({
    version: 'v1', canReload: () => safe, reload: () => reloads++,
    fetchVersion: () => ++reads === 1 ? Promise.resolve('v2') : new Promise(resolve => { confirm = resolve; })
  });
  t.after(() => updater.stop());
  await updater.check();
  t.mock.timers.tick(1500);
  safe = false;
  confirm('v2');
  await settle();
  assert.equal(reloads, 0);
});

test('failed checks and failed confirmation leave the working page intact without a retry loop', async t => {
  const { state, updater, tick } = fixture(t);
  state.latest = new Error('offline');
  await updater.check();
  await tick();
  assert.equal(state.reads, 1);
  assert.equal(state.reloads, 0);
  state.latest = 'v2';
  await updater.check();
  state.latest = new Error('offline again');
  await tick();
  await tick();
  assert.equal(state.reads, 3);
  assert.equal(state.reloads, 0);
  state.latest = 'v2';
  await updater.check();
  await tick();
  assert.equal(state.reloads, 1);
});

test('a rollback to the loaded release cancels the pending update', async t => {
  const { state, updater, tick } = fixture(t);
  state.latest = 'v2';
  await updater.check();
  state.latest = 'v1';
  await tick();
  assert.equal(state.reloads, 0);
  updater.reconsider();
  await tick();
  assert.equal(state.reads, 2);
});

test('invalid manifests never cause a reload', async t => {
  const { state, updater, tick } = fixture(t);
  for (const value of [undefined, null, {}, '', '<html>unavailable</html>', 'a'.repeat(81)]) {
    state.latest = value;
    await updater.check();
    await tick();
  }
  assert.equal(state.reloads, 0);
});

test('unversioned local pages do not request updates', async () => {
  const updater = createWebUpdater({
    canReload: () => true,
    reload: () => assert.fail('unexpected reload'),
    fetchVersion: () => assert.fail('unexpected version check')
  });
  await updater.check();
  updater.stop();
});

test('coalesces concurrent checks and cancels delayed reload on stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  let resolve;
  const updater = createWebUpdater({
    version: 'v1', canReload: () => true,
    reload: () => assert.fail('unexpected reload'),
    fetchVersion: () => { reads++; return new Promise(done => { resolve = done; }); }
  });
  const request = updater.check();
  await updater.check();
  assert.equal(reads, 1);
  resolve('v2');
  await request;
  updater.stop();
  t.mock.timers.tick(1500);
  await settle();
  assert.equal(reads, 1);
});
