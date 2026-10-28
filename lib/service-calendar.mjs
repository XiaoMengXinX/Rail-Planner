import {reach} from './http.mjs';
const ENDPOINT='https://mobile.12306.cn/wxxcx/wechat/bigScreen/queryTrainDiagram';
export function compactDate(value) {
  const date=String(value??'').replaceAll('-','');
  if(!/^\d{8}$/.test(date))throw new Error('无效日期');
  const iso=`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
  if(new Date(iso+'T00:00:00Z').toISOString().slice(0,10)!==iso)throw new Error('无效日期');
  return date;
}
export function normalizeCalendar(payload,code,checkedAt=new Date().toISOString()) {
  // M0025 means 12306 has no such train at all, e.g. metro-area services sold outside 12306.
  if(payload?.status===false&&String(payload.errorMsg).includes('M0025'))return {code,unlisted:true,days:{},checkedAt,source:'12306-train-diagram'};
  const list=payload?.data?.running_list;
  if(payload?.status!==true||!Array.isArray(list)||!list.length||list.length>400)throw new Error('12306 未返回可用开行日历');
  const days={};
  for(const row of list) {
    let date;try{date=compactDate(row.date);}catch{continue;}
    // The diagram uses 1=running, 0=not running. This is distinct from the
    // ticket API's controlled_train_flag (where 0 is the normal state).
    const flag=String(row.flag);
    if(flag!=='0'&&flag!=='1')continue;
    if(date in days&&days[date]!==flag)throw new Error('开行日历存在冲突状态');
    days[date]=flag;
  }
  if(!Object.keys(days).length)throw new Error('12306 开行日期状态无法识别');
  return {code,days,checkedAt,source:'12306-train-diagram'};
}
// `code` must already be a known train code and `date` a compact YYYYMMDD date.
export async function fetchServiceCalendar(code,date,fetcher=fetch) {
  const response=await reach('12306',ENDPOINT,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},
    body:new URLSearchParams({trainCode:code,queryDate:date}).toString(),signal:AbortSignal.timeout(12000)},fetcher);
  if(!response.ok)throw new Error(`12306 开行日历请求失败（${response.status}）`);
  return normalizeCalendar(await response.json(),code);
}

// The public proxy only forwards known origin codes or, before any timetable is cached, codes of a valid shape.
export function isKnownCode(code,knownCodes) {
  return typeof code==='string'&&(knownCodes?knownCodes.has(code):/^[GCDSKZTY]?\d{1,4}$/.test(code));
}
