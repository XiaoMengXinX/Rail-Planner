import {getTrainCodes} from '../lib/database.mjs';
import {rejectBots} from '../lib/guard.mjs';
import {HOUR, cdnJson, failure} from '../lib/http.mjs';
import {fetchServiceCalendar, isKnownCode} from '../lib/service-calendar.mjs';
import {today} from '../web/dates.mjs';

// Running status can change at short notice (temporary suspensions), so calendars are kept for half a day.
const TTL = 12 * HOUR;
const cache = new Map();

// /api/service-calendar?code=G807. The calendar 12306 returns spans about 15 days back and 75 days ahead
// of the query date, so it is always fetched for today and cached per train code.
export async function GET(request) {
  const blocked = await rejectBots(request);
  if (blocked) return blocked;
  const code = new URL(request.url).searchParams.get('code');
  if (!isKnownCode(code, await getTrainCodes())) return failure('未知车次', 400);
  const cached = cache.get(code);
  if (cached?.expires > Date.now()) return cdnJson(cached.value, TTL);
  try {
    const value = await fetchServiceCalendar(code, today().replaceAll('-', ''));
    if (cache.size >= 2000) cache.delete(cache.keys().next().value);
    cache.set(code, {expires: Date.now() + TTL * 1000, value});
    return cdnJson(value, TTL);
  } catch (error) {
    console.error(`12306 calendar ${code}: ${error.message}`);
    return failure(error.message, 502);
  }
}
