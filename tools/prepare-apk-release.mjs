import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const apk = resolve(process.argv[2] || join(root, 'artifacts/papina-polka.apk'));
const sdk = process.env.ANDROID_SDK_ROOT || join(root, '.tooling/android-sdk');
const tools = join(sdk, 'build-tools/35.0.0');
execFileSync(join(tools, 'apksigner'), ['verify', apk]);
const metadata = execFileSync(join(tools, 'aapt2'), ['dump', 'badging', apk], { encoding: 'utf8' });
const pkg = metadata.match(/package: name='(polka\.mobile)' versionCode='([1-9]\d*)' versionName='([0-9A-Za-z._-]+)'/);
const version = await readFile(join(root, 'android/version.properties'), 'utf8');
if (!pkg || pkg[2] !== version.match(/^versionCode=(.*)$/m)?.[1].trim()
    || pkg[3] !== version.match(/^versionName=(.*)$/m)?.[1].trim() || /^application-debuggable$/m.test(metadata)) {
  throw new Error('Expected a non-debuggable polka.mobile APK matching android/version.properties');
}
const releaseDir = join(root, 'artifacts/releases', 'v' + pkg[3]);
const name = 'papina-polka-v' + pkg[2] + '.apk';
const strings = await readFile(join(root, 'android/app/src/main/res/values/strings.xml'), 'utf8');
const base = strings.match(/>(https:\/\/github\.com\/[^/]+\/[^/]+\/releases)\/latest\/download\/latest\.json</)?.[1];
if (!base) throw new Error('Expected a GitHub Releases manifest URL in strings.xml');
const bytes = await readFile(apk);
if (bytes.length > 50 * 1024 * 1024) throw new Error('APK exceeds the Android update size limit');
const release = {
  schema: 1, packageName: pkg[1], versionCode: Number(pkg[2]), versionName: pkg[3],
  source: 'direct', url: base + '/download/v' + pkg[3] + '/' + name,
  size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')
};
await mkdir(releaseDir, { recursive: true });
const destination = join(releaseDir, name);
try {
  await writeFile(destination, bytes, { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (!bytes.equals(await readFile(destination))) {
    throw new Error('This release is already staged with different APK bytes. Increase the version.');
  }
}
await writeFile(join(releaseDir, 'latest.json'), JSON.stringify(release, null, 2) + '\n');
console.log(releaseDir);
