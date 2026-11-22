// The baseline comes from the loaded HTML, never from a potentially newer server response.
export function createWebUpdater({ version, canReload, reload, fetchVersion = readVersion, delay = 1500 }) {
  let pending;
  let checking = false;
  let reloading = false;
  let stopped = false;
  let timer;

  function reconsider() {
    clearTimeout(timer);
    timer = undefined;
    if (!stopped && !reloading && pending && canReload()) {
      timer = setTimeout(apply, delay);
    }
  }

  async function latest() {
    const next = await fetchVersion();
    if (typeof next !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(next)) return false;
    pending = next === version ? undefined : next;
    return true;
  }

  async function check() {
    if (!version || stopped || reloading || checking) return;
    checking = true;
    try {
      if (await latest()) reconsider();
    } catch {
      // Offline, timeout, or a bad response: keep the current page and retry on the next check.
    } finally {
      checking = false;
    }
  }

  async function apply() {
    timer = undefined;
    if (stopped || reloading || checking || !pending || !canReload()) return;
    checking = true;
    try {
      // Confirm connectivity and the release again; it may have been rolled back while we waited.
      if (await latest() && !stopped && pending && canReload()) {
        reloading = true;
        reload();
      }
    } catch {
      // Do not navigate away from a working page while the server is unavailable.
    } finally {
      checking = false;
    }
  }

  return {
    check,
    reconsider,
    stop() {
      stopped = true;
      clearTimeout(timer);
    }
  };
}

async function readVersion() {
  const response = await fetch('/version.json', {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Version unavailable');
  return (await response.json()).version;
}
