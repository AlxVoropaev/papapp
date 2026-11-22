import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker, askOpenRouter, PairingCodes, SuggestionQuota, openRouterEndpoint, providerConfig, askProvider } from '../cloudflare/worker.mjs';

const origin = 'https://papina-polka-bec464.web.app';
const project = 'papina-polka-bec464';
function token(extra = {}) {
  return 'header.' + Buffer.from(JSON.stringify({ aud: project, iss: 'https://securetoken.google.com/' + project,
    sub: 'parent', exp: Date.now() / 1000 + 3600, firebase: { sign_in_provider: 'password' }, ...extra })).toString('base64url') + '.signature';
}

test('short invitations require a verified parent and rate-limit guesses across clients', async () => {
  const invite = 'A'.repeat(24);
  let saved;
  const store = {
    get: async () => structuredClone(saved),
    put: async (_key, value) => { saved = structuredClone(value); }
  };
  const broker = new PairingCodes({ storage: { transaction: fn => fn(store) } });
  const env = { ALLOWED_ORIGINS: origin, FIREBASE_PROJECT_ID: project,
    PAIRING: { idFromName: name => name, get: () => ({ fetch: (url, init) => broker.fetch(new Request(url, init)) }) } };
  const worker = createWorker({ fetcher: async (url, options) => {
    assert.ok(url.endsWith('/families/parent/private/pairing'));
    return options.headers.Authorization.endsWith('.signature')
      ? Response.json({ fields: { invite: { stringValue: invite } } }) : new Response(null, { status: 403 });
  } });
  const call = (action, body, jwt = '', address = '192.0.2.1') => worker.fetch(new Request('https://tags.example/pairing/' + action, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Origin: origin, Authorization: 'Bearer ' + jwt, 'CF-Connecting-IP': address }
  }), env);

  assert.equal((await call('issue', { invite }, token().replace('.signature', '.forged'))).status, 403);
  assert.equal((await call('issue', { invite: 'B'.repeat(24) }, token())).status, 409);
  const created = await call('issue', { invite }, token());
  assert.equal(created.status, 200);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const { code } = await created.json();
  assert.match(code, /^[0-9]{6}$/);
  assert.deepEqual(await (await call('issue', { invite }, token())).json(), { code });
  assert.deepEqual(await (await call('resolve', { code })).json(), { invite });
  const wrong = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await call('resolve', { code: wrong })).status, 400);
  assert.equal((await call('resolve', { code: wrong })).status, 429);
  for (let i = 0; i < 24; i++) assert.equal((await call('resolve', { code: wrong }, '', '192.0.2.' + (i + 2))).status, 400);
  assert.equal((await call('resolve', { code }, '', '192.0.2.254')).status, 429);
  saved.codes[0].expires = 0;
  assert.equal((await call('resolve', { code }, '', '192.0.2.254')).status, 400);
});
function setup({ denied = false, quota = true, tags = ['Наука'], providerError = false } = {}) {
  const seen = [];
  let quotaCalls = 0;
  const cache = new Map();
  const worker = createWorker({ cache: {
    async match(request) { return cache.get(request.url)?.clone(); },
    async put(request, response) { cache.set(request.url, response.clone()); }
  }, fetcher: async (url, options) => {
    const target = String(url);
    seen.push({ url: target, options });
    if (target.startsWith('https://firestore.googleapis.com/')) {
      if (denied) return Response.json({}, { status: 403 });
      if (target.includes('/categories?')) return Response.json({ documents: [{
        name: 'projects/p/databases/(default)/documents/families/parent/categories/custom',
        fields: { name: { stringValue: 'Космос' }, active: { booleanValue: true } }
      }] });
      return Response.json({ fields: { name: { stringValue: 'Family' } } });
    }
    if (providerError) throw new Error('secret-value must not leak');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ tags }) } }] });
  } });
  const env = { ALLOWED_ORIGINS: origin, FIREBASE_PROJECT_ID: project, OPENROUTER_API_KEY: 'secret-value',
    QUOTA: { idFromName: id => id, get: () => ({ async fetch() { quotaCalls++; return new Response(null, { status: quota ? 204 : 429 }); } }) } };
  const pending = [];
  const request = (body = { title: 'Что такое свет?' }, headers = {}) => new Request('https://tags.example/suggest', {
    method: 'POST', headers: { Origin: origin, Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
  });
  return { worker, env, seen, request, pending, quotaCalls: () => quotaCalls,
    run: (req = request()) => worker.fetch(req, env, { waitUntil(promise) { pending.push(promise); } }) };
}

test('worker verifies Firebase access, uses only the free model, and caches suggestions', async () => {
  const fixture = setup();
  const response = await fixture.run();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true, tags: ['Наука'], source: 'llm' });
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  const provider = fixture.seen.find(item => item.url.includes('openrouter.ai'));
  const payload = JSON.parse(provider.options.body);
  assert.equal(payload.model, 'openrouter/free');
  assert.equal(payload.provider.require_parameters, true);
  assert.equal(payload.max_tokens, 256);
  assert.equal(provider.options.headers.Authorization, 'Bearer secret-value');
  assert.equal(JSON.stringify(payload).includes('signature'), false);
  assert.ok(JSON.stringify(payload).includes('Космос'));
  assert.equal(JSON.stringify(payload).includes('Другое'), false);
  await Promise.all(fixture.pending);
  assert.equal((await fixture.run()).status, 200);
  assert.equal(fixture.seen.filter(item => item.url.includes('openrouter.ai')).length, 1);
  assert.equal(fixture.quotaCalls(), 1);
});

test('worker fetches and caches only bounded YouTube titles for validated video IDs', async () => {
  const entries = new Map();
  const pending = [];
  const seen = [];
  let upstreamError = false;
  const worker = createWorker({
    cache: {
      async match(request) { return entries.get(request.url)?.clone(); },
      async put(request, response) { entries.set(request.url, response.clone()); }
    },
    fetcher: async (url, options) => {
      seen.push(url);
      assert.equal(options.redirect, 'manual');
      if (upstreamError || (url.searchParams.get('url').endsWith('M7lc1UVf-VE') && url.hostname === 'www.youtube.com')) {
        return new Response('upstream error details', { status: 503 });
      }
      return Response.json({ title: '  ' + 'Я'.repeat(165), html: 'ignored' });
    }
  });
  const env = { ALLOWED_ORIGINS: origin + ',https://polka.firebaseapp.com' };
  const run = (query, requestOrigin = origin, method = 'GET') => worker.fetch(
    new Request('https://tags.example/video-title?' + query, { method, headers: { Origin: requestOrigin } }),
    env, { waitUntil(promise) { pending.push(promise); } }
  );
  const query = 'id=jt6sgcW5rL4';
  assert.equal((await run(query, 'https://other.example')).status, 403);
  assert.equal((await run(query, origin, 'POST')).status, 405);
  assert.equal((await run('id=https%3A%2F%2Fother.example')).status, 400);
  assert.equal(seen.length, 0);

  const response = await run(query);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.deepEqual(await response.json(), { title: 'Я'.repeat(160) });
  assert.equal(seen[0].origin + seen[0].pathname, 'https://www.youtube.com/oembed');
  assert.equal(seen[0].searchParams.get('url'), 'https://www.youtube.com/watch?v=jt6sgcW5rL4');
  await Promise.all(pending);

  const cached = await run(query + '&si=ignored', 'https://polka.firebaseapp.com');
  assert.equal(cached.headers.get('access-control-allow-origin'), 'https://polka.firebaseapp.com');
  assert.deepEqual(await cached.json(), { title: 'Я'.repeat(160) });
  assert.equal(seen.length, 1);

  const fallback = await run('id=M7lc1UVf-VE');
  assert.equal(fallback.status, 200);
  assert.deepEqual(await fallback.json(), { title: 'Я'.repeat(160) });
  assert.deepEqual(seen.slice(1).map(source => source.hostname), ['www.youtube.com', 'www.youtube-nocookie.com']);

  upstreamError = true;
  const failed = await run('id=jNQXAC9IVRw');
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'Не удалось получить название с YouTube.', code: 'http-503,http-503' });
  assert.equal(seen.at(-1).hostname, 'www.youtube-nocookie.com');
  assert.equal(pending.length, 2);
});

test('untrusted origins, child/expired tokens and forged parent tokens cannot reach the model', async () => {
  for (const header of [
    { Origin: 'https://attacker.example' }, { Authorization: '' },
    { Authorization: 'Bearer ' + token({ exp: 1 }) },
    { Authorization: 'Bearer ' + token({ firebase: { sign_in_provider: 'anonymous' } }) },
    { Authorization: 'Bearer ' + token({ aud: 'wrong-project' }) }
  ]) {
    const fixture = setup();
    assert.ok((await fixture.run(fixture.request(undefined, header))).status >= 400);
    assert.equal(fixture.seen.length, 0);
  }
  const forged = setup({ denied: true });
  assert.equal((await forged.run()).status, 403);
  assert.equal(forged.seen.length, 1);
  assert.equal(forged.quotaCalls(), 0);
});

test('quota and malformed provider output fail safely without leaking secrets', async () => {
  const limited = setup({ quota: false });
  assert.equal((await limited.run()).status, 429);
  assert.equal(limited.seen.some(item => item.url.includes('openrouter.ai')), false);
  const unknown = setup({ tags: ['not-a-category'] });
  assert.equal((await unknown.run()).status, 502);
  const failed = setup({ providerError: true });
  const response = await failed.run();
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('secret-value'), false);
  const invalid = setup();
  assert.equal((await invalid.run(invalid.request({ title: 'x'.repeat(161) }))).status, 400);
  assert.equal(invalid.seen.length, 0);
});

test('quota persists through new instances and rejects the eleventh request in a minute', async () => {
  const values = new Map();
  const state = { storage: { transaction: fn => fn({ get: async key => values.get(key), put: async (key, value) => values.set(key, value) }) } };
  for (let i = 0; i < 10; i++) assert.equal((await new SuggestionQuota(state).fetch()).status, 204);
  assert.equal((await new SuggestionQuota(state).fetch()).status, 429);
});


test('Gateway routing is restricted to Cloudflare and keeps the free model', async () => {
  const env = { OPENROUTER_GATEWAY_ACCOUNT: 'a'.repeat(32), OPENROUTER_GATEWAY_ID: 'papina-polka-tags' };
  const endpoint = openRouterEndpoint(env);
  assert.equal(endpoint, 'https://gateway.ai.cloudflare.com/v1/' + 'a'.repeat(32) + '/papina-polka-tags/openrouter/chat/completions');
  assert.throws(() => openRouterEndpoint({ ...env, OPENROUTER_GATEWAY_ID: '../other' }));
  assert.throws(() => openRouterEndpoint({ ...env, OPENROUTER_GATEWAY_ACCOUNT: 'attacker.example' }));
  const tags = await askOpenRouter('Test', [{id:'science',name:'Наука'}], 'secret', async (url, options) => {
    assert.equal(url, endpoint);
    assert.equal(JSON.parse(options.body).model, 'openrouter/free');
    return Response.json({choices:[{message:{content:'{"tags":["science"]}'}}]});
  }, endpoint);
  assert.deepEqual(tags, ['science']);
});


test('paid Polza is explicit, uses its own key and only the configured cheap model', async () => {
  const free = providerConfig({OPENROUTER_API_KEY:'free-key',POLZA_API_KEY:'paid-key'});
  assert.equal(free.id,'openrouter');
  assert.equal(free.key,'free-key');
  const paid = providerConfig({LLM_PROVIDER:'polza',OPENROUTER_API_KEY:'free-key',POLZA_API_KEY:'paid-key'});
  assert.equal(paid.endpoint,'https://polza.ai/api/v1/chat/completions');
  assert.equal(paid.model,'google/gemini-2.5-flash-lite');
  assert.equal(paid.key,'paid-key');
  assert.throws(()=>providerConfig({LLM_PROVIDER:'unknown'}));
  const result=await askProvider('Космос',[{id:'science',name:'Наука'}],paid.key,async(url,options)=>{
    assert.equal(url,paid.endpoint);
    const body=JSON.parse(options.body);
    assert.equal(body.model,paid.model);
    assert.equal(body.provider,undefined);
    assert.equal(body.max_tokens,256);
    return Response.json({choices:[{message:{content:'{"tags":["science"]}'}}],usage:{cost_rub:0.012}});
  },paid.endpoint,paid.id);
  assert.deepEqual(result,{tags:['science'],costRub:0.012});
});
