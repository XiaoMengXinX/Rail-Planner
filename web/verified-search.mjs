import {searchWindow,expandResult,dateDay} from './router.mjs';
function calendarDate(queryDate,offset) {
  const d=new Date(queryDate+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10).replaceAll('-','');
}
// An unlisted train has no calendar: strict verification treats it as never running, otherwise the
// offline rules decide.
export function installCalendar(network,calendar,strict=false) {
  if(!calendar||typeof calendar.code!=='string')throw new Error('开行日历格式无效');
  network.serviceCalendars??=new Map();
  if(calendar.unlisted===true) {
    const value={code:calendar.code,unlisted:true,excluded:strict,days:{},checkedAt:calendar.checkedAt};
    network.serviceCalendars.set(calendar.code,value);
    return value;
  }
  if(typeof calendar.days!=='object'||!calendar.days)throw new Error('开行日历格式无效');
  const days={};
  for(const [date,flag]of Object.entries(calendar.days)) {
    if(!/^\d{8}$/.test(date)||!['0','1'].includes(flag))continue;
    days[date]=flag;
  }
  const value={...calendar,days};
  network.serviceCalendars.set(calendar.code,value);
  return value;
}
export async function searchVerified(network,query,options={}) {
  const started=performance.now();let rejected=0,unlistedRejected=0,lookups=0;
  const {fetchCalendar}=options,strict=query.strict===true;
  // Calendars persist in the page's daily cache behind fetchCalendar; a search only keeps its working set.
  network.serviceCalendars=new Map();
  for(let attempt=0;attempt<40;attempt++) {
    if(performance.now()-started>90000)throw new Error('开行核验超时，请缩小日期范围后重试');
    const candidate=searchWindow(network,query,{onProgress:options.onProgress,maxMillis:options.maxMillis});
    if(!candidate.found)return {...candidate,verification:{status:'no-route',rejected,unlistedRejected,lookups}};
    options.onProgress?.({stage:'verifying',rejected,lookups,expanded:candidate.expanded,generated:candidate.generated});
    const services=new Map();
    for(const leg of candidate.legs) {
      const train=network.trains[leg.trainIndex],code=train.c[0],date=calendarDate(query.date,leg.originDay);
      services.set(code+'_'+date,{code,date});
    }
    const statuses=await Promise.all([...services.values()].map(async service=>{
      let calendar=network.serviceCalendars?.get(service.code);
      if(!calendar||(!calendar.unlisted&&calendar.days[service.date]==null)) {
        try{calendar=installCalendar(network,await fetchCalendar(service.code,service.date),strict);lookups++;}
        catch(error){throw new Error(`无法核验 ${service.code} 的开行状态（${error.message}）`);}
      }
      if(calendar.unlisted)return {code:service.code,date:service.date,flag:'unlisted',checkedAt:calendar.checkedAt};
      const flag=calendar.days[service.date];
      if(flag==null)throw new Error(`${service.code} 的始发日期不在官方开行日历范围内`);
      return {code:service.code,date:service.date,flag,checkedAt:calendar.checkedAt};
    }));
    const stopped=statuses.filter(s=>s.flag==='0').length,unlisted=new Set(statuses.filter(s=>s.flag==='unlisted').map(s=>s.code));
    if(stopped||(strict&&unlisted.size)) {
      rejected+=stopped;if(strict)unlistedRejected+=unlisted.size;
      options.onProgress?.({stage:'rerouting',rejected:rejected+unlistedRejected,lookups});continue;
    }
    const result=expandResult(network,candidate);
    result.legs=result.legs.map(leg=>({...leg,unlisted:unlisted.has(leg.codes[0])}));
    return {...result,verification:{status:unlisted.size?'partial':'confirmed',source:'12306-train-diagram',services:statuses,rejected,unlistedRejected,lookups}};
  }
  throw new Error('停运班次过多，请缩小日期范围后重试');
}
