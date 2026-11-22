import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const strings = await readFile(new URL('../android/app/src/main/res/values/strings.xml', import.meta.url), 'utf8');
const manifestUrl = strings.match(/name="apk_update_manifest"[^>]*>([^<]+)</)?.[1];
assert.ok(manifestUrl, 'Missing Android manifest endpoint');
const version = await readFile(new URL('../android/version.properties', import.meta.url), 'utf8');
const versionName = version.match(/^versionName=(.*)$/m)?.[1].trim();
const expected = JSON.parse(await readFile(new URL('../artifacts/releases/v' + versionName + '/latest.json', import.meta.url), 'utf8'));

async function download(url, maxBytes) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, 'Public GitHub download: HTTP ' + response.status + ' for ' + url);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= maxBytes, 'Public download exceeds expected size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const remote = JSON.parse((await download(manifestUrl, 32 * 1024)).toString('utf8'));
assert.deepEqual(remote, expected, 'Public latest.json differs from the staged release');
const apk = await download(remote.url, remote.size);
assert.equal(apk.length, remote.size);
assert.equal(createHash('sha256').update(apk).digest('hex'), remote.sha256);
console.log('Public GitHub release verified without credentials:', remote.versionName, remote.versionCode, remote.size, 'bytes; manifest and APK hash match.');
