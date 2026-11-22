import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, copyFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const apk = resolve(process.argv[2] || join(root, 'artifacts/papina-polka.apk'));
const sdk = process.env.ANDROID_SDK_ROOT || join(root, '.tooling/android-sdk');
const tools = join(sdk, 'build-tools/35.0.0');
const verification = spawnSync(join(tools, 'apksigner'), ['verify', apk], { encoding: 'utf8' });
if (verification.status !== 0) throw new Error('APK signature verification failed: ' + verification.stderr);
const metadata = spawnSync(join(tools, 'aapt2'), ['dump', 'badging', apk], { encoding: 'utf8' });
const pkg = metadata.stdout.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/);
if (!pkg || pkg[1] !== 'polka.mobile') throw new Error('Expected a polka.mobile APK');
const bytes = await readFile(apk);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const directory = join(root, 'updates');
await mkdir(directory, { recursive: true });
const name = 'papina-polka-v' + pkg[2] + '.apk';
const destination = join(directory, name);
let existing;
try { existing = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing && createHash('sha256').update(existing).digest('hex') !== sha256) {
  throw new Error('This versionCode is already staged with different APK bytes. Increase android/version.properties.');
}
await copyFile(apk, destination);
const strings = await readFile(join(root, 'android/app/src/main/res/values/strings.xml'), 'utf8');
const publicFolder = process.env.POLKA_UPDATE_FOLDER || strings.match(/name="apk_update_manifest"[^>]*>([^<]*)<\//)?.[1];
if (!publicFolder) {
  console.log('Staged ' + destination + '. Public updates folder URL is needed before generating latest.json.');
  process.exit(0);
}
if (!/^https:\/\/(disk\.yandex\.(ru|com)|disk\.360\.yandex\.ru|yadi\.sk)\/d\/[A-Za-z0-9_-]+\/?$/.test(publicFolder)) {
  throw new Error('Expected a public Yandex Disk folder URL');
}
const release = {
  schema: 1, packageName: pkg[1], versionCode: Number(pkg[2]), versionName: pkg[3],
  source: 'yandex-disk', url: publicFolder, path: '/' + name, size: bytes.length, sha256
};
if (process.argv.includes('--stage-only')) {
  console.log('Staged ' + destination + '; latest.json was not changed.');
  process.exit(0);
}
// The sync client may upload files out of order. Do not announce an APK before Disk has it.
const resourceUrl = new URL('https://cloud-api.yandex.net/v1/disk/public/resources');
resourceUrl.searchParams.set('public_key', publicFolder);
resourceUrl.searchParams.set('path', '/' + name);
resourceUrl.searchParams.set('fields', 'name,size,sha256');
const deadline = Date.now() + 180000;
let verified = false;
console.log('Waiting for Yandex Disk to sync ' + name + '…');
while (Date.now() < deadline) {
  try {
    const response = await fetch(resourceUrl, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const remote = await response.json();
      if (remote.size === release.size && remote.sha256 === release.sha256) { verified = true; break; }
    }
  } catch { /* Retry without changing the currently published manifest. */ }
  await new Promise(resolve => setTimeout(resolve, 3000));
}
if (!verified) throw new Error('APK has not synced to public Disk yet; latest.json was not changed. Resume Disk sync and rerun.');
// Publish this pointer last; all APK filenames are immutable.
await writeFile(join(directory, 'latest.json.tmp'), JSON.stringify(release, null, 2) + '\n');
await rename(join(directory, 'latest.json.tmp'), join(directory, 'latest.json'));
console.log('Prepared ' + name + ' and updates/latest.json. Verify Disk sync before announcing this release.');
