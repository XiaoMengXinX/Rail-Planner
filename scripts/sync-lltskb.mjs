// Run by the sync-lltskb workflow. Writes an.db and version.json to the given directory when lltskb serves a
// newer package than the one published in the release; writes nothing otherwise.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readVersion, unzip} from '../lib/lltskb-db.mjs';
import {RELEASE_URL} from '../lib/release.mjs';

const ANNOUNCEMENT_URL = 'http://down.lltskb.com/android.ver';

// android.ver is not valid JSON (a market entry has an unbalanced quote), so fields are read by pattern.
export function parseAnnouncement(text) {
  const version = text.match(/"data"\s*:\s*"(\d{8})"/)?.[1];
  const list = text.match(/"dataUrl"\s*:\s*\[([^\]]*)\]/)?.[1] ?? '';
  const urls = [...list.matchAll(/"(https?:\/\/[^"]+)"/g)].map(match => match[1]);
  if (!version || !urls.length) throw new Error('Cannot parse the lltskb announcement');
  return {version, urls};
}

async function fetchAnnouncement() {
  const response = await fetch(ANNOUNCEMENT_URL, {signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`Announcement request failed (${response.status})`);
  return parseAnnouncement(await response.text());
}

// Mirrors lag behind each other, so the newest one is picked by HEAD first.
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
      const response = await fetch(url, {signal: AbortSignal.timeout(180000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      console.warn(`${url}: ${error.message}`);
    }
  }
  throw new Error('No mirror delivered an.db');
}

async function publishedVersion() {
  const response = await fetch(`${RELEASE_URL}version.json`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Reading the published version failed (${response.status})`);
  return (await response.json()).version;
}

async function sync(directory) {
  const [announcement, published] = await Promise.all([fetchAnnouncement(), publishedVersion()]);
  if (published && published >= announcement.version) return console.log(`Up to date: ${published}`);
  const bytes = await download(announcement.urls);
  const version = readVersion(await unzip(bytes));
  if (published && published >= version) return console.log(`Mirrors still serve ${version}, announced ${announcement.version}`);
  await fs.mkdir(directory, {recursive: true});
  await fs.writeFile(path.join(directory, 'an.db'), bytes);
  await fs.writeFile(path.join(directory, 'version.json'), JSON.stringify({version, announced: announcement.version}));
  console.log(`Publishing ${version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await sync(process.argv[2] ?? 'out');
