import {getDatabase} from '../lib/database.mjs';
import {rejectBots} from '../lib/guard.mjs';
import {HOUR, cdnJson, failure} from '../lib/http.mjs';

export async function GET(request) {
  const blocked = await rejectBots(request);
  if (blocked) return blocked;
  try {
    const {version} = await getDatabase();
    return cdnJson({version}, 12 * HOUR);
  } catch (error) {
    return failure(error.message, 502);
  }
}
