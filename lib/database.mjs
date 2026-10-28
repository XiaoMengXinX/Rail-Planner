import {getCache, waitUntil} from '@vercel/functions';
import {readTrainCodes, readVersion, unzip} from './lltskb-db.mjs';
import {RELEASE_URL} from './release.mjs';

const REFRESH_INTERVAL = 2 * 86400 * 1000;
const RETRY_INTERVAL = 60 * 60 * 1000;
const SCHEDULE_KEY = 'release-schedule';
// Runtime Cache items are capped at 2 MB, so the base64 package is stored in parts.
const PART_SIZE = 1_500_000;
const CODES_KEY = 'codes:latest';

const reason = error => error.name === 'TimeoutError' ? '超时' : error.cause?.code ?? error.message;

async function fetchRelease(name, timeout) {
  let response;
  try {
    response = await fetch(RELEASE_URL + name, {signal: AbortSignal.timeout(timeout)});
  } catch (error) {
    throw new Error(`无法获取时刻表数据（${reason(error)}）`);
  }
  if (!response.ok) throw new Error(`时刻表数据请求失败（${response.status}）`);
  return response;
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

async function load(published) {
  const cache = sharedCache();
  let bytes = await readShared(cache, `an.db:${published}`);
  const shared = Boolean(bytes);
  bytes ??= new Uint8Array(await (await fetchRelease('an.db', 60000)).arrayBuffer());
  const files = await unzip(bytes);
  const version = readVersion(files);
  if (!shared) await writeShared(cache, `an.db:${version}`, bytes, 7 * 86400);
  const codes = readTrainCodes(files);
  await cache.set(CODES_KEY, [...codes], {ttl: 30 * 86400});
  return {published, version, bytes, codes};
}

let current = null;
let nextCheck = 0;
let pending = null;

// The release is checked at most every two days across all instances: the next check time is kept in the
// regional cache together with the version it found.
async function refresh() {
  const cache = sharedCache();
  try {
    let schedule = await cache.get(SCHEDULE_KEY);
    if (!schedule || Date.now() >= schedule.nextCheck) {
      const {version} = await (await fetchRelease('version.json', 15000)).json();
      schedule = {version, nextCheck: Date.now() + REFRESH_INTERVAL};
      await cache.set(SCHEDULE_KEY, schedule, {ttl: 30 * 86400});
    }
    if (!current || schedule.version !== current.published) current = await load(schedule.version);
    nextCheck = schedule.nextCheck;
  } catch (error) {
    if (!current) throw error;
    console.warn(`Keeping ${current.version}: ${error.message}`);
    nextCheck = Date.now() + RETRY_INTERVAL;
  }
  return current;
}

const fresh = () => current && Date.now() < nextCheck;

// Per-instance memory first, then the regional Runtime Cache, then the GitHub release. Asking for a version
// this instance does not hold rereads the shared schedule, in case another instance already moved on.
export async function getDatabase(version) {
  if (fresh() && (!version || version === current.version)) return current;
  pending ??= refresh().finally(() => { pending = null; });
  return pending;
}

// For validating proxy requests without waiting on a download: uses what this instance or the regional
// cache already holds and refreshes in the background. Null when nothing is cached anywhere yet.
export async function getTrainCodes() {
  if (fresh()) return current.codes;
  waitUntil(getDatabase().catch(error => console.error(`Database refresh failed: ${error.message}`)));
  if (current) return current.codes;
  const codes = await sharedCache().get(CODES_KEY);
  return codes ? new Set(codes) : null;
}
