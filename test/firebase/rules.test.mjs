import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createMockUserToken } from '@firebase/util';
import { createWorker } from '../../cloudflare/worker.mjs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, increment, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch } from 'firebase/firestore';

test('only the parent can edit the shelf and a child needs a fresh invitation', async t => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-papina-polka',
    firestore: { host: '127.0.0.1', port: 8089, rules: await readFile('firestore.rules', 'utf8') }
  });
  t.after(async () => {
    await env.clearFirestore();
    await env.cleanup();
  });
  await env.clearFirestore();
  const signIn = (uid, provider) => env.authenticatedContext(uid, {
    firebase: { sign_in_provider: provider }
  }).firestore();
  const adult = signIn('parent', 'password');
  const outsider = signIn('outsider', 'password');
  const reader = signIn('child', 'anonymous');
  const otherReader = signIn('other-child', 'anonymous');
  const claim = 'f'.repeat(64);
  const firstCode = 'A'.repeat(24);
  const secondCode = 'B'.repeat(24);
  const thirdCode = 'C'.repeat(24);
  const familyData = { name: 'Папина полка', epoch: 1 };

  function setup(db, uid, key) {
    const batch = writeBatch(db);
    batch.set(doc(db, 'settings', 'owner'), { uid, claim: key });
    batch.set(doc(db, 'families', uid), familyData);
    return batch.commit();
  }

  await assertFails(setup(adult, 'parent', claim));
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'setupSecrets', claim), { enabled: true });
  });
  await assertFails(getDoc(doc(outsider, 'setupSecrets', claim)));
  await assertSucceeds(setup(adult, 'parent', claim));
  await assertFails(setup(outsider, 'outsider', claim));
  await assertFails(getDoc(doc(reader, 'families', 'parent')));

  function invite(code) {
    const batch = writeBatch(adult);
    batch.set(doc(adult, 'invites', code), {
      family: 'parent', epoch: 1, claimedBy: null, createdAt: serverTimestamp()
    });
    batch.set(doc(adult, 'families', 'parent', 'private', 'pairing'), { invite: code });
    return batch.commit();
  }

  function enroll(db, uid, code, family = 'parent') {
    const batch = writeBatch(db);
    batch.update(doc(db, 'invites', code), { claimedBy: uid });
    batch.set(doc(db, 'children', uid), { family, epoch: 1, invite: code });
    return batch.commit();
  }

  await assertSucceeds(invite(firstCode));
  await assertSucceeds(invite(secondCode));
  await assertFails(getDoc(doc(reader, 'invites', firstCode)));
  await assertFails(getDocs(collection(reader, 'invites')));
  await assertFails(setDoc(doc(reader, 'children', 'child'), { family: 'parent', epoch: 1, invite: secondCode }));
  await assertFails(enroll(reader, 'child', secondCode, 'outsider'));
  await assertSucceeds(enroll(reader, 'child', secondCode));
  await assertFails(enroll(otherReader, 'other-child', secondCode));
  await assertFails(getDoc(doc(reader, 'families', 'parent', 'private', 'pairing')));

  const videoRef = db => doc(db, 'families', 'parent', 'videos', 'M7lc1UVf-VE');
  const video = { title: 'Как устроен плеер', category: 'Наука', note: '', created: serverTimestamp() };
  await assertFails(setDoc(videoRef(reader), video));
  await assertSucceeds(setDoc(videoRef(adult), video));
  await assertFails(updateDoc(videoRef(adult), { created: Timestamp.fromMillis(0) }));
  await assertSucceeds(getDocs(collection(reader, 'families', 'parent', 'videos')));
  await assertFails(getDoc(videoRef(outsider)));
  await assertFails(getDoc(videoRef(otherReader)));
  await assertFails(updateDoc(videoRef(otherReader), { viewCount: increment(1) }));
  await assertFails(updateDoc(videoRef(reader), { viewCount: increment(2) }));
  await assertFails(updateDoc(videoRef(reader), { viewCount: increment(1), title: 'Другой заголовок' }));
  await Promise.all([
    assertSucceeds(updateDoc(videoRef(reader), { viewCount: increment(1) })),
    assertSucceeds(updateDoc(videoRef(adult), { viewCount: increment(1) }))
  ]);
  await assertFails(updateDoc(videoRef(adult), { viewCount: 0 }));
  t.assert.equal((await getDoc(videoRef(reader))).data().viewCount, 2);

  const channelId = 'UC' + 'a'.repeat(22);
  const noAvatarId = 'UC' + 'b'.repeat(22);
  const channel = db => doc(db, 'families', 'parent', 'channels', channelId);
  const uploads = 'UU' + 'a'.repeat(22);
  const channelData = { title: 'Детский канал', uploads };
  const watched = 'M7lc1UVf-VE';
  const hidden = 'aBcDeFgHiJ1';
  const fresh = 'aBcDeFgHiJ2';
  const state = (db, id) => doc(collection(channel(db), 'videos'), id);
  await assertFails(setDoc(channel(reader), channelData));
  await assertSucceeds(setDoc(channel(adult), channelData));
  await assertSucceeds(setDoc(doc(adult, 'families', 'parent', 'channels', noAvatarId), channelData));
  await assertFails(getDoc(channel(outsider)));
  await assertSucceeds(getDocs(collection(reader, 'families', 'parent', 'channels')));
  await assertFails(setDoc(state(reader, hidden), { blocked: true }, { merge: true }));
  await assertSucceeds(setDoc(state(adult, hidden), { blocked: true }, { merge: true }));
  await assertFails(setDoc(state(reader, hidden), { blocked: false }, { merge: true }));

  const project = 'demo-papina-polka';
  const documents = 'projects/' + project + '/databases/(default)/documents';
  const childToken = createMockUserToken({
    sub: 'child', iat: Math.floor(Date.now() / 1000), firebase: { sign_in_provider: 'anonymous' }
  }, project);
  const parentToken = createMockUserToken({
    sub: 'parent', iat: Math.floor(Date.now() / 1000), firebase: { sign_in_provider: 'password' }
  }, project);
  // The parent forwards the commit's update time so the Worker can identify the exact creation.
  const pushVideoPath = documents + '/families/parent/videos/aBcDeFgHiJ4';
  const parentHeaders = { Authorization: 'Bearer ' + parentToken, 'Content-Type': 'application/json' };
  const rest = 'http://127.0.0.1:8089/v1/';
  const inserted = await fetch(rest + documents + ':commit', {
    method: 'POST', headers: parentHeaders,
    body: JSON.stringify({ writes: [{
      update: { name: pushVideoPath, fields: {
        title: { stringValue: 'Push test video' }, category: { stringValue: 'Наука' }, note: { stringValue: '' }
      } },
      currentDocument: { exists: false },
      updateTransforms: [{ fieldPath: 'created', setToServerValue: 'REQUEST_TIME' }]
    }] })
  });
  const commit = await inserted.json();
  t.assert.equal(inserted.status, 200, JSON.stringify(commit));
  const saved = await fetch(rest + pushVideoPath, { headers: parentHeaders });
  const savedVideo = await saved.json();
  t.assert.equal(saved.status, 200, JSON.stringify(savedVideo));
  t.assert.equal(savedVideo.createTime, commit.writeResults[0].updateTime);

  const bearer = { Authorization: 'Bearer ' + childToken, 'Content-Type': 'application/json' };
  function countView() {
    return fetch('http://127.0.0.1:8089/v1/' + documents + ':commit', {
      method: 'POST', headers: bearer,
      body: JSON.stringify({ writes: [{ transform: {
        document: documents + '/families/parent/channels/' + channelId + '/videos/' + watched,
        fieldTransforms: [{ fieldPath: 'viewCount', increment: { integerValue: '1' } }]
      } }] })
    });
  }
  for (const result of await Promise.all([countView(), countView()])) {
    t.assert.equal(result.status, 200, await result.text());
  }
  await assertFails(updateDoc(state(reader, watched), { viewCount: increment(2) }));
  t.assert.deepEqual((await getDoc(state(reader, watched))).data(), { viewCount: 2 });

  const origin = 'https://shelf.example';
  const avatar = 'https://yt3.googleusercontent.com/example=s88';
  const worker = createWorker({ fetcher: (url, options) => {
    if (String(url).startsWith('https://firestore.googleapis.com/')) {
      return fetch(String(url).replace('https://firestore.googleapis.com', 'http://127.0.0.1:8089'), options);
    }
    if (url.pathname.endsWith('/channels')) {
      t.assert.deepEqual(new Set(url.searchParams.get('id').split(',')), new Set([channelId, noAvatarId]));
      return Response.json({ items: [
        { id: noAvatarId, snippet: {} },
        { id: channelId, snippet: { thumbnails: {
          medium: { url: 'http://yt3.ggpht.com/example=s240' }, default: { url: avatar }
        } } }
      ] });
    }
    t.assert.equal(url.searchParams.get('playlistId'), uploads);
    return Response.json({ items: [watched, hidden, fresh].map(videoId => ({
      contentDetails: { videoId }, snippet: { title: videoId }, status: { privacyStatus: 'public' }
    })) });
  } });
  const openChannel = (operation, body, token = childToken) => worker.fetch(new Request('https://worker.example/channels/' + operation, {
    method: 'POST', headers: { ...bearer, Authorization: 'Bearer ' + token, Origin: origin }, body: JSON.stringify(body)
  }), {
    ALLOWED_ORIGINS: origin, FIREBASE_PROJECT_ID: project, YOUTUBE_API_KEY: 'fixture',
    QUOTA: { idFromName: id => id, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) }
  });
  t.assert.equal((await openChannel('resolve', { url: '@test' })).status, 401);
  const avatarInput = { ids: [channelId, 'UC' + 'z'.repeat(22), noAvatarId] };
  for (const token of [childToken, parentToken]) {
    t.assert.deepEqual(await (await openChannel('avatars', avatarInput, token)).json(), { avatars: { [channelId]: avatar } });
  }
  t.assert.deepEqual(await (await openChannel('videos', { id: channelId })).json(), {
    videos: [{ id: watched, title: watched, viewCount: 2 }, { id: fresh, title: fresh, viewCount: 0 }],
    nextPageToken: ''
  });

  const otherCode = 'D'.repeat(24);
  await assertSucceeds(invite(otherCode));
  await assertSucceeds(enroll(otherReader, 'other-child', otherCode));
  const favorites = (db, uid) => collection(db, 'families', 'parent', 'favorites', uid, 'videos');
  const favorite = (db, uid, id = videoRef(db).id) => doc(favorites(db, uid), id);
  await assertSucceeds(setDoc(favorite(reader, 'child'), { saved: true }));
  await assertSucceeds(setDoc(favorite(reader, 'child'), { saved: true }));
  await assertSucceeds(getDocs(favorites(reader, 'child')));
  await assertFails(getDocs(favorites(adult, 'child')));
  await assertFails(getDoc(favorite(otherReader, 'child')));
  await assertFails(deleteDoc(favorite(adult, 'child')));
  await assertFails(setDoc(favorite(reader, 'other-child'), { saved: true }));
  await assertFails(setDoc(favorite(reader, 'child', 'missing0000'), { saved: true }));
  await assertFails(setDoc(favorite(reader, 'child'), { saved: false }));
  t.assert.equal((await getDocs(favorites(otherReader, 'other-child'))).size, 0);
  await assertSucceeds(setDoc(favorite(adult, 'parent'), { saved: true }));
  await assertSucceeds(deleteDoc(favorite(reader, 'child')));
  t.assert.equal((await getDocs(favorites(reader, 'child'))).size, 0);
  t.assert.equal((await getDocs(favorites(adult, 'parent'))).size, 1);

  const tagRef = db => doc(db, 'families', 'parent', 'categories', 'space');
  await assertFails(setDoc(tagRef(reader), { name: 'Космос', active: true }));
  await assertFails(setDoc(tagRef(outsider), { name: 'Космос', active: true }));
  await assertSucceeds(setDoc(tagRef(adult), { name: 'Космос', active: true }));
  await assertSucceeds(getDocs(collection(reader, 'families', 'parent', 'categories')));
  await assertSucceeds(updateDoc(videoRef(adult), { categories: ['space', 'Наука'], category: 'space' }));
  await assertFails(updateDoc(videoRef(reader), { categories: [], category: 'Другое' }));
  await assertFails(updateDoc(videoRef(adult), { categories: ['missing'], category: 'missing' }));
  await assertFails(updateDoc(videoRef(adult), { categories: ['space', 'space'], category: 'space' }));
  await assertFails(updateDoc(videoRef(adult), { categories: ['space'], category: 'Наука' }));
  await assertSucceeds(updateDoc(tagRef(adult), { name: 'Вселенная' }));
  await assertSucceeds(updateDoc(tagRef(adult), { active: false }));
  await assertSucceeds(getDoc(videoRef(reader)));
  await assertFails(updateDoc(videoRef(adult), { categories: ['space'], category: 'space' }));
  await assertSucceeds(updateDoc(videoRef(adult), { categories: ['Наука'], category: 'Наука' }));
  await assertSucceeds(updateDoc(videoRef(adult), { categories: [], category: 'Другое' }));
  await assertFails(setDoc(doc(adult, 'families', 'parent', 'categories', 'Другое'), { name: 'Прочее', active: false }));
  await assertFails(setDoc(doc(adult, 'families', 'parent', 'categories', 'bad'), { name: '', active: true }));
  const manyTags = Array.from({ length: 9 }, (_, index) => 'tag' + index);
  for (const id of manyTags) {
    await assertSucceeds(setDoc(doc(adult, 'families', 'parent', 'categories', id), { name: id, active: true }));
  }
  await assertSucceeds(updateDoc(videoRef(adult), { categories: manyTags, category: manyTags[0] }));
  await assertFails(updateDoc(videoRef(adult), { categories: [...manyTags, 'Наука'], category: manyTags[0] }));
  await assertSucceeds(invite(thirdCode));
  await env.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), 'invites', thirdCode), {
      createdAt: Timestamp.fromMillis(Date.now() - 11 * 60 * 1000)
    });
  });
  await assertFails(enroll(otherReader, 'other-child', thirdCode));
  await assertSucceeds(updateDoc(doc(adult, 'families', 'parent'), { epoch: 2 }));
  await assertFails(getDoc(videoRef(reader)));
  t.assert.equal((await openChannel('videos', { id: channelId })).status, 403);
  t.assert.equal((await openChannel('avatars', { ids: [channelId] })).status, 403);
  await assertFails(updateDoc(videoRef(reader), { viewCount: increment(1) }));
  await assertFails(getDocs(favorites(reader, 'child')));
  await assertFails(setDoc(favorite(reader, 'child'), { saved: true }));
  await assertSucceeds(getDoc(videoRef(adult)));
});
