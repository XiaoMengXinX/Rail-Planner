// Timetable-aware, resource-constrained label-setting search. No dependencies.
const DAY = 1440;
const MILLIS_DAY = 86400000;

export function dateDay(value) {
  const s = String(value).replaceAll('-', '');
  if (!/^\d{8}$/.test(s)) throw new Error('日期格式无效');
  const day = Date.UTC(+s.slice(0, 4), +s.slice(4, 6)-1, +s.slice(6, 8))/MILLIS_DAY;
  if (!Number.isFinite(day) || new Date(day*MILLIS_DAY).toISOString().slice(0,10).replaceAll('-','') !== s) throw new Error('日期格式无效');
  return day;
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
  for(const record of train.cancellations??[]) {
    if(originDay<record.from||originDay>record.to)continue;
    if(state===-1&&record.kind!==2)state=record.kind;
    else if(state===0&&record.kind===1)state=1;
    else if(state===1&&record.kind===2)state=2;
    else if(state===2&&record.kind===0)state=0;
  }
  if(state===1)return false;
  const calendar=network.serviceCalendars?.get(train.c?.[0]??train.n);
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

function dominates(a, b) {
  return a.time <= b.time && a.km <= b.km && a.legs <= b.legs;
}

export function search(network, query, options={}) {
  const started = performance.now();
  const {from, to, date, startMinute, maxTransfers, minTransfer, horizonHours, mode} = query;
  if (!Number.isInteger(from) || !Number.isInteger(to) || !network.stations[from] || !network.stations[to]) throw new Error('请选择有效的出发站和到达站');
  if (from === to) throw new Error('出发站和到达站不能相同');
  if (!Number.isInteger(maxTransfers) || maxTransfers < 0 || maxTransfers > 8) throw new Error('最大换乘次数应为 0–8');
  if (!Number.isInteger(minTransfer) || minTransfer < 0 || minTransfer > 720) throw new Error('换乘时间应为 0–720 分钟');
  if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute >= DAY || ![24,48,72,120,168].includes(horizonHours)) throw new Error('出发时间或查询窗口无效');
  if (!['fastest','shortest'].includes(mode)) throw new Error('查询策略无效');
  const queryDay = dateDay(date), deadline = startMinute+horizonHours*60;
  const frontiers = Array.from({length:network.stations.length}, () => []);
  const compare = mode === 'shortest'
    ? (a,b) => a.km-b.km || a.time-b.time || a.legs-b.legs
    : (a,b) => a.time-b.time || a.km-b.km || a.legs-b.legs;
  const queue = new Heap(compare);
  const root = {station:from, time:startMinute, km:0, legs:0, parent:null, leg:null, dead:false};
  queue.push(root); frontiers[from].push(root);
  let expanded = 0, generated = 1;
  while (queue.length) {
    const current = queue.pop();
    if (current.dead) continue;
    if (current.station === to) {
      const legs = [];
      for (let label=current; label.parent; label=label.parent) legs.push(label.leg);
      legs.reverse();
      return {found:true, legs, arrival:current.time, departure:legs[0].departure,
        elapsed:current.time-startMinute, journeyMinutes:current.time-legs[0].departure,
        km:Number.isFinite(current.km)?current.km:null, transfers:current.legs-1, expanded, generated,
        elapsedMs:performance.now()-started};
    }
    if (current.legs >= maxTransfers+1) continue;
    expanded++;
    if (expanded%1000 === 0) {
      options.onProgress?.({expanded, generated});
      if (performance.now()-started > (options.maxMillis ?? 60000)) {
        const error = new Error('搜索用时较长，尚未确认最优解。请减少换乘次数或缩短查询窗口后重试。');
        error.code = 'TIMEOUT'; throw error;
      }
    }
    const ready = current.time + (current.legs ? minTransfer : 0);
    for (const [trainIndex, board] of network.departures[current.station]) {
      const train = network.trains[trainIndex];
      if (mode === 'shortest' && train.d === false) continue;
      const next = nextDeparture(network, train, board, ready, deadline, queryDay);
      if (!next) continue;
      const [departure, originDay] = next;
      for (let alight=board+1; alight<train.s.length; alight++) {
        const stop = train.s[alight], arrival = stop[1]+originDay*DAY;
        if (arrival > deadline) break;
        const segmentKm = stop[3]-train.s[board][3];
        if (arrival < departure || (train.d !== false && segmentKm < 0)) continue;
        const candidate = {station:stop[0], time:arrival, km:train.d === false?Infinity:current.km+segmentKm,
          legs:current.legs+1, parent:current, dead:false,
          leg:{trainIndex, board, alight, originDay, departure, arrival, km:train.d === false?null:segmentKm}};
        const frontier = frontiers[stop[0]];
        if (frontier.some(label => dominates(label,candidate))) continue;
        for (let i=frontier.length-1; i>=0; i--) {
          if (dominates(candidate,frontier[i])) { frontier[i].dead=true; frontier.splice(i,1); }
        }
        frontier.push(candidate); queue.push(candidate); generated++;
      }
    }
  }
  return {found:false, expanded, generated, elapsedMs:performance.now()-started};
}

// Lower bound of the remaining minutes (fastest) or kilometres (shortest) from every station to `to`: a
// backward Dijkstra over consecutive stops that ignores waiting, dwell and dates. Infinity means `to` cannot
// be reached at all. Cached because verified searches repeat the same query.
function remainingBound(network, to, mode, cityTransfer) {
  const key = `${mode}:${to}:${cityTransfer}`;
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
  const edges = network.reverse[mode], move = mode === 'shortest' ? 0 : cityTransfer;
  const bound = new Float64Array(network.stations.length).fill(Infinity);
  const queue = new Heap((a, b) => a[0]-b[0]);
  bound[to] = 0; queue.push([0, to]);
  while (queue.length) {
    const [cost, station] = queue.pop();
    if (cost > bound[station]) continue;
    const relax = (next, value) => { if (value < bound[next]) { bound[next] = value; queue.push([value, next]); } };
    const list = edges[station];
    for (let i = 0; i < list.length; i += 2) relax(list[i], cost+list[i+1]);
    if (cityTransfer !== null) for (const other of network.sameCity[station]) relax(other, cost+move);
  }
  network.bounds.set(key, bound);
  return bound;
}

// Minimise actual journey time over ALL first departures in a calendar range.
// A later first departure is a separate resource: an earlier-arriving label
// must never erase it merely because the former reaches an intermediate earlier.
export function searchWindow(network, query, options={}) {
  const started=performance.now();
  const {from,to,date,endDate,arrivalDate,maxTransfers,minTransfer,mode,startMinute=0,endMinute=DAY-1,cityTransfer=null}=query;
  if (!Number.isInteger(from)||!Number.isInteger(to)||!network.stations[from]||!network.stations[to]) throw new Error('请选择有效的出发站和到达站');
  if (from===to) throw new Error('出发站和到达站不能相同');
  if (!Number.isInteger(maxTransfers)||maxTransfers<0||maxTransfers>8) throw new Error('最大换乘次数应为 0–8');
  if (!Number.isInteger(minTransfer)||minTransfer<0||minTransfer>720) throw new Error('换乘时间应为 0–720 分钟');
  if (cityTransfer!==null&&(!Number.isInteger(cityTransfer)||cityTransfer<0||cityTransfer>720)) throw new Error('同城换乘时间应为 0–720 分钟');
  if (!['fastest','shortest'].includes(mode)) throw new Error('查询策略无效');
  if (!Number.isInteger(startMinute)||startMinute<0||startMinute>=DAY) throw new Error('出发时间无效');
  if (!Number.isInteger(endMinute)||endMinute<0||endMinute>=DAY) throw new Error('到达时间无效');
  const queryDay=dateDay(date),lastBoardingDay=dateDay(endDate),lastArrivalDay=dateDay(arrivalDate);
  if(lastBoardingDay<queryDay||lastArrivalDay<lastBoardingDay) throw new Error('出发结束日期不得早于开始日期，最晚到达日期不得早于出发结束日期');
  const boardingEnd=(lastBoardingDay-queryDay+1)*DAY,deadline=(lastArrivalDay-queryDay)*DAY+endMinute+1;
  // Changing station can only improve on staying put, so the cheaper search without it gives an upper bound.
  if(cityTransfer!==null&&options.bound==null) {
    const base=searchWindow(network,{...query,cityTransfer:null},options);
    if(base.found)return searchWindow(network,query,{...options,bound:mode==='shortest'?base.km:base.journeyMinutes});
  }
  const frontiers=Array.from({length:network.stations.length},()=>[]);
  const elapsed=l=>l.time-l.start;
  // Labels are ordered by primary cost plus the remaining bound (A*). The bound is admissible and the
  // secondary costs only grow along a path, so the first label popped at `to` is still the exact optimum.
  const bound=remainingBound(network,to,mode,cityTransfer);
  const compare=mode==='shortest'
    ? (a,b)=>a.estimate-b.estimate||elapsed(a)-elapsed(b)||a.legs-b.legs||a.time-b.time
    : (a,b)=>a.estimate-b.estimate||a.km-b.km||a.legs-b.legs||a.time-b.time;
  const queue=new Heap(compare);
  let generated=0,expanded=0,initialDepartures=0,checks=0,bestPrimary=options.bound??Infinity;
  const primary=l=>mode==='shortest'?l.km:elapsed(l);
  function checkTime() {
    if(++checks%1000!==0)return;
    options.onProgress?.({expanded,generated,initialDepartures});
    if(performance.now()-started>(options.maxMillis??60000)) {
      const error=new Error('搜索超时，请缩小日期范围或减少换乘次数');
      error.code='TIMEOUT';throw error;
    }
  }
  function keep(candidate) {
    checkTime();
    candidate.estimate=primary(candidate)+bound[candidate.station];
    if(bound[candidate.station]===Infinity||candidate.estimate>bestPrimary)return;
    const frontier=frontiers[candidate.station],c=candidate;
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
    frontier.push(c);queue.push(candidate);generated++;
    if(candidate.station===to)bestPrimary=Math.min(bestPrimary,primary(candidate));
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
  // Enumerate every valid first boarding, rather than finding a train after a
  // fixed 08:00 timestamp. The 24:00 boundary belongs to the following date.
  for(const [trainIndex,board] of network.departures[from]) {
    const train=network.trains[trainIndex];
    if(mode==='shortest'&&train.d===false)continue;
    const minute=train.s[board][2];
    let day=Math.max(Math.ceil((startMinute-minute)/DAY),train.fromDay-queryDay);
    const end=Math.min(Math.floor((boardingEnd-1-minute)/DAY),train.toDay-queryDay);
    for(;day<=end;day++) {
      checkTime();
      if(!operates(network,train,queryDay+day))continue;
      initialDepartures++;
      ride(trainIndex,board,minute+day*DAY,day,null);
    }
  }
  while(queue.length) {
    const current=queue.pop();
    if(current.dead)continue;
    if(current.station===to) {
      const legs=[];
      for(let label=current;label;label=label.parent)if(label.leg)legs.push(label.leg);
      legs.reverse();
      return {found:true,legs,departure:current.start,arrival:current.time,
        elapsed:elapsed(current),journeyMinutes:elapsed(current),
        km:Number.isFinite(current.km)?current.km:null,transfers:current.legs-1,
        expanded,generated,initialDepartures,elapsedMs:performance.now()-started};
    }
    if(current.legs>=maxTransfers+1)continue;
    expanded++;checkTime();
    for(const [trainIndex,board] of network.departures[current.station]) {
      const train=network.trains[trainIndex];
      if(mode==='shortest'&&train.d===false)continue;
      const next=nextDeparture(network,train,board,current.ready,deadline-1,queryDay);
      if(next)ride(trainIndex,board,next[0],next[1],current);
    }
    const moved=current.time+cityTransfer;
    if(cityTransfer===null||current.moved||moved>=deadline)continue;
    for(const station of network.sameCity[current.station]) {
      if(station!==to&&network.departures[station].length)keep({...current,station,time:moved,parent:current,leg:null,moved:true,dead:false});
    }
  }
  return {found:false,expanded,generated,initialDepartures,elapsedMs:performance.now()-started};
}

export function expandResult(network, result) {
  if (!result.found) return result;
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
