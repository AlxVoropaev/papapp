import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence, connectAuthEmulator, createUserWithEmailAndPassword, indexedDBLocalPersistence,
  initializeAuth, sendPasswordResetEmail, signInAnonymously, signInWithEmailAndPassword, signOut
} from 'firebase/auth';
import {
  collection, connectFirestoreEmulator, deleteDoc, doc, getDocFromServer, getDocsFromServer,
  getFirestore, onSnapshot, orderBy, query, runTransaction, serverTimestamp, writeBatch
} from 'firebase/firestore';
import { normalizeYoutubeTitle, youtubeId } from '../public/youtube.js';
import { categoryList, defaultCategories, validCategoryName } from '../public/catalog.js';

export const cloud = true;
export const shortCodes = Boolean(__POLKA_PAIRING_SERVER__);
let initializing;
let session;

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

async function initialize() {
  const emulator = __POLKA_EMULATOR__;
  let config = { projectId: 'demo-papina-polka', apiKey: 'emulator-key' };
  if (!emulator) {
    const response = await fetch('/__/firebase/init.json', { cache: 'no-store' });
    if (!response.ok) throw problem(503, 'Не загрузилась конфигурация Firebase.');
    config = await response.json();
  }
  const app = initializeApp(config);
  const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  const db = getFirestore(app);
  if (emulator) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8089);
  }
  await auth.authStateReady();
  return { auth, db };
}

function services() {
  initializing ??= initialize().catch(error => {
    initializing = undefined;
    throw error;
  });
  return initializing;
}

async function publicSession({ auth, db }) {
  const user = auth.currentUser;
  if (!user) throw problem(401, 'Войдите в свою полку.');
  let family = user.uid;
  if (user.isAnonymous) {
    const membership = await getDocFromServer(doc(db, 'children', user.uid));
    if (!membership.exists()) throw problem(401, 'Подключите полку по коду.');
    family = membership.data().family;
  }
  const shelf = await getDocFromServer(doc(db, 'families', family));
  if (!shelf.exists()) throw problem(401, 'Полка ещё не создана.');
  session = { family, name: shelf.data().name, role: user.isAnonymous ? 'child' : 'parent' };
  return session;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), b => alphabet[b & 31]).join('');
}

async function createShelf({ auth, db }, data) {
  const email = data.email.trim();
  const name = data.name.trim();
  const code = data.setupKey.trim();
  if (!name || !code) throw problem(400, 'Введите название и ключ создания.');
  const claim = await sha256(code);
  let user;
  try {
    ({ user } = await createUserWithEmailAndPassword(auth, email, data.password));
  } catch (error) {
    if (error.code !== 'auth/email-already-in-use') throw error;
    ({ user } = await signInWithEmailAndPassword(auth, email, data.password));
  }
  const family = doc(db, 'families', user.uid);
  if ((await getDocFromServer(family)).exists()) return;
  const batch = writeBatch(db);
  batch.set(doc(db, 'settings', 'owner'), { uid: user.uid, claim });
  batch.set(family, { name, epoch: 1 });
  try {
    await batch.commit();
  } catch (error) {
    if (error.code === 'permission-denied') {
      await signOut(auth);
      throw problem(403, 'Проверьте ключ создания. Для уже созданной полки используйте вход.');
    }
    throw error;
  }
}

async function pair({ auth, db }, input) {
  let code = input.toUpperCase().replace(/[\s-]/g, '');
  if (shortCodes && /^[0-9]{6}$/.test(code)) {
    ({ invite: code } = await pairingRequest('resolve', { code }));
  }
  if (typeof code !== 'string' || !/^[A-HJ-NP-Z2-9]{24}$/.test(code)) {
    throw problem(400, shortCodes ? 'Введите код подключения из 6 цифр.' : 'Введите код подключения из 24 символов.');
  }
  if (auth.currentUser && !auth.currentUser.isAnonymous) await signOut(auth);
  const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
  const invite = doc(db, 'invites', code);
  try {
    await runTransaction(db, async tx => {
      const row = (await tx.get(invite)).data();
      if (!row) throw problem(400, 'Код уже использован или истёк. Попросите новый.');
      tx.update(invite, { claimedBy: user.uid });
      tx.set(doc(db, 'children', user.uid), { family: row.family, epoch: row.epoch, invite: code });
    });
  } catch (error) {
    if (error.code !== 'permission-denied') throw error;
    const membership = await getDocFromServer(doc(db, 'children', user.uid));
    if (membership.data()?.invite === code) {
      try {
        return await publicSession({ auth, db });
      } catch (sessionError) {
        if (sessionError.code !== 'permission-denied') throw sessionError;
      }
    }
    throw problem(400, 'Код недействителен. Проверьте его или попросите новый.');
  }
  return publicSession({ auth, db });
}

async function pairingRequest(action, data, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let response;
  try {
    response = await fetch(__POLKA_PAIRING_SERVER__ + '/pairing/' + action, {
      method: 'POST', headers, body: JSON.stringify(data), signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw problem(503, 'Не удалось связаться с сервисом подключения. Проверьте интернет.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw problem(response.status, result.error || 'Сервис подключения временно недоступен.');
  return result;
}

async function makeInvite(auth, db, familyId) {
  const code = newCode();
  const family = doc(db, 'families', familyId);
  await runTransaction(db, async tx => {
    const record = await tx.get(family);
    tx.set(doc(db, 'invites', code), {
      family: familyId, epoch: record.data().epoch, claimedBy: null, createdAt: serverTimestamp()
    });
    tx.set(doc(family, 'private', 'pairing'), { invite: code });
  });
  if (shortCodes) return pairingRequest('issue', { invite: code }, await auth.currentUser.getIdToken());
  return { code };
}

async function revokeChildren(db, familyId) {
  const family = doc(db, 'families', familyId);
  await runTransaction(db, async tx => {
    const record = await tx.get(family);
    tx.update(family, { epoch: record.data().epoch + 1 });
  });
}

function userError(error, activeSession = session) {
  if (error.status) return error;
  if (error.code === 'permission-denied' && activeSession?.role === 'child') {
    return problem(401, 'Подключите полку снова.');
  }
  const messages = {
    'auth/invalid-email': 'Проверьте адрес электронной почты.',
    'auth/invalid-credential': 'Неверная почта или пароль.',
    'auth/wrong-password': 'Неверная почта или пароль.',
    'auth/user-not-found': 'Неверная почта или пароль.',
    'auth/weak-password': 'Используйте более длинный пароль.',
    'auth/too-many-requests': 'Слишком много попыток. Попробуйте позже.',
    'auth/operation-not-allowed': 'Вход через Firebase ещё не настроен.',
    'permission-denied': 'У этого устройства нет доступа к полке.',
    'auth/network-request-failed': 'Проверьте подключение к интернету.',
    unavailable: 'Проверьте подключение к интернету.'
  };
  console.debug('Firebase request:', error.code ?? error.message);
  return problem(400, messages[error.code] ?? 'Не удалось выполнить действие. Попробуйте ещё раз.');
}

function videoList(db, family) {
  return query(collection(db, 'families', family, 'videos'), orderBy('created', 'desc'));
}

function videoData(snapshot) {
  return snapshot.docs.map(entry => {
    const { created, ...video } = entry.data();
    return { ...video, created: created?.toMillis() ?? 0, id: entry.id, youtube: entry.id };
  });
}

export function subscribeVideos(activeSession, onChange, onFailure, onCategories) {
  let stopped = false;
  let unsubscribeVideos;
  let unsubscribeFamily;
  let unsubscribeCategories;
  services().then(({ db }) => {
    if (stopped) return;
    const failure = error => { if (!stopped) onFailure(userError(error, activeSession)); };
    unsubscribeVideos = onSnapshot(videoList(db, activeSession.family), { includeMetadataChanges: true }, snapshot => {
      if (!stopped && !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) onChange(videoData(snapshot));
    }, failure);
    unsubscribeCategories = onSnapshot(collection(db, 'families', activeSession.family, 'categories'), { includeMetadataChanges: true }, snapshot => {
      if (!stopped && !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) onCategories?.(categoryList(snapshot.docs.map(row => ({ ...row.data(), id: row.id }))));
    }, failure);
    if (activeSession.role === 'child') {
      const shelf = doc(db, 'families', activeSession.family);
      unsubscribeFamily = onSnapshot(shelf, () => {}, failure);
    }
  }).catch(error => { if (!stopped) onFailure(userError(error, activeSession)); });
  return () => {
    stopped = true;
    unsubscribeVideos?.();
    unsubscribeFamily?.();
    unsubscribeCategories?.();
  };
}

export async function api(path, method = 'GET', data) {
  try {
    const app = await services();
    const { auth, db } = app;
    if (path === 'session') return await publicSession(app);
    if (path === 'families') {
      await createShelf(app, data);
      return await publicSession(app);
    }
    if (path === 'login') {
      await signInWithEmailAndPassword(auth, data.email.trim(), data.password);
      return await publicSession(app);
    }
    if (path === 'reset-password') {
      try {
        await sendPasswordResetEmail(auth, data.email.trim());
      } catch (error) {
        if (error.code !== 'auth/user-not-found') throw error;
      }
      return { ok: true };
    }
    if (path === 'join') return await pair(app, data.code);
    if (path === 'logout') {
      await signOut(auth);
      session = undefined;
      return { ok: true };
    }
    if (!session || !auth.currentUser) throw problem(401, 'Войдите в свою полку.');
    const { family, role } = session;
    const categoryCollection = collection(db, 'families', family, 'categories');
    const readCategories = async () => categoryList((await getDocsFromServer(categoryCollection)).docs.map(row => ({ ...row.data(), id: row.id })));
    if (path === 'categories' && method === 'GET') return { categories: await readCategories() };
    if (path === 'videos' && method === 'GET') {
      const [snapshot, categories] = await Promise.all([getDocsFromServer(videoList(db, family)), readCategories()]);
      return { videos: videoData(snapshot), categories };
    }
    if (role !== 'parent') throw problem(403, 'Действие доступно только родителю.');
    if (path === 'tag-suggestions' && method === 'POST') {
      const endpoint = __POLKA_TAGS_ENDPOINT__;
      if (!endpoint) return { enabled: false };
      const response = await fetch(endpoint, {
        method: 'POST', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await auth.currentUser.getIdToken() },
        body: JSON.stringify({ title: data.title }), signal: AbortSignal.timeout(25000)
      });
      if (!response.ok) throw problem(response.status, 'AI временно недоступен.');
      return await response.json();
    }
    if (path === 'pair-code') return await makeInvite(auth, db, family);
    if (path === 'child-devices') return await revokeChildren(db, family);
    const categoryMatch = path.match(/^categories\/([^/]+)$/);
    if ((path === 'categories' && method === 'POST') || (categoryMatch && ['PATCH', 'DELETE'].includes(method))) {
      const list = await readCategories();
      const id = categoryMatch ? decodeURIComponent(categoryMatch[1]) : 'c_' + crypto.randomUUID();
      if (categoryMatch && !list.some(c => c.id === id)) throw problem(404, 'Тема не найдена.');
      if (id === 'Другое') throw problem(400, 'Тема «Другое» нужна для видео без темы.');
      const name = method === 'DELETE' ? list.find(c => c.id === id).name : validCategoryName(data.name);
      if (method !== 'DELETE' && list.some(c => c.id !== id && c.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) throw problem(409, 'Тема с таким названием уже есть.');
      const reference = doc(categoryCollection, id);
      await runTransaction(db, async tx => {
        const record = await tx.get(reference);
        if (categoryMatch && !record.exists() && !defaultCategories.includes(id)) throw problem(404, 'Тема не найдена.');
        if (categoryMatch && record.exists() && !record.data().active) throw problem(409, 'Тема уже удалена.');
        tx.set(reference, { name, active: method !== 'DELETE' });
      });
      return { categories: await readCategories() };
    }
    async function selectedCategories(tx, data) {
      const input = data.categories ?? (data.category ? [data.category] : []);
      if (!Array.isArray(input) || input.length > 9 || input.some(id => typeof id !== 'string' || !id || id.includes('/') || id.length > 60)) {
        throw problem(400, 'Можно выбрать не больше 9 тем для одного видео.');
      }
      const tags = [];
      for (const id of new Set(input)) {
        if (id === 'Другое') continue;
        const record = await tx.get(doc(categoryCollection, id));
        if (record.exists() ? record.data().active : defaultCategories.includes(id)) tags.push(id);
      }
      return tags;
    }
    if (path === 'videos' && method === 'POST') {
      const id = youtubeId(data.url);
      if (!id) throw problem(400, 'Вставьте ссылку на одно видео YouTube, Shorts или youtu.be.');
      const title = normalizeYoutubeTitle(data.title);
      if (!title) throw problem(400, 'Введите название видео.');
      const video = doc(db, 'families', family, 'videos', id);
      await runTransaction(db, async tx => {
        const categories = await selectedCategories(tx, data);
        const category = categories[0] ?? 'Другое';
        if ((await tx.get(video)).exists()) throw problem(409, 'Это видео уже есть на полке.');
        tx.set(video, { title, category, categories, note: typeof data.note === 'string' ? data.note.trim().slice(0, 240) : '', created: serverTimestamp() });
      });
      return { ok: true };
    }
    if (/^videos\/[\w-]{11}$/.test(path) && method === 'PATCH') {
      const title = typeof data.title === 'string' ? data.title.trim().slice(0, 160) : '';
      if (!title) throw problem(400, 'Введите название видео.');
      const video = doc(db, 'families', family, 'videos', path.slice(7));
      await runTransaction(db, async tx => {
        const categories = await selectedCategories(tx, data);
        const category = categories[0] ?? 'Другое';
        if (!(await tx.get(video)).exists()) throw problem(404, 'Видео не найдено.');
        tx.update(video, { title, category, categories, note: typeof data.note === 'string' ? data.note.trim().slice(0, 240) : '' });
      });
      return { ok: true };
    }
    if (path.startsWith('videos/') && method === 'DELETE') {
      await deleteDoc(doc(db, 'families', family, 'videos', path.slice(7)));
      return { ok: true };
    }
    throw problem(404, 'Действие не найдено.');
  } catch (error) {
    throw userError(error);
  }
}
