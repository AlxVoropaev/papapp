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

export const channelIdPattern = /^UC[\w-]{22}$/;
const channelAvatarBatchSize = 20;

export function channelAvatarIds(input) {
  const ids = input?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > channelAvatarBatchSize ||
      !ids.every(id => typeof id === 'string' && channelIdPattern.test(id))) {
    throw new YoutubePlaylistError(400, 'Проверьте список каналов.');
  }
  return [...new Set(ids)];
}
export const uploadsIdPattern = /^[\w-]{2,150}$/;

function channelLookup(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  const value = input.trim();
  const handle = /^@[^\s/?#@]+$/u;
  if (handle.test(value)) return ['forHandle', value];
  if (channelIdPattern.test(value)) return ['id', value];
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)
        || url.username || url.password || url.port) return null;
    const parts = url.pathname.replace(/\/$/, '').slice(1).split('/').map(decodeURIComponent);
    if (parts.length > 1 && ['featured', 'videos', 'shorts', 'streams', 'playlists', 'community'].includes(parts.at(-1))) {
      parts.pop();
    }
    if (parts.length === 1 && handle.test(parts[0])) return ['forHandle', parts[0]];
    if (parts.length === 2 && parts[0] === 'channel' && channelIdPattern.test(parts[1])) return ['id', parts[1]];
    if (parts.length === 2 && parts[0] === 'user' && /^[\w-]+$/.test(parts[1])) return ['forUsername', parts[1]];
  } catch { /* The caller reports an invalid channel link. */ }
  return null;
}

async function youtubeData(resource, params, apiKey, fetcher, messages) {
  if (!apiKey) throw new YoutubePlaylistError(503, messages.unconfigured);
  const url = new URL('https://www.googleapis.com/youtube/v3/' + resource);
  url.search = new URLSearchParams(params);
  let status;
  try {
    const response = await fetcher(url, {
      headers: { 'X-Goog-Api-Key': apiKey, Accept: 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(5000)
    });
    status = response.status;
    if (status >= 300 && status < 400) {
      await response.body?.cancel();
      throw youtubeUpstreamError(messages, status, 'unexpected_redirect');
    }
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
      const detail = typeof reason === 'string' && /^[A-Za-z][A-Za-z_]{0,39}$/.test(reason)
        ? reason : 'upstream_error';
      throw youtubeUpstreamError(messages, status, detail);
    }
    if (!Array.isArray(page?.items) || page.items.length > 50) {
      throw youtubeUpstreamError(messages, status, 'invalid_items');
    }
    return page;
  } catch (error) {
    if (error instanceof YoutubePlaylistError) throw error;
    const detail = error?.name === 'TimeoutError' ? 'timeout' : status ? 'invalid_response' : 'connection_failed';
    throw youtubeUpstreamError(messages, status, detail);
  }
}

function youtubeUpstreamError(messages, status, detail) {
  const error = new YoutubePlaylistError(502, messages.unavailable);
  error.upstream = { status, detail };
  return error;
}

const playlistMessages = {
  unconfigured: 'Загрузка плейлистов пока не настроена.',
  missing: 'Плейлист недоступен. Проверьте ссылку и доступ к нему.',
  retry: 'Откройте плейлист заново.',
  unavailable: 'Не удалось загрузить плейлист с YouTube. Попробуйте ещё раз.'
};
const channelMessages = {
  unconfigured: 'Загрузка каналов пока не настроена.',
  missing: 'Канал недоступен. Проверьте ссылку.',
  retry: 'Откройте канал заново.',
  unavailable: 'Не удалось загрузить канал с YouTube. Попробуйте ещё раз.'
};

export async function youtubeChannel(input, apiKey, fetcher = fetch) {
  const lookup = channelLookup(input?.url);
  if (!lookup) throw new YoutubePlaylistError(400, 'Вставьте ссылку на канал YouTube или его @имя.');
  const page = await youtubeData('channels', {
    part: 'snippet,contentDetails',
    fields: 'items(id,snippet(title),contentDetails(relatedPlaylists(uploads)))',
    [lookup[0]]: lookup[1]
  }, apiKey, fetcher, channelMessages);
  const row = page.items[0];
  const id = row?.id;
  const title = typeof row?.snippet?.title === 'string' ? row.snippet.title.trim().slice(0, 160) : '';
  const uploads = row?.contentDetails?.relatedPlaylists?.uploads;
  if (typeof id !== 'string' || !channelIdPattern.test(id) || !title
      || typeof uploads !== 'string' || !uploadsIdPattern.test(uploads)) {
    throw new YoutubePlaylistError(404, channelMessages.missing);
  }
  return { id, title, uploads };
}

export async function youtubeChannelAvatars(ids, apiKey, fetcher = fetch) {
  const avatars = {};
  if (!ids.length) return { avatars };
  const page = await youtubeData('channels', {
    part: 'snippet',
    fields: 'items(id,snippet(thumbnails(default(url),medium(url))))',
    id: ids.join(','),
    maxResults: String(ids.length)
  }, apiKey, fetcher, channelMessages);
  for (const row of page.items) {
    if (!ids.includes(row?.id)) continue;
    const thumbnails = row.snippet?.thumbnails;
    for (const url of [thumbnails?.medium?.url, thumbnails?.default?.url]) {
      if (typeof url !== 'string' || url.length > 1024) continue;
      if (!/^https:\/\/yt3\.(?:ggpht|googleusercontent)\.com\/[^\s]+$/.test(url)) continue;
      avatars[row.id] = url;
      break;
    }
  }
  return { avatars };
}

export async function youtubePlaylist(input, apiKey, fetcher = fetch) {
  const id = playlistId(input?.url);
  if (!id) throw new YoutubePlaylistError(400, 'Вставьте ссылку на плейлист YouTube.');
  return playlistPage(id, input?.pageToken ?? '', apiKey, fetcher, playlistMessages);
}

export function youtubeChannelPage(uploads, pageToken, apiKey, fetcher = fetch) {
  return playlistPage(uploads, pageToken ?? '', apiKey, fetcher, channelMessages);
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
    if (!validId(id) || privacy === 'private' || (messages === channelMessages && privacy !== 'public')
        || typeof rawTitle !== 'string' || /^(?:deleted|private) video$/i.test(rawTitle.trim())) continue;
    const title = normalizeYoutubeTitle(rawTitle) || rawTitle.trim().slice(0, 160);
    if (title) videos.push({ id, title });
  }
  const nextPageToken = page.nextPageToken;
  return { videos, nextPageToken: typeof nextPageToken === 'string' && nextPageToken !== pageToken
    && nextPageToken.length <= 512 ? nextPageToken : '' };
}

export function applyChannelState(page, state) {
  return {
    ...page,
    videos: page.videos.flatMap(video => {
      const entry = state.get(video.id);
      return entry?.blocked ? [] : [{ ...video, viewCount: entry?.viewCount ?? 0 }];
    })
  };
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
