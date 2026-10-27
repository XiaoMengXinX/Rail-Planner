import {rejectBots} from '../lib/guard.mjs';
import {HOUR, cdnJson, failure} from '../lib/http.mjs';
import {fetchFares} from '../lib/fares.mjs';
import {addDays, isDate, today} from '../web/dates.mjs';

const PRESALE_DAYS = 15;
const isTelecode = value => /^[A-Z]{3}$/.test(value ?? '');

// /api/fares?from=DBN&to=LFN&date=2026-10-29: the cheapest seat of every train between two stations.
export async function GET(request) {
  const blocked = await rejectBots(request);
  if (blocked) return blocked;
  const params = new URL(request.url).searchParams;
  const from = params.get('from'), to = params.get('to'), date = params.get('date');
  const first = today();
  if (!isTelecode(from) || !isTelecode(to) || from === to || !isDate(date) || date < first || date > addDays(first, PRESALE_DAYS - 1)) {
    return failure('参数无效', 400);
  }
  try {
    return cdnJson({fares: await fetchFares(from, to, date)}, 12 * HOUR);
  } catch (error) {
    console.error(`12306 fares ${from}-${to} ${date}: ${error.message}`);
    return failure(error.message, 502);
  }
}
