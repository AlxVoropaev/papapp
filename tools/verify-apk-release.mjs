import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const expected = JSON.parse(await readFile(new URL('../updates/latest.json', import.meta.url), 'utf8'));
async function download(path) {
  const api = new URL('https://cloud-api.yandex.net/v1/disk/public/resources/download');
  api.searchParams.set('public_key', expected.url);
  api.searchParams.set('path', path);
  const metadata = await fetch(api, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert.ok(metadata.ok, 'Public Disk download metadata: HTTP ' + metadata.status);
  const { href } = await metadata.json();
  assert.equal(new URL(href).protocol, 'https:');
  const response = await fetch(href, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, 'Public Disk download: HTTP ' + response.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= 50 * 1024 * 1024, 'Public download exceeds APK size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const remote = JSON.parse((await download('/latest.json')).toString('utf8'));
assert.deepEqual(remote, expected, 'Public latest.json does not match the prepared release');
const apk = await download(remote.path);
assert.equal(apk.length, remote.size);
assert.equal(createHash('sha256').update(apk).digest('hex'), remote.sha256);
console.log('Public Yandex Disk release verified without credentials:', remote.versionName, remote.versionCode, remote.size, 'bytes; manifest and APK hash match.');
