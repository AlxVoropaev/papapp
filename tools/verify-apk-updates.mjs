// Disposable test data only; always targets an emulator, never a physical phone.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = process.env.ANDROID_SDK_ROOT || join(root, '.tooling/android-sdk');
const java = process.env.JAVA_HOME || join(root, '.tooling/zulu17.58.21-ca-jdk17.0.15-macosx_aarch64');
const serial = process.env.ANDROID_TEST_SERIAL || 'emulator-5554';
assert.match(serial, /^emulator-\d+$/, 'This test must not target a physical device');
const folder = await mkdtemp(join(tmpdir(), 'polka-apk-test-'));
const adb = (...args) => execFileSync(join(sdk, 'platform-tools/adb'), ['-s', serial, ...args], {
  encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe']
}).trim();
const command = (file, args, env = {}) => {
  const result = spawnSync(file, args, { cwd: root, env: { ...process.env, JAVA_HOME: java, ANDROID_SDK_ROOT: sdk, ...env }, encoding: 'utf8', timeout: 90000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await wait(500); }
  throw new Error('Timed out: ' + description);
}
function appFile(path) {
  try { return adb('shell', 'run-as', 'polka.mobile', 'cat', path); } catch { return ''; }
}
function installed() {
  return Number(adb('shell', 'dumpsys', 'package', 'polka.mobile').match(/versionCode=(\d+)/)?.[1]);
}
function screen() {
  try { adb('shell', 'uiautomator', 'dump', '--compressed', '/sdcard/polka-update-test.xml'); }
  catch (error) { if (!String(error.stdout).includes('UI hierchary dumped to:')) throw error; }
  return adb('shell', 'cat', '/sdcard/polka-update-test.xml');
}
function nodeWithText(xml, text) {
  return (xml.match(/<node\b[^>]*>/g) || [])
    .find(node => node.toLowerCase().includes('text="' + text.toLowerCase() + '"'));
}
function tapText(text) {
  const node = nodeWithText(screen(), text);
  assert.ok(node, 'Missing UI text: ' + text);
  tapNode(node);
}
function tapNode(node) {
  const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);
  adb('shell', 'input', 'tap', String((bounds[0] + bounds[2]) >> 1), String((bounds[1] + bounds[3]) >> 1));
}
function findInstallPrompt() {
  return (screen().match(/<node\b[^>]*>/g) || [])
    .find(node => /text="(Install|Update|Установить|Обновить)"/i.test(node));
}

let manifest;
let apkBytes;
let downloads = 0;
let failManifest = false;
let server;
let port;
let installedBootstrap = false;
let originalPreferences = '';
const link = 'https://youtu.be/M7lc1UVf-VE';
const startWithDraft = () => adb('shell', 'am', 'start', '-W', '-n', 'polka.mobile/.MainActivity',
  '-a', 'android.intent.action.SEND', '-t', 'text/plain', '--es', 'android.intent.extra.TEXT', link);
const hasDraft = () => {
  const xml = screen();
  return nodeWithText(xml, link)?.includes('class="android.widget.EditText"') && nodeWithText(xml, 'Закрыть');
};
try {
  await until(() => { try { return adb('shell', 'getprop', 'sys.boot_completed') === '1'; } catch { return false; } }, 'emulator boot', 90000);
  adb('shell', 'input', 'keyevent', '224');
  adb('shell', 'input', 'keyevent', '82');
  for (const [version, target, name] of [[3, 35, 'bootstrap'], [4, 30, 'confirmation'], [5, 35, 'silent'], [6, 35, 'manual']]) {
    const output = join(folder, name + '.apk');
    command('bash', ['tools/build-local-apk.sh', '--local'], {
      POLKA_VERSION_CODE: String(version), POLKA_VERSION_NAME: '0.3.' + version,
      POLKA_TEST_TARGET_SDK: String(target), POLKA_TEST_LOCAL_UPDATES: '1', POLKA_APK_OUTPUT: output
    });
  }
  console.log('Built signed APKs for the emulator update scenarios.');
  originalPreferences = appFile('shared_prefs/MainActivity.xml');
  adb('install', '-r', '-d', join(folder, 'bootstrap.apk'));
  installedBootstrap = true;
  adb('shell', 'am', 'force-stop', 'polka.mobile');
  adb('shell', 'run-as', 'polka.mobile', 'rm', '-f', 'shared_prefs/apk-updates.xml', 'files/apk-updates/ready.apk', 'files/apk-updates/ready.json');

  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/android/latest.json' && failManifest) {
      res.writeHead(503);
      return res.end();
    }
    const json = new Map([
      ['/api/session', { role: 'parent', family: 'TEST', name: 'Тестовая полка' }],
      ['/api/videos', { videos: [], categories: [] }],
      ['/android/latest.json', manifest]
    ]);
    if (json.has(path)) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(json.get(path)));
    }
    if (path === '/update.apk') { downloads++; return res.end(apkBytes); }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  // adb reverse avoids exposing a test server on the LAN.
  port = server.address().port;
  adb('reverse', 'tcp:' + port, 'tcp:' + port);
  const origin = 'http://127.0.0.1:' + port;
  const settings = join(folder, 'MainActivity.xml');
  await writeFile(settings, '<?xml version="1.0"?><map><string name="endpoint">' + origin + '/</string></map>');
  adb('push', settings, '/data/local/tmp/polka-update-test-settings.xml');
  adb('shell', 'run-as', 'polka.mobile', 'mkdir', '-p', 'shared_prefs');
  adb('shell', 'run-as', 'polka.mobile', 'cp', '/data/local/tmp/polka-update-test-settings.xml', 'shared_prefs/MainActivity.xml');

  const setRelease = async (name, version) => {
    apkBytes = await readFile(join(folder, name + '.apk'));
    manifest = { schema: 1, packageName: 'polka.mobile', versionCode: version, versionName: '0.3.' + version,
      url: origin + '/update.apk', size: apkBytes.length, sha256: createHash('sha256').update(apkBytes).digest('hex') };
  };
  await setRelease('confirmation', 4);
  manifest.sha256 = '0'.repeat(64);
  startWithDraft();
  await until(hasDraft, 'native add-video form contains the shared link');
  await until(() => downloads > 0, 'checksum-rejection download');
  await wait(2500);
  assert.ok(!appFile('shared_prefs/apk-updates.xml').includes('name="readyVersion"'));
  assert.equal(installed(), 3);
  console.log('PASS: invalid checksum rejected without installation.');

  command(join(java, 'bin/keytool'), ['-genkeypair', '-keystore', join(folder, 'wrong.jks'), '-storepass', 'test-password',
    '-keypass', 'test-password', '-alias', 'wrong', '-dname', 'CN=Wrong Test Signer', '-keyalg', 'RSA', '-validity', '1']);
  command(join(sdk, 'build-tools/35.0.0/apksigner'), ['sign', '--ks', join(folder, 'wrong.jks'), '--ks-pass', 'pass:test-password',
    '--out', join(folder, 'wrong.apk'), join(folder, 'confirmation.apk')]);
  await setRelease('wrong', 4);
  let previousDownloads = downloads;
  adb('shell', 'cmd', 'jobscheduler', 'run', '-f', 'polka.mobile', '704103');
  await until(() => downloads > previousDownloads, 'wrong-signature download');
  await wait(2500);
  assert.ok(!appFile('shared_prefs/apk-updates.xml').includes('name="readyVersion"'));
  assert.equal(installed(), 3);
  console.log('PASS: correctly hashed APK with a different signing key rejected.');

  await setRelease('confirmation', 4);
  adb('shell', 'cmd', 'jobscheduler', 'run', '-f', 'polka.mobile', '704103');
  await until(() => appFile('shared_prefs/apk-updates.xml').includes('name="readyVersion"'), 'verified background download');
  await wait(2500);
  assert.equal(installed(), 3);
  assert.ok(hasDraft(), 'Native add-video form retains the shared link');
  assert.ok(!appFile('shared_prefs/apk-updates.xml').includes('name="session"'), 'Installation waits for the native draft');
  console.log('PASS: completed background download waits while the native form is open.');

  // Pre-grant only the test emulator's per-app install-source permission, then exercise PackageInstaller UI.
  adb('shell', 'appops', 'set', 'polka.mobile', 'REQUEST_INSTALL_PACKAGES', 'allow');
  tapText('Закрыть');
  await until(() => appFile('shared_prefs/apk-updates.xml').includes('confirmation'), 'Android requests confirmation');
  let install;
  await until(() => {
    install = findInstallPrompt();
    return Boolean(install);
  }, 'system installation confirmation visible');
  tapNode(install);
  await until(() => installed() === 4, 'confirmed installation of version 4');
  console.log('PASS: Android confirmation fallback installs the signed update.');

  await setRelease('silent', 5);
  startWithDraft();
  await until(hasDraft, 'native add-video form reopens after the confirmed update');
  previousDownloads = downloads;
  adb('shell', 'cmd', 'jobscheduler', 'run', '-f', 'polka.mobile', '704103');
  await until(() => downloads > previousDownloads, 'automatic-update download');
  await until(() => appFile('shared_prefs/apk-updates.xml').includes('name="readyVersion"'), 'automatic-update ready');
  await wait(2500);
  assert.equal(installed(), 4);
  assert.ok(hasDraft(), 'Native form remains open with a qualifying silent update waiting');
  tapText('Закрыть');
  await until(() => installed() === 5, 'automatic self-update without confirmation');
  console.log('PASS: Android 14 installs a qualifying self-update automatically.');
  assert.ok(appFile('shared_prefs/MainActivity.xml').includes(origin), 'App preferences survive both updates');

  adb('shell', 'am', 'start', '-W', '-n', 'polka.mobile/.MainActivity');
  let settingsButton;
  await until(() => {
    settingsButton = (screen().match(/<node\b[^>]*>/g) || []).find(node => node.includes('content-desc="Настройки"'));
    return Boolean(settingsButton);
  }, 'settings button');
  tapNode(settingsButton);
  await until(() => nodeWithText(screen(), 'Установлена актуальная версия'), 'up-to-date status when opening settings');
  assert.ok(!nodeWithText(screen(), 'Обновить приложение'));
  failManifest = true;
  tapText('Проверить обновления');
  await until(() => nodeWithText(screen(), 'Не удалось проверить обновления. Попробуйте ещё раз.'), 'failed manual check');
  assert.ok(!nodeWithText(screen(), 'Обновить приложение'));
  failManifest = false;
  await setRelease('manual', 6);
  tapText('Проверить обновления');
  await until(() => nodeWithText(screen(), 'Обновить приложение'), 'manual install button');
  assert.equal(installed(), 5, 'Settings stay open while the update is ready');
  tapText('Обновить приложение');
  install = null;
  await until(() => {
    if (installed() === 6) return true;
    if (appFile('shared_prefs/apk-updates.xml').includes('confirmation')) install = findInstallPrompt();
    return Boolean(install);
  }, 'manual update runs or opens Android confirmation');
  if (install) tapNode(install);
  await until(() => installed() === 6, 'manual installation of version 6');
  console.log('PASS: settings checks for updates, handles network errors, and installs the verified APK on tap.');
} finally {
  try {
    if (installedBootstrap) {
      adb('shell', 'am', 'force-stop', 'polka.mobile');
      if (originalPreferences) {
        await writeFile(join(folder, 'restore.xml'), originalPreferences);
        adb('push', join(folder, 'restore.xml'), '/data/local/tmp/polka-update-test-settings.xml');
        adb('shell', 'run-as', 'polka.mobile', 'cp', '/data/local/tmp/polka-update-test-settings.xml', 'shared_prefs/MainActivity.xml');
      } else adb('shell', 'run-as', 'polka.mobile', 'rm', '-f', 'shared_prefs/MainActivity.xml');
      adb('shell', 'run-as', 'polka.mobile', 'rm', '-f', 'shared_prefs/apk-updates.xml', 'files/apk-updates/ready.apk', 'files/apk-updates/ready.json');
      adb('shell', 'cmd', 'jobscheduler', 'cancel', 'polka.mobile', '704103');
      adb('install', '-r', '-d', join(folder, 'bootstrap.apk'));
    }
    if (port) adb('reverse', '--remove', 'tcp:' + port);
  } catch (e) { console.error('Test cleanup:', e.message); }
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(folder, { recursive: true, force: true });
}
