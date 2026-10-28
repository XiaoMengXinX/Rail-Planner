import {getCache, waitUntil} from '@vercel/functions';
import {readTrainCodes, readVersion, unzip} from './lltskb-db.mjs';

const ANNOUNCEMENT_URL = 'http://down.lltskb.com/android.ver';
const REFRESH_INTERVAL = 2 * 86400 * 1000;
const RETRY_INTERVAL = 60 * 60 * 1000;
const SCHEDULE_KEY = 'schedule';
// Runtime Cache items are capped at 2 MB, so the base64 package is stored in parts.
const PART_SIZE = 1_500_000;
const CODES_KEY = 'codes:latest';

// android.ver is not valid JSON (a market entry has an unbalanced quote), so fields are read by pattern.
export function parseAnnouncement(text) {
  const version = text.match(/"data"\s*:\s*"(\d{8})"/)?.[1];
  const list = text.match(/"dataUrl"\s*:\s*\[([^\]]*)\]/)?.[1] ?? '';
  const urls = [...list.matchAll(/"(https?:\/\/[^"]+)"/g)].map(match => match[1]);
  if (!version || !urls.length) throw new Error('无法解析数据版本公告');
  return {version, urls};
}

const reason = error => error.name === 'TimeoutError' ? '超时' : error.cause?.code ?? error.message;

async function fetchAnnouncement() {
  let response;
  try {
    response = await fetch(ANNOUNCEMENT_URL, {signal: AbortSignal.timeout(30000)});
  } catch (error) {
    throw new Error(`无法连接路路通（${reason(error)}）`);
  }
  if (!response.ok) throw new Error(`版本公告请求失败（${response.status}）`);
  return parseAnnouncement(await response.text());
}

// Mirrors lag behind each other and download slowly, so the newest one is picked by HEAD first. Two full
// attempts plus the announcement stay inside the 300 s function limit.
async function rankMirrors(urls) {
  const heads = await Promise.all(urls.map(async url => {
    try {
      const response = await fetch(url, {method: 'HEAD', signal: AbortSignal.timeout(10000)});
      return {url, modified: Date.parse(response.headers.get('last-modified')) || 0};
    } catch {
      return {url, modified: -1};
    }
  }));
  return heads.sort((a, b) => b.modified - a.modified).map(head => head.url);
}

async function download(urls) {
  for (const url of await rankMirrors(urls)) {
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(120000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      console.warn(`${url}: ${reason(error)}`);
    }
  }
  throw new Error('数据库下载失败');
}

async function readShared(cache, key) {
  const parts = await cache.get(key);
  if (!parts) return null;
  const chunks = await Promise.all(Array.from({length: parts}, (_, i) => cache.get(`${key}:${i}`)));
  return chunks.includes(null) ? null : Buffer.from(chunks.join(''), 'base64');
}

async function writeShared(cache, key, bytes, ttl) {
  const text = Buffer.from(bytes).toString('base64');
  const parts = Math.ceil(text.length / PART_SIZE);
  await Promise.all(Array.from({length: parts}, (_, i) =>
    cache.set(`${key}:${i}`, text.slice(i * PART_SIZE, (i + 1) * PART_SIZE), {ttl})));
  await cache.set(key, parts, {ttl});
}

const sharedCache = () => getCache({namespace: 'lltskb'});

async function load({version: announced, urls}) {
  const cache = sharedCache();
  const key = `an.db:${announced}`;
  let bytes = await readShared(cache, key);
  const shared = Boolean(bytes);
  bytes ??= await download(urls);
  const files = await unzip(bytes);
  const version = readVersion(files);
  // A package older than announced comes from a lagging mirror; keep it only briefly.
  if (!shared) await writeShared(cache, key, bytes, version >= announced ? 7 * 86400 : 3600);
  const codes = readTrainCodes(files);
  await cache.set(CODES_KEY, [...codes], {ttl: 30 * 86400});
  return {announced, version, bytes, codes};
}

let current = null;
let nextCheck = 0;
let pending = null;

// The announcement is checked at most every two days across all instances: the next check time is
// kept in the regional cache together with the announcement it refers to.
async function refresh() {
  const cache = sharedCache();
  try {
    let schedule = await cache.get(SCHEDULE_KEY);
    if (!schedule || Date.now() >= schedule.nextCheck) schedule = {announcement: await fetchAnnouncement(), nextCheck: 0};
    if (schedule.announcement.version !== current?.announced) current = await load(schedule.announcement);
    if (!schedule.nextCheck) {
      // A lagging mirror can serve an older package than announced; look again sooner in that case.
      schedule.nextCheck = Date.now() + (current.version >= current.announced ? REFRESH_INTERVAL : RETRY_INTERVAL);
      await cache.set(SCHEDULE_KEY, schedule, {ttl: 30 * 86400});
    }
    nextCheck = schedule.nextCheck;
  } catch (error) {
    if (!current) throw error;
    console.warn(`Keeping ${current.version}: ${error.message}`);
    nextCheck = Date.now() + RETRY_INTERVAL;
  }
  return current;
}

const fresh = () => current && Date.now() < nextCheck;

// Per-instance memory first, then the regional Runtime Cache, then lltskb itself. Asking for a version
// this instance does not hold rereads the shared schedule, in case another instance already moved on.
export async function getDatabase(version) {
  if (fresh() && (!version || version === current.version)) return current;
  pending ??= refresh().finally(() => { pending = null; });
  return pending;
}

// For validating proxy requests without ever waiting on lltskb: uses what this instance or the regional
// cache already holds and refreshes in the background. Null when nothing is cached anywhere yet.
export async function getTrainCodes() {
  if (fresh()) return current.codes;
  waitUntil(getDatabase().catch(error => console.error(`Database refresh failed: ${error.message}`)));
  if (current) return current.codes;
  const codes = await sharedCache().get(CODES_KEY);
  return codes ? new Set(codes) : null;
}
