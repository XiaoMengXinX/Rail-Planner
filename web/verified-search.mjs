import {addDays} from './dates.mjs';
import {searchWindow,expandResult,planResult} from './router.mjs';

// An unlisted train has no calendar: strict verification treats it as never running, otherwise the
// offline rules decide.
export function installCalendar(network,calendar,strict=false) {
  const value=calendar.unlisted?{...calendar,excluded:strict}:calendar;
  network.serviceCalendars.set(calendar.code,value);
  return value;
}

async function checkCalendars(network,query,legs,fetchCalendar) {
  const services=new Map();
  for(const leg of legs) {
    const code=network.trains[leg.trainIndex].c[0],date=addDays(query.date,leg.originDay).replaceAll('-','');
    services.set(code+'_'+date,{code,date});
  }
  const flags=await Promise.all([...services.values()].map(async ({code,date})=>{
    let calendar=network.serviceCalendars.get(code);
    if(!calendar||(!calendar.unlisted&&calendar.days[date]==null)) {
      try{calendar=installCalendar(network,await fetchCalendar(code,date),query.strict);}
      catch(error){throw new Error(`无法核验 ${code} 的开行状态（${error.message}）`);}
    }
    if(calendar.unlisted)return {code,flag:'unlisted'};
    if(calendar.days[date]==null)throw new Error(`${code} 的始发日期不在官方开行日历范围内`);
    return {code,flag:calendar.days[date]};
  }));
  return {stopped:flags.filter(s=>s.flag==='0').map(s=>s.code),unlisted:new Set(flags.filter(s=>s.flag==='unlisted').map(s=>s.code))};
}

function finish(network,candidate,unlisted,verification) {
  const result=expandResult(network,candidate);
  result.legs=result.legs.map(leg=>({...leg,unlisted:unlisted.has(leg.codes[0])}));
  return {...result,verification};
}

export async function searchVerified(network,query,{fetchCalendar,onProgress}) {
  const started=performance.now();
  let rejected=0,unlistedRejected=0;
  // Calendars persist in the page's daily cache behind fetchCalendar; a search only keeps its working set.
  network.serviceCalendars=new Map();
  for(let attempt=0;attempt<40;attempt++) {
    if(performance.now()-started>120000)throw new Error('开行核验超时，请缩小日期范围后重试');
    const candidate=searchWindow(network,query);
    if(!candidate.found)return {...candidate,verification:{rejected,unlistedRejected}};
    onProgress?.({stage:'verifying'});
    const {stopped,unlisted}=await checkCalendars(network,query,candidate.legs,fetchCalendar);
    if(stopped.length||(query.strict&&unlisted.size)) {
      rejected+=stopped.length;if(query.strict)unlistedRejected+=unlisted.size;
      onProgress?.({stage:'rerouting',rejected:rejected+unlistedRejected});continue;
    }
    return finish(network,candidate,unlisted,{rejected,unlistedRejected});
  }
  throw new Error('停运班次过多，请缩小日期范围后重试');
}

export async function verifyPlan(network,query,plan,{fetchCalendar,onProgress}) {
  network.serviceCalendars=new Map();
  const candidate=planResult(network,query,plan);
  onProgress?.({stage:'verifying'});
  const {stopped,unlisted}=await checkCalendars(network,query,candidate.legs,fetchCalendar);
  if(stopped.length)throw new Error(`${stopped.join('、')} 当日停运`);
  if(query.strict&&unlisted.size)throw new Error(`${[...unlisted].join('、')} 未经 12306 核验`);
  return finish(network,candidate,unlisted,{rejected:0,unlistedRejected:0});
}
