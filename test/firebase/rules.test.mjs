import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch } from 'firebase/firestore';

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
  await assertSucceeds(getDoc(videoRef(adult)));
});
