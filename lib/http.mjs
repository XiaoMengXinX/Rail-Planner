export const HOUR = 3600;
export const DAY = 24 * HOUR;

// Successful API responses are cached by Vercel's CDN only; the page keeps its own copies in IndexedDB.
export function cdnCached(body, seconds, headers = {}) {
  return new Response(body, {headers: {...headers, 'Cache-Control': 'max-age=0', 'Vercel-CDN-Cache-Control': `max-age=${seconds}`}});
}

export const cdnJson = (value, seconds) => cdnCached(JSON.stringify(value), seconds, {'Content-Type': 'application/json'});

export const failure = (message, status) => Response.json({error: message}, {status, headers: {'Cache-Control': 'no-store'}});
