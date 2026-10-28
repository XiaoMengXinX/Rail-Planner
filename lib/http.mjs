export const HOUR = 3600;
export const DAY = 24 * HOUR;

// Successful API responses are cached by Vercel's CDN only; the page keeps its own copies in IndexedDB.
export function cdnCached(body, seconds, headers = {}) {
  return new Response(body, {headers: {...headers, 'Cache-Control': 'max-age=0', 'Vercel-CDN-Cache-Control': `max-age=${seconds}`}});
}

export const cdnJson = (value, seconds) => cdnCached(JSON.stringify(value), seconds, {'Content-Type': 'application/json'});

// Network failures only say "fetch failed"; the cause code (e.g. UND_ERR_CONNECT_TIMEOUT) tells them apart.
export async function reach(target, url, init, fetcher = fetch) {
  try {
    return await fetcher(url, init);
  } catch (error) {
    throw new Error(`无法连接 ${target}（${error.name === 'TimeoutError' ? '超时' : error.cause?.code ?? error.message}）`);
  }
}

export const failure = (message, status) => Response.json({error: message}, {status, headers: {'Cache-Control': 'no-store'}});
