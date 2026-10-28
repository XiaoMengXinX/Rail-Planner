// Timetable-aware, resource-constrained label-setting search. No dependencies.
const DAY = 1440;
const MILLIS_DAY = 86400000;

// Days since the epoch for 20261028 or '2026-10-28'.
export function dateDay(value) {
  const s = String(value).replaceAll('-', '');
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6)-1, +s.slice(6, 8))/MILLIS_DAY;
}

class Heap {
  constructor(compare) { this.items = []; this.compare = compare; }
  push(item) {
    const a = this.items; a.push(item);
    let i = a.length-1;
    while (i) { const p = (i-1)>>1; if (this.compare(a[p], item) <= 0) break; a[i] = a[p]; i = p; }
    a[i] = item;
  }
  pop() {
    const a = this.items, top = a[0], last = a.pop();
    if (a.length) {
      let i = 0;
      while (i*2+1 < a.length) {
        let j = i*2+1;
        if (j+1 < a.length && this.compare(a[j+1], a[j]) < 0) j++;
        if (this.compare(last, a[j]) <= 0) break;
        a[i] = a[j]; i = j;
      }
      a[i] = last;
    }
    return top;
  }
  get length() { return this.items.length; }
}

export function createNetwork(data) {
  const departures = Array.from({length:data.stations.length}, () => []);
  const trains = data.trains.map((train, index) => {
    train.s.forEach((s, i) => {
      if (s[2] >= 0 && i < train.s.length-1) departures[s[0]].push([index, i]);
    });
    return {...train, fromDay:dateDay(train.f), toDay:dateDay(train.t),
      cancellations:(train.x??[]).map(([kind,from,to])=>({kind,from:dateDay(from),to:dateDay(to)}))};
  });
  // Stations sharing an lltskb group with this one, for transfers that change station.
  const sameCity = data.stations.map(() => new Set());
  for (const group of data.groups ?? []) for (const a of group) for (const b of group) if (a !== b) sameCity[a].add(b);
  return {...data, trains, departures, sameCity:sameCity.map(set => [...set]), serviceCalendars:new Map()};
}

export function operates(network, train, originDay) {
  if (originDay < train.fromDay || originDay > train.toDay) return false;
  let state=-1;
  for(const record of train.cancellations) {
    if(originDay<record.from||originDay>record.to)continue;
    if(state===-1&&record.kind!==2)state=record.kind;
    else if(state===0&&record.kind===1)state=1;
    else if(state===1&&record.kind===2)state=2;
    else if(state===2&&record.kind===0)state=0;
  }
  if(state===1)return false;
  const calendar=network.serviceCalendars.get(train.c[0]);
  if(calendar&&(calendar.excluded||calendar.days[new Date(originDay*MILLIS_DAY).toISOString().slice(0,10).replaceAll('-','')]==='0'))return false;
  const [rawPeriod, mask] = network.rules[train.r];
  const period = rawPeriod || 1;
  // Arithmetic rather than JS bitwise operators: masks can exceed 32 bits.
  return period === 1 || Math.floor(mask / 2**((originDay-train.fromDay)%period))%2 === 1;
}

function nextDeparture(network, train, stop, ready, deadline, queryDay) {
  const minute = train.s[stop][2];
  let day = Math.max(Math.ceil((ready-minute)/DAY), train.fromDay-queryDay);
  const end = Math.min(Math.floor((deadline-minute)/DAY), train.toDay-queryDay);
  for (; day <= end; day++) {
    if (operates(network, train, queryDay+day)) return [minute+day*DAY, day];
  }
  return null;
}

// `cityPairs` overrides the same-city transfer time per station pair; false removes that transfer.
const moveCost = (cityTransfer, cityPairs, from, to) => cityPairs?.[`${from}-${to}`] ?? cityTransfer;

// Lower bound of the remaining minutes (fastest) or kilometres (shortest) from every station to `to`: a
// backward Dijkstra over consecutive stops that ignores waiting, dwell and dates. Infinity means `to` cannot
// be reached at all. Cached because verified searches repeat the same query.
function remainingBound(network, to, mode, cityTransfer, cityPairs) {
  const key = `${mode}:${to}:${cityTransfer}:${JSON.stringify(cityPairs)}`;
  network.bounds ??= new Map();
  if (network.bounds.has(key)) return network.bounds.get(key);
  network.reverse ??= {};
  network.reverse[mode] ??= (() => {
    const edges = Array.from({length:network.stations.length}, () => []);
    for (const train of network.trains) {
      if (mode === 'shortest' && train.d === false) continue;
      for (let i = 1; i < train.s.length; i++) {
        const [a, b] = [train.s[i-1], train.s[i]];
        const cost = mode === 'shortest' ? b[3]-a[3] : b[1]-(a[2] >= 0 ? a[2] : a[1]);
        edges[b[0]].push(a[0], Math.max(0, cost));
      }
    }
    return edges;
  })();
  const edges = network.reverse[mode];
  const bound = new Float64Array(network.stations.length).fill(Infinity);
  const queue = new Heap((a, b) => a[0]-b[0]);
  bound[to] = 0; queue.push([0, to]);
  while (queue.length) {
    const [cost, station] = queue.pop();
    if (cost > bound[station]) continue;
    const relax = (next, value) => { if (value < bound[next]) { bound[next] = value; queue.push([value, next]); } };
    const list = edges[station];
    for (let i = 0; i < list.length; i += 2) relax(list[i], cost+list[i+1]);
    if (cityTransfer === null) continue;
    for (const other of network.sameCity[station]) {
      const move = moveCost(cityTransfer, cityPairs, other, station);
      if (move !== false) relax(other, cost+(mode === 'shortest' ? 0 : move));
    }
  }
  network.bounds.set(key, bound);
  return bound;
}

// Minimises journey time (or distance) over every first boarding on the departure date. A later first
// departure is a separate resource: an earlier-arriving label must never erase it merely because it reaches
// an intermediate station earlier. The query comes from the validated form and is not checked again here.
export function searchWindow(network, query, options={}) {
  const started=performance.now();
  const {from,to,date,arrivalDate,maxTransfers,minTransfer,mode,startMinute=0,endMinute=DAY-1,cityTransfer=null,cityPairs}=query;
  const queryDay=dateDay(date),deadline=(dateDay(arrivalDate)-queryDay)*DAY+endMinute+1;
  // Changing station can only improve on staying put, so the cheaper search without it gives an upper bound.
  if(cityTransfer!==null&&options.bound==null) {
    const base=searchWindow(network,{...query,cityTransfer:null},options);
    if(base.found)return searchWindow(network,query,{...options,bound:mode==='shortest'?base.km:base.journeyMinutes});
  }
  const frontiers=Array.from({length:network.stations.length},()=>[]);
  const elapsed=l=>l.time-l.start;
  // Labels are ordered by primary cost plus the remaining bound (A*). The bound is admissible and the
  // secondary costs only grow along a path, so the first label popped at `to` is still the exact optimum.
  const bound=remainingBound(network,to,mode,cityTransfer,cityPairs);
  const compare=mode==='shortest'
    ? (a,b)=>a.estimate-b.estimate||elapsed(a)-elapsed(b)||a.legs-b.legs||a.time-b.time
    : (a,b)=>a.estimate-b.estimate||a.km-b.km||a.legs-b.legs||a.time-b.time;
  const queue=new Heap(compare);
  let checks=0,bestPrimary=options.bound??Infinity;
  const primary=l=>mode==='shortest'?l.km:elapsed(l);
  function checkTime() {
    if(++checks%1000===0&&performance.now()-started>60000) {
      const error=new Error('搜索超时，请缩小日期范围或减少换乘次数');
      error.code='TIMEOUT';throw error;
    }
  }
  function keep(c) {
    checkTime();
    c.estimate=primary(c)+bound[c.station];
    if(bound[c.station]===Infinity||c.estimate>bestPrimary)return;
    const frontier=frontiers[c.station];
    // A label reached by changing station can board at once but cannot change station again.
    c.ready=c.moved?c.time:c.time+minTransfer;
    // The frontier is an antichain, so a covered candidate covers none of it and nothing is dropped early.
    let kept=0;
    for(let i=0;i<frontier.length;i++) {
      const l=frontier[i];
      if(l.ready<=c.ready&&l.start>=c.start&&l.km<=c.km&&l.legs<=c.legs&&(!l.moved||c.moved))return;
      if(c.ready<=l.ready&&c.start>=l.start&&c.km<=l.km&&c.legs<=l.legs&&(!c.moved||l.moved))l.dead=true;
      else frontier[kept++]=l;
    }
    frontier.length=kept;
    frontier.push(c);queue.push(c);
    if(c.station===to)bestPrimary=Math.min(bestPrimary,primary(c));
  }
  function ride(trainIndex,board,departure,originDay,parent) {
    const train=network.trains[trainIndex],start=parent?.start??departure;
    for(let alight=board+1;alight<train.s.length;alight++) {
      const stop=train.s[alight],arrival=stop[1]+originDay*DAY;
      if(arrival>=deadline)break;
      const km=stop[3]-train.s[board][3];
      if(arrival<departure||(train.d!==false&&km<0))continue;
      keep({station:stop[0],time:arrival,start,km:train.d===false?Infinity:(parent?.km??0)+km,
        legs:(parent?.legs??0)+1,parent,dead:false,
        leg:{trainIndex,board,alight,originDay,departure,arrival,km:train.d===false?null:km}});
    }
  }
  // Boarding minutes are relative to the train's origin day, which may precede the departure date.
  for(const [trainIndex,board] of network.departures[from]) {
    const train=network.trains[trainIndex];
    if(mode==='shortest'&&train.d===false)continue;
    const minute=train.s[board][2],day=Math.ceil((startMinute-minute)/DAY);
    if(minute+day*DAY<DAY&&operates(network,train,queryDay+day))ride(trainIndex,board,minute+day*DAY,day,null);
  }
  while(queue.length) {
    const current=queue.pop();
    if(current.dead)continue;
    if(current.station===to) {
      const legs=[];
      for(let label=current;label;label=label.parent)if(label.leg)legs.push(label.leg);
      legs.reverse();
      return {found:true,legs,departure:current.start,arrival:current.time,journeyMinutes:elapsed(current),
        km:Number.isFinite(current.km)?current.km:null,transfers:current.legs-1};
    }
    if(current.legs>=maxTransfers+1)continue;
    checkTime();
    for(const [trainIndex,board] of network.departures[current.station]) {
      const train=network.trains[trainIndex];
      if(mode==='shortest'&&train.d===false)continue;
      const next=nextDeparture(network,train,board,current.ready,deadline-1,queryDay);
      if(next)ride(trainIndex,board,next[0],next[1],current);
    }
    if(cityTransfer===null||current.moved)continue;
    for(const station of network.sameCity[current.station]) {
      const move=moveCost(cityTransfer,cityPairs,current.station,station);
      if(move===false||current.time+move>=deadline||station===to||!network.departures[station].length)continue;
      keep({...current,station,time:current.time+move,parent:current,leg:null,moved:true,dead:false});
    }
  }
  return {found:false};
}

// Rebuilds a shared plan of [code, board station, alight station, boarding day] legs against the timetable
// and the query's constraints. Throws with the first reason the plan cannot be ridden.
export function planResult(network, query, plan) {
  const {from,to,date,arrivalDate,maxTransfers,minTransfer,startMinute=0,endMinute=DAY-1,cityTransfer=null,cityPairs}=query;
  const queryDay=dateDay(date),deadline=(dateDay(arrivalDate)-queryDay)*DAY+endMinute+1;
  const name=station=>network.stations[station][0];
  if(!plan.length||plan.length>maxTransfers+1)throw new Error('换乘次数不符');
  const legs=plan.map(([code,board,alight,day])=>{
    for(const [trainIndex,train] of network.trains.entries()) {
      if(!train.c.includes(code))continue;
      const i=train.s.findIndex((s,k)=>s[0]===board&&s[2]>=0&&k<train.s.length-1);
      const j=train.s.findIndex((s,k)=>s[0]===alight&&k>i);
      if(i<0||j<0)continue;
      const originDay=day-Math.floor(train.s[i][2]/DAY),km=train.s[j][3]-train.s[i][3];
      const departure=train.s[i][2]+originDay*DAY,arrival=train.s[j][1]+originDay*DAY;
      if(arrival<departure||(train.d!==false&&km<0)||!operates(network,train,queryDay+originDay))continue;
      return {trainIndex,board:i,alight:j,originDay,departure,arrival,km:train.d===false?null:km};
    }
    throw new Error(`${code} 当日不在${name(board)}至${name(alight)}间运行`);
  });
  const station=(leg,stop)=>network.trains[leg.trainIndex].s[stop][0];
  if(station(legs[0],legs[0].board)!==from||station(legs.at(-1),legs.at(-1).alight)!==to)throw new Error('出发站或到达站不符');
  if(legs[0].departure<startMinute||legs[0].departure>=DAY)throw new Error('出发时间不符');
  if(legs.at(-1).arrival>=deadline)throw new Error('晚于最晚到达时间');
  for(let k=1;k<legs.length;k++) {
    const [a,b]=[station(legs[k-1],legs[k-1].alight),station(legs[k],legs[k].board)];
    const gap=a===b?minTransfer:cityTransfer!==null&&network.sameCity[a].includes(b)?moveCost(cityTransfer,cityPairs,a,b):false;
    if(gap===false)throw new Error(`不能从${name(a)}换乘至${name(b)}`);
    if(legs[k].departure<legs[k-1].arrival+gap)throw new Error(`${name(a)}换乘时间不足`);
  }
  const kms=legs.map(leg=>leg.km);
  return {found:true,legs,departure:legs[0].departure,arrival:legs.at(-1).arrival,
    journeyMinutes:legs.at(-1).arrival-legs[0].departure,km:kms.includes(null)?null:kms.reduce((a,b)=>a+b,0),transfers:legs.length-1};
}

export function expandResult(network, result) {
  return {...result, legs:result.legs.map(leg => {
    const train = network.trains[leg.trainIndex];
    return {...leg, trainId:train.id, name:train.n, codes:train.c,
      stops:train.s.slice(leg.board,leg.alight+1).map((stop,i) => ({
        station:network.stations[stop[0]][0], stationId:stop[0],
        arrival:leg.board+i === 0 ? null : stop[1]+leg.originDay*DAY,
        departure:stop[2] < 0 ? null : stop[2]+leg.originDay*DAY,
        km:train.d === false?null:stop[3]-train.s[leg.board][3], platform:stop[4], code:train.c[stop[5]]
      }))};
  })};
}
