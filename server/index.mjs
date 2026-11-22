import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeYoutubeTitle, youtubeId, youtubeTitle } from './youtube.mjs';
import { categoryList, validCategoryName, selectedTags } from '../public/catalog.js';

const scrypt = promisify(scryptCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

export function createApp({ databasePath = join(root, 'data', 'library.sqlite'), production = false, publicOrigin = '', setupKey = '', metadata = true, now = Date.now } = {}) {
  if (production && (!/^https:\/\//.test(publicOrigin) || !setupKey)) throw new Error('Production requires HTTPS PUBLIC_ORIGIN and SETUP_KEY.');
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS families(id TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, family TEXT NOT NULL REFERENCES families(id), role TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS codes(code TEXT PRIMARY KEY, family TEXT NOT NULL REFERENCES families(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS videos(id TEXT PRIMARY KEY, family TEXT NOT NULL REFERENCES families(id), youtube TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, note TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(family, youtube));
    CREATE TABLE IF NOT EXISTS categories(id TEXT NOT NULL, family TEXT NOT NULL REFERENCES families(id), name TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(family, id));`);
  if (!db.prepare('PRAGMA table_info(videos)').all().some(column => column.name === 'categories')) {
    db.exec("ALTER TABLE videos ADD COLUMN categories TEXT");
  }
  const tagsFor = (data, family) => {
    try { return selectedTags(data, categoryRows(family)); } catch (e) { fail(400, e.message); }
  };
  const categoryRows = family => categoryList(db.prepare('SELECT id, name, active FROM categories WHERE family=?').all(family));
  const buckets = new Map();
  function throttle(req, action, limit = 8, window = 60000) {
    const time = now();
    const key = `${req?.socket.remoteAddress ?? '*'}:${action}`;
    for (const [k, b] of buckets) if (b.until <= time) buckets.delete(k);
    const b = buckets.get(key) ?? { count: 0, until: time + window };
    buckets.set(key, b);
    if (++b.count > limit) fail(429, 'Слишком много попыток. Попробуйте позже.');
  }
  const text = (v, max, fallback = '') => typeof v === 'string' ? v.trim().slice(0, max) : fallback;
  function session(req, parent = false) {
    const raw = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('polka='))?.slice(6);
    const s = raw && db.prepare('SELECT s.*, f.name FROM sessions s JOIN families f ON f.id=s.family WHERE token=? AND expires>?').get(hash(raw), now());
    if (!s) fail(401, 'Войдите в свою полку.');
    if (parent && s.role !== 'parent') fail(403, 'Это действие доступно только родителю.');
    return s;
  }
  function issue(res, family, role) {
    const token = secret();
    const seconds = 60 * 60 * 24 * 90;
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hash(token), family, role, now() + seconds * 1000);
    res.setHeader('Set-Cookie', `polka=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${production ? '; Secure' : ''}`);
  }
  async function body(req) {
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'Ожидался JSON.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) fail(413, 'Слишком большой запрос.');
      chunks.push(chunk);
    }
    try { const b = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!b || typeof b !== 'object' || Array.isArray(b)) throw Error(); return b; }
    catch { fail(400, 'Не удалось прочитать запрос.'); }
  }
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
  const publicSession = s => ({ family: s.family, name: s.name, role: s.role });
  const files = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/web-update.js', ['web-update.js', 'text/javascript; charset=utf-8']],
    ['/catalog.js', ['catalog.js', 'text/javascript; charset=utf-8']],
    ['/tag-suggestions.js', ['tag-suggestions.js', 'text/javascript; charset=utf-8']],
    ['/youtube.js', ['youtube.js', 'text/javascript; charset=utf-8']],
    ['/backend.js', ['backend.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/icon.svg', ['icon.svg', 'image/svg+xml']],
    ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']]
  ]);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self'; img-src 'self' https://i.ytimg.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self' https://www.youtube.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const path = new URL(req.url, 'http://local').pathname;
      if (req.method === 'GET' && files.has(path)) {
        const [file, type] = files.get(path);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        const content = readFileSync(join(root, 'public', file));
        if (file === 'index.html' && setupKey) {
          return res.end(content.toString('utf8').replace('<html lang="ru">', '<html lang="ru" data-setup-key="required">'));
        }
        return res.end(content);
      }
      if (path === '/health' && req.method === 'GET') return json(res, 200, { ok: true });
      if (!['GET', 'HEAD'].includes(req.method)) {
        const origin = publicOrigin || `http://${req.headers.host}`;
        if (req.headers.origin !== origin) fail(403, 'Запрос с другого сайта запрещён.');
      }
      if (path === '/api/session' && req.method === 'GET') return json(res, 200, publicSession(session(req)));
      if (path === '/api/families' && req.method === 'POST') {
        throttle(req, 'create', 3);
        const b = await body(req);
        if (setupKey && (typeof b.setupKey !== 'string' || hash(b.setupKey) !== hash(setupKey))) fail(403, 'Нужен ключ создания полки от владельца сервера.');
        const name = text(b.name, 60);
        if (!name) fail(400, 'Как назвать вашу полку?');
        if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 128) fail(400, 'Пароль должен содержать от 8 до 128 символов.');
        const salt = secret();
        const password = (await scrypt(b.password, salt, 64)).toString('hex');
        const id = randomBytes(6).toString('hex').toUpperCase();
        db.prepare('INSERT INTO families VALUES (?, ?, ?, ?)').run(id, name, salt, password);
        issue(res, id, 'parent');
        return json(res, 201, { family: id, name, role: 'parent' });
      }
      if (path === '/api/login' && req.method === 'POST') {
        throttle(req, 'login', 5);
        const b = await body(req);
        if (typeof b.password !== 'string' || b.password.length > 128) fail(400, 'Проверьте пароль.');
        const family = db.prepare('SELECT * FROM families WHERE id=?').get(text(b.family, 12).toUpperCase());
        const derived = await scrypt(b.password, family?.salt ?? 'invalid-family-salt', 64);
        if (!family || !timingSafeEqual(derived, Buffer.from(family.password, 'hex'))) fail(401, 'Неверный номер полки или пароль.');
        issue(res, family.id, 'parent');
        return json(res, 200, { family: family.id, name: family.name, role: 'parent' });
      }
      if (path === '/api/join' && req.method === 'POST') {
        throttle(req, 'join', 5);
        const b = await body(req);
        const code = typeof b.code === 'string' ? b.code.replace(/[\s-]/g, '') : '';
        if (!/^(?:[0-9]{6}|[0-9]{8})$/.test(code)) fail(400, 'Введите код подключения из 6 цифр.');
        throttle(null, 'join-total', 30, 10 * 60_000);
        const row = db.prepare('SELECT * FROM codes WHERE code=? AND expires>?').get(hash(code), now());
        if (!row) fail(400, 'Код не найден или истёк. Попросите новый код у родителя.');
        db.prepare('DELETE FROM codes WHERE code=?').run(hash(code));
        issue(res, row.family, 'child');
        const family = db.prepare('SELECT name FROM families WHERE id=?').get(row.family);
        return json(res, 200, { family: row.family, name: family.name, role: 'child' });
      }
      if (path === '/api/logout' && req.method === 'POST') {
        const s = session(req);
        db.prepare('DELETE FROM sessions WHERE token=?').run(s.token);
        res.setHeader('Set-Cookie', `polka=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/pair-code' && req.method === 'POST') {
        const s = session(req, true);
        throttle(req, 'pair-code', 10);
        db.prepare('DELETE FROM codes WHERE family=? OR expires<=?').run(s.family, now());
        let code;
        do { code = String(randomInt(1000000)).padStart(6, '0'); } while (db.prepare('SELECT 1 FROM codes WHERE code=?').get(hash(code)));
        const expires = now() + 10 * 60 * 1000;
        db.prepare('INSERT INTO codes VALUES (?, ?, ?)').run(hash(code), s.family, expires);
        return json(res, 201, { code, expires });
      }
      if (path === '/api/child-devices' && req.method === 'DELETE') {
        const s = session(req, true);
        db.prepare("DELETE FROM sessions WHERE family=? AND role='child'").run(s.family);
        db.prepare('DELETE FROM codes WHERE family=?').run(s.family);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/tag-suggestions' && req.method === 'POST') {
        session(req, true);
        return json(res, 200, { enabled: false });
      }
      if (path === '/api/categories' && req.method === 'GET') {
        return json(res, 200, { categories: categoryRows(session(req).family) });
      }
      const categoryMatch = path.match(/^\/api\/categories\/([^/]+)$/);
      if ((path === '/api/categories' && req.method === 'POST') ||
          (categoryMatch && ['PATCH', 'DELETE'].includes(req.method))) {
        const s = session(req, true);
        const list = categoryRows(s.family);
        const id = categoryMatch ? decodeURIComponent(categoryMatch[1]) : 'c_' + randomBytes(12).toString('hex');
        if (categoryMatch && !list.some(c => c.id === id)) fail(404, 'Тема не найдена.');
        if (id === 'Другое') fail(400, 'Тема «Другое» нужна для видео без темы.');
        if (req.method === 'DELETE') {
          db.prepare('INSERT INTO categories VALUES (?, ?, ?, 0) ON CONFLICT(family, id) DO UPDATE SET active=0').run(id, s.family, list.find(c => c.id === id).name);
        } else {
          const b = await body(req);
          let name;
          try { name = validCategoryName(b.name); } catch (e) { fail(400, e.message); }
          if (list.some(c => c.id !== id && c.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) fail(409, 'Тема с таким названием уже есть.');
          db.prepare('INSERT INTO categories VALUES (?, ?, ?, 1) ON CONFLICT(family, id) DO UPDATE SET name=excluded.name, active=1').run(id, s.family, name);
        }
        return json(res, 200, { categories: categoryRows(s.family) });
      }
      if (path === '/api/videos' && req.method === 'GET') {
        const s = session(req);
        return json(res, 200, { videos: db.prepare('SELECT id, youtube, title, category, note, created, categories FROM videos WHERE family=? ORDER BY created DESC, rowid DESC').all(s.family).map(video => ({ ...video, categories: video.categories ? JSON.parse(video.categories) : (video.category === 'Другое' ? [] : [video.category]) })), categories: categoryRows(s.family) });
      }
      if (path === '/api/videos' && req.method === 'POST') {
        const s = session(req, true);
        throttle(req, 'add', 30);
        const b = await body(req);
        const youtube = youtubeId(b.url);
        if (!youtube) fail(400, 'Вставьте ссылку на одно видео YouTube, Shorts или youtu.be.');
        const tags = tagsFor(b, s.family);
        const category = tags[0] ?? 'Другое';
        let title = normalizeYoutubeTitle(b.title);
        if (!title && text(b.title, 160)) fail(400, 'Введите название видео.');
        if (!title && metadata) {
          try {
            title = (await youtubeTitle(b.url)).title;
          } catch { /* A user-entered title also works without YouTube metadata. */ }
        }
        if (!title) fail(400, 'Не получилось загрузить название с YouTube. Введите его вручную.');
        const video = { id: randomBytes(12).toString('hex'), youtube, title, category, categories: tags, note: text(b.note, 240), created: now() };
        try { db.prepare('INSERT INTO videos (id, family, youtube, title, category, note, created, categories) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(video.id, s.family, youtube, title, category, video.note, video.created, JSON.stringify(tags)); }
        catch (e) { if (e.code?.startsWith('ERR_SQLITE') && String(e.message).includes('UNIQUE')) fail(409, 'Это видео уже есть на полке.'); throw e; }
        return json(res, 201, video);
      }
      const videoMatch = path.match(/^\/api\/videos\/([a-f0-9]{24})$/);
      if (videoMatch && req.method === 'PATCH') {
        const s = session(req, true);
        const b = await body(req);
        const title = text(b.title, 160);
        if (!title) fail(400, 'Введите название видео.');
        const tags = tagsFor(b, s.family);
        const category = tags[0] ?? 'Другое';
        const result = db.prepare('UPDATE videos SET title=?, category=?, note=?, categories=? WHERE id=? AND family=?')
          .run(title, category, text(b.note, 240), JSON.stringify(tags), videoMatch[1], s.family);
        if (!result.changes) fail(404, 'Видео не найдено.');
        return json(res, 200, { ok: true });
      }
      if (videoMatch && req.method === 'DELETE') {
        const s = session(req, true);
        const result = db.prepare('DELETE FROM videos WHERE id=? AND family=?').run(videoMatch[1], s.family);
        if (!result.changes) fail(404, 'Видео не найдено.');
        return json(res, 200, { ok: true });
      }
      fail(404, 'Страница не найдена.');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('Request failed:', e.message);
      if (!res.headersSent) json(res, e.status ?? 500, { error: e.status ? e.message : 'Ошибка сервера. Попробуйте ещё раз.' });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3080);
  const server = createApp({ databasePath: process.env.DATABASE_PATH, production: process.env.NODE_ENV === 'production', publicOrigin: process.env.PUBLIC_ORIGIN, setupKey: process.env.SETUP_KEY, metadata: process.env.DISABLE_METADATA !== '1' });
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Видео полка: http://${process.env.HOST || '127.0.0.1'}:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
