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

export class YoutubePlaylistError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function playlistId(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  try {
    const link = input.trim();
    const url = new URL(/^https?:\/\//i.test(link) ? link : 'https://' + link);
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)
        || url.username || url.password || url.port) return null;
    const id = url.searchParams.get('list');
    return id && /^[\w-]{2,150}$/.test(id) ? id : null;
  } catch { return null; }
}

async function youtubeData(resource, params, apiKey, fetcher, messages) {
  if (!apiKey) throw new YoutubePlaylistError(503, messages.unconfigured);
  const url = new URL('https://www.googleapis.com/youtube/v3/' + resource);
  url.search = new URLSearchParams(params);
  try {
    const response = await fetcher(url, {
      headers: { 'X-Goog-Api-Key': apiKey, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(5000)
    });
    const page = await response.json();
    if (!response.ok) {
      const reason = page.error?.errors?.[0]?.reason;
      if (response.status === 404 || ['playlistItemsNotAccessible', 'playlistOperationUnsupported'].includes(reason)) {
        throw new YoutubePlaylistError(404, messages.missing);
      }
      if (reason === 'invalidPageToken') throw new YoutubePlaylistError(400, messages.retry);
      if (reason === 'quotaExceeded' || response.status === 429) {
        throw new YoutubePlaylistError(429, 'Достигнут лимит запросов к YouTube. Попробуйте позже.');
      }
      throw new YoutubePlaylistError(502, messages.unavailable);
    }
    if (!Array.isArray(page?.items) || page.items.length > 50) throw new YoutubePlaylistError(502, messages.unavailable);
    return page;
  } catch (error) {
    if (error instanceof YoutubePlaylistError) throw error;
    throw new YoutubePlaylistError(502, messages.unavailable);
  }
}

const playlistMessages = {
  unconfigured: 'Загрузка плейлистов пока не настроена.',
  missing: 'Плейлист недоступен. Проверьте ссылку и доступ к нему.',
  retry: 'Откройте плейлист заново.',
  unavailable: 'Не удалось загрузить плейлист с YouTube. Попробуйте ещё раз.'
};
export async function youtubePlaylist(input, apiKey, fetcher = fetch) {
  const id = playlistId(input?.url);
  if (!id) throw new YoutubePlaylistError(400, 'Вставьте ссылку на плейлист YouTube.');
  return playlistPage(id, input?.pageToken ?? '', apiKey, fetcher, playlistMessages);
}

async function playlistPage(id, pageToken, apiKey, fetcher, messages) {
  if (typeof pageToken !== 'string' || pageToken.length > 512) throw new YoutubePlaylistError(400, messages.retry);
  const params = {
    part: 'snippet,contentDetails,status',
    fields: 'nextPageToken,items(snippet(title),contentDetails(videoId),status(privacyStatus))',
    playlistId: id,
    maxResults: '50'
  };
  if (pageToken) params.pageToken = pageToken;
  const page = await youtubeData('playlistItems', params, apiKey, fetcher, messages);
  const videos = [];
  for (const item of page.items) {
    const id = item?.contentDetails?.videoId;
    const rawTitle = item?.snippet?.title;
    const privacy = item?.status?.privacyStatus;
    if (!validId(id) || privacy === 'private'
        || typeof rawTitle !== 'string' || /^(?:deleted|private) video$/i.test(rawTitle.trim())) continue;
    const title = normalizeYoutubeTitle(rawTitle) || rawTitle.trim().slice(0, 160);
    if (title) videos.push({ id, title });
  }
  const nextPageToken = page.nextPageToken;
  return { videos, nextPageToken: typeof nextPageToken === 'string' && nextPageToken !== pageToken
    && nextPageToken.length <= 512 ? nextPageToken : '' };
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
