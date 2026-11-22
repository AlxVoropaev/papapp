export const cloud = false;
export const shortCodes = true;

export async function api(path, method = 'GET', data) {
  let response;
  try {
    response = await fetch('/api/' + path, {
      method,
      headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(12000)
    });
  } catch {
    throw new Error('Не удалось связаться с полкой. Проверьте интернет и попробуйте ещё раз.');
  }
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Ошибка сервера.'), { status: response.status });
  return result;
}

export function subscribeVideos() {}
