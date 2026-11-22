import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../android/app/src/main/assets/watch-time.js', import.meta.url), 'utf8');

test('a view requires over a minute of playback and counts once per player', () => {
  let now = 0;
  let position = 0;
  let rate = 1;
  const context = { performance: { now: () => now } };
  runInNewContext(script, context);
  const timer = context.createWatchTimer();
  const player = {
    getCurrentTime: () => position,
    getPlaybackRate: () => rate
  };
  const sample = (elapsed, advance) => {
    now += elapsed * 1000;
    position += advance;
    return timer.sample(player);
  };

  assert.equal(sample(0, 0), false);
  assert.equal(sample(0.5, 120), false);
  assert.equal(sample(0.5, -60), false);
  assert.equal(sample(30, 30), false);
  for (let i = 0; i < 60; i++) assert.equal(sample(0.5, 0.5), false);
  timer.interrupt();
  assert.equal(sample(0.5, 0.5), false);
  assert.equal(sample(0.5, 0), false);
  rate = 2;
  assert.equal(sample(0, 0), false);
  for (let i = 0; i < 60; i++) assert.equal(sample(0.5, 1), false);
  assert.equal(sample(0.5, 1), true);
  assert.equal(sample(0.5, 1), false);
});
