const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DEVICES = 32;
const encoder = new TextEncoder();

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function googleAccessToken(secret, firebaseProject) {
  const credentials = JSON.parse(secret);
  if (credentials.project_id !== firebaseProject || typeof credentials.client_email !== 'string') {
    throw new Error('Invalid FCM service account');
  }
  const der = atob(credentials.private_key.replace(/-----[^-]+-----|\s/g, ''));
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(der, char => char.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const endpoint = 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(Date.now() / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = base64url(encoder.encode(JSON.stringify({
    iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: endpoint, iat, exp: iat + 3600
  })));
  const assertion = header + '.' + claims;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(assertion)));
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: assertion + '.' + base64url(signature) })
  });
  if (!response.ok) throw new Error('FCM authorization failed');
  const data = await response.json();
  if (!data.access_token) throw new Error('FCM access token missing');
  return { bearer: data.access_token, expires: Date.now() + Number(data.expires_in) * 1000 };
}

async function deliver(project, bearer, token, data, ttlSeconds) {
  try {
    const result = await fetch('https://fcm.googleapis.com/v1/projects/' + project + '/messages:send', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: {
        token, data, android: { priority: 'HIGH', ttl: ttlSeconds + 's', restricted_package_name: 'polka.mobile' }
      } })
    });
    if (result.ok) return 'sent';
    const failure = await result.json();
    const code = failure.error?.details?.find(detail =>
      detail['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode;
    if (['UNREGISTERED', 'SENDER_ID_MISMATCH', 'INVALID_ARGUMENT'].includes(code)) return 'invalid-token';
  } catch {
    // The originating client can retry without sending again to successful recipients.
  }
  return 'retry';
}

export class VideoPush {
  constructor(context, env) {
    this.context = context;
    this.env = env;
    this.access = null;
  }

  async fetch(request) {
    const input = await request.json();
    // Serialize registration and delivery so simultaneous retries cannot send the same event twice.
    return this.context.blockConcurrencyWhile(async () => {
      try {
        return await this.handle(input);
      } catch {
        return Response.json({ error: 'Не удалось отправить уведомление.' }, { status: 503 });
      }
    });
  }

  async handle(input) {
    const storage = this.context.storage;
    const stored = await storage.get('devices');
    if (stored && stored.epoch > input.epoch) return Response.json({ ok: true });
    const devices = stored?.epoch === input.epoch ? stored : { epoch: input.epoch, entries: new Map() };
    if (input.action === 'register') {
      if (input.token === null) {
        devices.entries.delete(input.uid);
      } else {
        const previous = devices.entries.get(input.uid);
        if (!previous && devices.entries.size >= MAX_DEVICES) {
          return Response.json({ error: 'Достигнут лимит детских устройств.' }, { status: 429 });
        }
        devices.entries.set(input.uid, { token: input.token, since: previous?.since ?? Date.now() });
      }
      await storage.put('devices', devices);
      return Response.json({ ok: true });
    }

    const expires = input.created + TTL_MS;
    const ttlSeconds = Math.floor((expires - Date.now()) / 1000);
    if (ttlSeconds <= 0) return Response.json({ ok: true });
    if (stored?.epoch !== devices.epoch) await storage.put('devices', devices);

    const eventKey = 'event:' + input.event;
    const sent = new Set((await storage.get(eventKey))?.sent);
    const targets = [...devices.entries]
      .filter(([uid, record]) => record.since <= input.created && !sent.has(uid));
    if (!targets.length) return Response.json({ ok: true });

    if (!this.access || this.access.expires < Date.now() + 60_000) {
      this.access = await googleAccessToken(this.env.FCM_SERVICE_ACCOUNT, this.env.FIREBASE_PROJECT_ID);
    }
    const results = await Promise.all(targets.map(([uid, record]) => deliver(this.env.FIREBASE_PROJECT_ID,
      this.access.bearer, record.token, {
        type: 'newShelfVideo', family: input.family, recipient: uid, event: input.event, title: input.title
      }, ttlSeconds)));
    let retry = false;
    for (const [index, outcome] of results.entries()) {
      const [uid] = targets[index];
      if (outcome === 'sent') sent.add(uid);
      else if (outcome === 'invalid-token') devices.entries.delete(uid);
      else retry = true;
    }
    await storage.put({ devices, [eventKey]: { sent: [...sent], expires } });
    if (await storage.getAlarm() === null) await storage.setAlarm(expires);
    return Response.json(retry ? { error: 'Доставка пока недоступна.' } : { ok: true },
      { status: retry ? 503 : 200 });
  }

  async alarm() {
    const storage = this.context.storage;
    const events = await storage.list({ prefix: 'event:' });
    const now = Date.now();
    const expired = [];
    let next = Infinity;
    for (const [key, event] of events) {
      if (event.expires <= now) expired.push(key);
      else next = Math.min(next, event.expires);
    }
    for (let i = 0; i < expired.length; i += 128) await storage.delete(expired.slice(i, i + 128));
    if (Number.isFinite(next)) await storage.setAlarm(next);
  }
}
