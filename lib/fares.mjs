import {reach} from './http.mjs';

const BASE = 'https://kyfw.12306.cn/otn/';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SEATS = {
  9: '商务座', P: '特等座', D: '优选一等座', M: '一等座', O: '二等座', A: '高级动卧', F: '动卧',
  I: '一等卧', J: '二等卧', 6: '高级软卧', 4: '软卧', 3: '硬卧', 2: '软座', 1: '硬座', Q: '观光座',
};

// Each left-ticket row is '|'-separated: [3] train code, [6]/[7] boarding/alighting telecodes, [39] yp_info_new.
// yp_info_new holds 10-character groups: seat code, fare in 0.1 yuan, seats left; 3000 or more marks standing
// tickets sold at that seat's fare.
export function parseFares(payload, from, to) {
  const rows = payload?.data?.result;
  if (payload?.status === false || !Array.isArray(rows)) throw new Error('12306 未返回余票信息');
  const fares = {};
  for (const row of rows) {
    const fields = row.split('|');
    if (fields[6] !== from || fields[7] !== to) continue;
    let cheapest = null;
    for (const group of fields[39]?.match(/.{10}/g) ?? []) {
      const price = Number(group.slice(1, 6)) / 10;
      if (!(price > 0) || (cheapest && price >= cheapest.price)) continue;
      cheapest = {seat: Number(group.slice(6)) >= 3000 ? '无座' : SEATS[group[0]] ?? '其他席位', price};
    }
    if (cheapest) fares[fields[3]] = cheapest;
  }
  return fares;
}

// The query endpoint only answers with the cookies the init page sets, and occasionally moves (c_url).
let session = null;

async function openSession() {
  const response = await reach('12306', `${BASE}leftTicket/init`, {headers: {'User-Agent': USER_AGENT}, signal: AbortSignal.timeout(10000)});
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error('12306 会话建立失败');
  return {cookie, endpoint: 'leftTicket/queryG', expires: Date.now() + 30 * 60 * 1000};
}

// `from` and `to` must be telecodes and `date` an ISO date inside the presale period.
export async function fetchFares(from, to, date) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!session || Date.now() > session.expires) session = await openSession();
    const query = new URLSearchParams({
      'leftTicketDTO.train_date': date, 'leftTicketDTO.from_station': from, 'leftTicketDTO.to_station': to, purpose_codes: 'ADULT',
    });
    const response = await reach('12306', `${BASE}${session.endpoint}?${query}`, {
      headers: {'User-Agent': USER_AGENT, Cookie: session.cookie, Referer: `${BASE}leftTicket/init`},
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`12306 余票请求失败（${response.status}）`);
    const payload = await response.json().catch(() => null);
    if (!payload) session = null;
    else if (payload.c_url) session.endpoint = payload.c_url;
    else return parseFares(payload, from, to);
  }
  throw new Error('12306 余票查询失败');
}
