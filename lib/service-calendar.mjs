import {reach} from './http.mjs';

const ENDPOINT = 'https://mobile.12306.cn/wxxcx/wechat/bigScreen/queryTrainDiagram';

// The diagram uses 1 = running and 0 = not running, unlike the ticket API's controlled_train_flag.
export function normalizeCalendar(payload, code) {
  // M0025 means 12306 has no such train at all, e.g. metro-area services sold outside 12306.
  if (payload?.status === false && String(payload.errorMsg).includes('M0025')) return {code, unlisted: true, days: {}};
  const list = payload?.data?.running_list;
  if (payload?.status !== true || !Array.isArray(list)) throw new Error('12306 未返回可用开行日历');
  const days = {};
  for (const {date, flag} of list) {
    if (/^\d{8}$/.test(date) && (flag === '0' || flag === '1')) days[date] = flag;
  }
  if (!Object.keys(days).length) throw new Error('12306 开行日期状态无法识别');
  return {code, days};
}

// `code` must already be a known train code and `date` a compact YYYYMMDD date.
export async function fetchServiceCalendar(code, date, fetcher = fetch) {
  const response = await reach('12306', ENDPOINT, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
    body: new URLSearchParams({trainCode: code, queryDate: date}).toString(),
    signal: AbortSignal.timeout(12000),
  }, fetcher);
  if (!response.ok) throw new Error(`12306 开行日历请求失败（${response.status}）`);
  return normalizeCalendar(await response.json(), code);
}

// The public proxy only forwards known origin codes or, before any timetable is cached, codes of a valid shape.
export function isKnownCode(code, knownCodes) {
  return typeof code === 'string' && (knownCodes ? knownCodes.has(code) : /^[GCDSKZTY]?\d{1,4}$/.test(code));
}
