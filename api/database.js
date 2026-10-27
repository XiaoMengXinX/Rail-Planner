import {getDatabase} from '../lib/database.mjs';
import {rejectBots} from '../lib/guard.mjs';
import {DAY, cdnCached, failure} from '../lib/http.mjs';

// /api/database?v=<version>: one URL per package version, so the CDN can keep it indefinitely.
export async function GET(request) {
  const blocked = await rejectBots(request);
  if (blocked) return blocked;
  const version = new URL(request.url).searchParams.get('v');
  let database;
  try {
    database = await getDatabase(version);
  } catch (error) {
    return failure(error.message, 502);
  }
  if (database.version !== version) return failure('数据版本已变化', 409);
  return cdnCached(database.bytes, 365 * DAY, {'Content-Type': 'application/zip'});
}
