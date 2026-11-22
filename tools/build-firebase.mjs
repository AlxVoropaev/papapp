import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const emulator = process.argv.includes('--emulator');
const aiConfig = JSON.parse(await readFile(new URL('../public/ai-config.json', import.meta.url), 'utf8'));
const aiEndpoint = process.env.POLKA_TAGS_ENDPOINT ?? aiConfig.endpoint ?? '';
const pairingServer = process.env.POLKA_PAIRING_SERVER ?? 'https://papina-polka-tags.alx-voropaev.workers.dev';
if (aiEndpoint && !/^https:\/\/[a-z0-9.-]+\.workers\.dev\/suggest$/.test(aiEndpoint)) throw new Error('Expected a HTTPS workers.dev /suggest endpoint.');
if (pairingServer && !/^https:\/\/[a-z0-9.-]+\.workers\.dev$/.test(pairingServer)) throw new Error('Expected a HTTPS workers.dev pairing origin.');
const directory = emulator ? 'dist/firebase-emulator' : 'dist/firebase';
const output = new URL('../' + directory + '/', import.meta.url);
const root = new URL('../', import.meta.url);
const releaseProperties = await readFile(new URL('android/version.properties', root), 'utf8');
const versionName = releaseProperties.match(/^versionName=([^\r\n]+)$/m)?.[1].trim();
const versionCode = releaseProperties.match(/^versionCode=([1-9]\d*)$/m)?.[1];
if (!versionName || !versionCode) throw new Error('Expected versionName and versionCode in android/version.properties.');
const releaseVersion = `${versionName} (${versionCode})`;
const bundled = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['public/app.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['chrome105', 'safari16.4'],
  define: {
    __POLKA_EMULATOR__: JSON.stringify(emulator),
    __POLKA_PAIRING_SERVER__: JSON.stringify(pairingServer),
    __POLKA_TAGS_ENDPOINT__: JSON.stringify(aiEndpoint),
    __POLKA_VIDEO_TITLE_ENDPOINT__: JSON.stringify(aiEndpoint ? new URL('/video-title', aiEndpoint).href : ''),
    __POLKA_RELEASE_VERSION__: JSON.stringify(releaseVersion)
  },
  write: false,
  outfile: 'app.js',
  plugins: [{
    name: 'firebase-backend',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/backend\.js$/ }, args => {
        if (args.importer === fileURLToPath(new URL('public/app.js', root))) {
          return { path: fileURLToPath(new URL('firebase/backend.js', root)) };
        }
      });
    }
  }]
});
const script = bundled.outputFiles[0].contents;
const html = await readFile(new URL('public/index.html', root), 'utf8');
const style = await readFile(new URL('public/style.css', root));
const icon = await readFile(new URL('public/icon.svg', root));
const manifest = await readFile(new URL('public/manifest.webmanifest', root));
const version = createHash('sha256').update(script).update(html).update(style)
  .update(icon).update(manifest).digest('hex').slice(0, 20);
const release = new URL('releases/' + version + '/', output);
// Retain earlier release assets so a page fetched just before deployment can finish loading.
await mkdir(release, { recursive: true });
await writeFile(new URL('app.js', release), script);
await writeFile(new URL('style.css', release), style);
for (const name of ['icon.svg', 'manifest.webmanifest']) {
  await copyFile(new URL('public/' + name, root), new URL(name, output));
}
await writeFile(new URL('index.html', output), html
  .replace('<head>', '<head>\n  <meta name="polka-version" content="' + version + '">')
  .replace('href="/style.css"', 'href="/releases/' + version + '/style.css"')
  .replace('src="/app.js"', 'src="/releases/' + version + '/app.js"'));
await writeFile(new URL('version.json', output), JSON.stringify({ version }) + '\n');
console.log('Built web release ' + version + ' in ' + directory);
