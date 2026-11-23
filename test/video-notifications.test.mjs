import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { createWorker, VideoPush } from '../cloudflare/worker.mjs';

const project = 'test-shelf';
const origin = 'https://family.example';
const id = 'M7lc1UVf-VE';
const created = new Date().toISOString();
const fakeToken = (sub, provider) => 'header.' + Buffer.from(JSON.stringify({
  aud: project, iss: 'https://securetoken.google.com/' + project, sub, exp: Date.now() / 1000 + 3600,
  firebase: { sign_in_provider: provider }
})).toString('base64url') + '.signature';

test('push routes trust the Firestore-verified family, epoch and video content', async () => {
  const child = fakeToken('child', 'anonymous');
  const parent = fakeToken('parent', 'password');
  let childRevoked = false;
  const calls = [];
  const env = {
    FIREBASE_PROJECT_ID: project, ALLOWED_ORIGINS: origin, FCM_SERVICE_ACCOUNT: 'configured',
    VIDEO_PUSH: {
      idFromName: name => name,
      get: family => ({
        fetch: (_, { body }) => {
          calls.push({ family, operation: JSON.parse(body) });
          return Response.json({ ok: true });
        }
      })
    }
  };
  const worker = createWorker({ fetcher: async (url, { headers, redirect }) => {
    assert.equal(redirect, 'manual');
    const token = headers.Authorization?.split(' ')[1];
    const path = url.split('/documents/')[1];
    if (path === 'children/child' && token === child) {
      return Response.json({ fields: { family: { stringValue: 'parent' } } });
    }
    if (path === 'families/parent' && (token === parent || token === child && !childRevoked)) {
      return Response.json({ fields: { epoch: { integerValue: '2' } } });
    }
    if (path === 'families/parent/videos/' + id && token === parent) {
      return Response.json({ createTime: created, fields: { title: { stringValue: 'A real shelf title' } } });
    }
    return Response.json({}, { status: 403 });
  } });
  const post = (route, token, body) => worker.fetch(new Request('https://worker.example/push/' + route, {
    method: 'POST',
    headers: { Origin: origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), env, {});

  assert.equal((await post('register', child, { token: 'test-device-registration-token', uid: 'other', family: 'other' })).status, 200);
  assert.deepEqual(calls[0], { family: 'parent', operation: {
    action: 'register', uid: 'child', token: 'test-device-registration-token', epoch: 2
  } });
  assert.equal((await post('video', child, { id, created })).status, 401);
  assert.equal((await post('video', parent + 'forged', { id, created })).status, 403);
  assert.equal((await post('video', parent, { id, created: new Date(Date.now() - 1000).toISOString() })).status, 200);
  assert.equal(calls.length, 1);

  assert.equal((await post('video', parent, { id, created, title: 'Untrusted title' })).status, 200);
  assert.deepEqual(calls[1], { family: 'parent', operation: {
    action: 'send', family: 'parent', created: Date.parse(created), title: 'A real shelf title',
    event: id + ':' + created, epoch: 2
  } });
  childRevoked = true;
  assert.equal((await post('register', child, { token: null })).status, 403);
  assert.equal(calls.length, 2);
});

test('delivery retries only failed targets and skips devices after revocation', async t => {
  const kv = new Map();
  let alarm = null;
  const storage = {
    get: async key => structuredClone(kv.get(key)),
    async put(key, value) {
      for (const [storageKey, entry] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) {
        kv.set(storageKey, structuredClone(entry));
      }
    },
    getAlarm: async () => alarm,
    setAlarm: async value => { alarm = value; }
  };
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const object = new VideoPush({ storage, blockConcurrencyWhile: action => action() }, {
    FIREBASE_PROJECT_ID: project, FCM_SERVICE_ACCOUNT: JSON.stringify({
      project_id: project, client_email: 'test@example.invalid', private_key: key
    })
  });
  const attempts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.match(options.body.get('assertion'), /^[\w-]+\.[\w-]+\.[\w-]+$/);
      return Response.json({ access_token: 'test-authorization-token', expires_in: 3600 });
    }
    assert.equal(url, 'https://fcm.googleapis.com/v1/projects/' + project + '/messages:send');
    const { message } = JSON.parse(options.body);
    assert.equal(message.android.priority, 'HIGH');
    assert.equal(message.android.restricted_package_name, 'polka.mobile');
    attempts.push(message.data.recipient);
    if (attempts.join(',') === 'first,second') return Response.json({}, { status: 503 });
    return Response.json({ name: 'test-message' });
  });
  const operation = body => object.fetch(new Request('https://internal.example', {
    method: 'POST', body: JSON.stringify(body)
  }));
  await operation({ action: 'register', epoch: 2, uid: 'first', token: 'first-test-token' });
  await operation({ action: 'register', epoch: 2, uid: 'second', token: 'second-test-token' });
  const event = { action: 'send', epoch: 2, created: Date.now(), family: 'parent', event: id, title: 'New video' };
  assert.equal((await operation(event)).status, 503);
  assert.equal((await operation(event)).status, 200);
  assert.equal((await operation(event)).status, 200);
  assert.deepEqual(attempts, ['first', 'second', 'second']);
  assert.ok(alarm > Date.now());
  assert.equal((await operation({ ...event, epoch: 3 })).status, 200);
  assert.equal((await operation({ ...event, event: 'delayed-event' })).status, 200);
  assert.equal(kv.get('devices').epoch, 3);
  assert.equal(attempts.length, 3);
});
