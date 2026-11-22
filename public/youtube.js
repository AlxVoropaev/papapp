const titleError = 'Не удалось получить название с YouTube. Введите его вручную или повторите попытку.';
const validId = id => typeof id === 'string' && /^[\w-]{11}$/.test(id);

export function youtubeId(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  try {
    const url = new URL(input.trim().match(/^https?:\/\//i) ? input.trim() : `https://${input.trim()}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    let id;
    if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)\/?$/)?.[1];
    }
    return validId(id) ? id : null;
  } catch { return null; }
}

export function youtubeOEmbedUrl(id) {
  if (!validId(id)) return null;
  const url = new URL('https://www.youtube.com/oembed');
  url.searchParams.set('url', 'https://www.youtube.com/watch?v=' + id);
  url.searchParams.set('format', 'json');
  return url;
}

export function youtubePrivacyOEmbedUrl(url) {
  const privacyUrl = new URL(url);
  privacyUrl.hostname = 'www.youtube-nocookie.com';
  return privacyUrl;
}

export function normalizeYoutubeTitle(value) {
  if (typeof value !== 'string') return '';
  const withoutTags = value.replace(/(^|[\s([{«“|,;:·–—])#([\p{L}\p{M}\p{N}_]+(?:-[\p{L}\p{M}\p{N}_]+)*)/gu,
    (match, prefix, tag) => /^\p{N}+$/u.test(tag) ? match : prefix);
  if (withoutTags === value) return value.trim().slice(0, 160);
  return withoutTags
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}|«\s*»|“\s*”/g, '')
    .replace(/([|,;:·])(?:\s*\1)+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s|,;:·–—-]+|[\s|,;:·–—-]+$/g, '')
    .slice(0, 160);
}

async function fetchTitle(url, timeoutMs, { signal, fetcher }) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error'
    });
    if (!response.ok) return '';
    return normalizeYoutubeTitle((await response.json())?.title);
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function youtubeTitle(input, { signal, fetcher = fetch, metadataEndpoint } = {}) {
  const id = youtubeId(input);
  if (!id) throw new Error('Вставьте ссылку на одно видео YouTube, Shorts или youtu.be.');
  const upstream = youtubeOEmbedUrl(id);
  if (metadataEndpoint) {
    const directTitle = await fetchTitle(youtubePrivacyOEmbedUrl(upstream), 3000, { signal, fetcher });
    signal?.throwIfAborted();
    if (directTitle) return { id, title: directTitle };
    const url = new URL(metadataEndpoint);
    url.searchParams.set('id', id);
    const title = await fetchTitle(url, 5500, { signal, fetcher });
    signal?.throwIfAborted();
    if (title) return { id, title };
  }
  const title = await fetchTitle(upstream, 7000, { signal, fetcher });
  signal?.throwIfAborted();
  if (!title) throw new Error(titleError);
  return { id, title };
}
