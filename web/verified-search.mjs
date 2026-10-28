import {addDays} from './dates.mjs';
import {searchWindow,expandResult} from './router.mjs';

// An unlisted train has no calendar: strict verification treats it as never running, otherwise the
// offline rules decide.
export function installCalendar(network,calendar,strict=false) {
  const value=calendar.unlisted?{...calendar,excluded:strict}:calendar;
  network.serviceCalendars.set(calendar.code,value);
  return value;
}

export async function searchVerified(network,query,{fetchCalendar,onProgress}) {
  const started=performance.now(),strict=query.strict===true;
  let rejected=0,unlistedRejected=0;
  // Calendars persist in the page's daily cache behind fetchCalendar; a search only keeps its working set.
  network.serviceCalendars=new Map();
  for(let attempt=0;attempt<40;attempt++) {
    if(performance.now()-started>120000)throw new Error('开行核验超时，请缩小日期范围后重试');
    const candidate=searchWindow(network,query);
    if(!candidate.found)return {...candidate,verification:{rejected,unlistedRejected}};
    onProgress?.({stage:'verifying'});
    const services=new Map();
    for(const leg of candidate.legs) {
      const code=network.trains[leg.trainIndex].c[0],date=addDays(query.date,leg.originDay).replaceAll('-','');
      services.set(code+'_'+date,{code,date});
    }
    const flags=await Promise.all([...services.values()].map(async ({code,date})=>{
      let calendar=network.serviceCalendars.get(code);
      if(!calendar||(!calendar.unlisted&&calendar.days[date]==null)) {
        try{calendar=installCalendar(network,await fetchCalendar(code,date),strict);}
        catch(error){throw new Error(`无法核验 ${code} 的开行状态（${error.message}）`);}
      }
      if(calendar.unlisted)return {code,flag:'unlisted'};
      if(calendar.days[date]==null)throw new Error(`${code} 的始发日期不在官方开行日历范围内`);
      return {code,flag:calendar.days[date]};
    }));
    const stopped=flags.filter(s=>s.flag==='0').length,unlisted=new Set(flags.filter(s=>s.flag==='unlisted').map(s=>s.code));
    if(stopped||(strict&&unlisted.size)) {
      rejected+=stopped;if(strict)unlistedRejected+=unlisted.size;
      onProgress?.({stage:'rerouting',rejected:rejected+unlistedRejected});continue;
    }
    const result=expandResult(network,candidate);
    result.legs=result.legs.map(leg=>({...leg,unlisted:unlisted.has(leg.codes[0])}));
    return {...result,verification:{rejected,unlistedRejected}};
  }
  throw new Error('停运班次过多，请缩小日期范围后重试');
}
