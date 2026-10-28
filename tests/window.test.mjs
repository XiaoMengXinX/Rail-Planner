import test from 'node:test';
import assert from 'node:assert/strict';
import {createNetwork,searchWindow,expandResult} from '../web/router.mjs';
const s=(station,arr,dep,km)=>[station,arr,dep,km,'',0];
const train=(id,stops,more={})=>({id,n:`T${id}`,c:[`T${id}`],f:20260101,t:20261231,r:0,s:stops,...more});
const net=(trains,rules=[[1,1]])=>createNetwork({stations:['A','B','C','D'].map(n=>[n,'','']),trains,rules});
const q=(more={})=>({from:0,to:2,date:'2026-10-28',arrivalDate:'2026-10-28',maxTransfers:2,minTransfer:10,mode:'fastest',...more});

test('whole-day fastest means shortest time after boarding, even when arriving later',()=>{
  const n=net([train(1,[s(0,480,480,0),s(2,600,-1,100)]),train(2,[s(0,1080,1080,0),s(2,1140,-1,100)])]);
  const r=searchWindow(n,q());
  assert.equal(r.departure,1080);assert.equal(r.arrival,1140);assert.equal(r.journeyMinutes,60);
});

test('later first departures survive dominance and transfer waiting is counted',()=>{
  const n=net([train(1,[s(0,480,480,0),s(1,540,-1,40)]),train(2,[s(0,600,600,0),s(1,630,-1,40)]),train(3,[s(1,660,660,0),s(2,690,-1,40)])]);
  const r=searchWindow(n,q());
  assert.equal(r.departure,600);assert.equal(r.journeyMinutes,90);assert.equal(r.transfers,1);
  assert.equal(searchWindow(n,q({maxTransfers:0})).found,false);
});

test('same-day and overnight arrival differ; first boarding stays on the departure date',()=>{
  const n=net([train(1,[s(0,500,500,0),s(2,800,-1,100)]),train(2,[s(0,1410,1410,0),s(2,1470,-1,100)]),
    train(3,[s(0,90,90,0),s(2,100,-1,100)],{f:20261029,t:20261029})]);
  assert.equal(searchWindow(n,q()).journeyMinutes,300);
  const r=searchWindow(n,q({arrivalDate:'2026-10-29'}));
  assert.equal(r.departure,1410);assert.equal(r.journeyMinutes,60);
});

test('00:00 is included and a 24:00 first boarding belongs to the next date',()=>{
  const n=net([train(1,[s(0,0,0,0),s(2,20,-1,10)],{f:20261028,t:20261028}),
    train(2,[s(0,1440,1440,0),s(2,1445,-1,10)],{f:20261028,t:20261028})]);
  assert.equal(searchWindow(n,q({arrivalDate:'2026-10-29'})).departure,0);
});

test('calendar rules apply to the origin day of a train that started the day before',()=>{
  const previous=net([train(3,[s(3,1380,1380,0),s(0,1500,1510,100),s(2,1620,-1,150)],{f:20261027,t:20261027,r:1})],[[1,1],[2,1]]);
  assert.equal(expandResult(previous,searchWindow(previous,q())).departure,70);
});

test('unknown distance remains eligible for duration and is excluded from distance objective',()=>{
  const n=net([train(1,[s(0,500,500,0),s(2,520,-1,0)],{d:false}),train(2,[s(0,600,600,0),s(2,660,-1,100)])]);
  assert.equal(searchWindow(n,q()).km,null);
  assert.equal(searchWindow(n,q({mode:'shortest'})).km,100);
});

function exhaustive(n,query) {
  const epoch=value=>Date.parse(value+'T00:00:00Z')/86400000;
  const day0=epoch(query.date),boardEnd=1440,deadline=(epoch(query.arrivalDate)-day0+1)*1440;
  let best=null;
  function visit(station,time,start,km,legs) {
    if(legs&&station===query.to) {
      const key=query.mode==='shortest'?[km,time-start,legs,time]:[time-start,km,legs,time];
      if(!best||key.some((v,i)=>v<best.key[i]&&key.slice(0,i).every((x,j)=>x===best.key[j])))best={key,journeyMinutes:time-start,km,transfers:legs-1,arrival:time};
      return;
    }
    if(legs>=query.maxTransfers+1)return;
    for(const train of n.trains)for(let i=0;i<train.s.length-1;i++) {
      const stop=train.s[i];if(stop[0]!==station||stop[2]<0)continue;
      for(let day=-2;day<Math.ceil(deadline/1440);day++) {
        const dep=stop[2]+day*1440;
        if(dep<0||dep>=deadline||!legs&&dep>=boardEnd||legs&&dep<time+query.minTransfer)continue;
        const origin=day0+day;
        if(origin<train.fromDay||origin>train.toDay)continue;
        const [period,mask]=n.rules[train.r];
        if(period>1&&Math.floor(mask/2**((origin-train.fromDay)%period))%2!==1)continue;
        for(let j=i+1;j<train.s.length;j++) {
          const arrival=train.s[j][1]+day*1440;
          if(arrival>=deadline||arrival<dep)continue;
          visit(train.s[j][0],arrival,legs?start:dep,km+train.s[j][3]-stop[3],legs+1);
        }
      }
    }
  }
  visit(query.from,0,0,0,0);return best;
}

test('whole-window results match an exhaustive time-expanded oracle on 100 networks',()=>{
  let seed=71532;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(let sample=0;sample<100;sample++) {
    const trains=[];
    for(let i=0;i<7;i++) {
      const a=random(4);let b=random(3);if(b>=a)b++;
      const dep=random(1440),arr=dep+10+random(240);
      trains.push(train(i,[s(a,dep,dep,0),s(b,arr,-1,10+random(150))]));
    }
    const n=net(trains);
    for(const mode of ['fastest','shortest']) {
      const query=q({mode,arrivalDate:sample%2?'2026-10-29':'2026-10-28',minTransfer:random(30)});
      const expected=exhaustive(n,query),actual=searchWindow(n,query);
      assert.equal(actual.found,!!expected,`network ${sample}`);
      if(expected)for(const key of ['journeyMinutes','km','transfers','arrival'])assert.equal(actual[key],expected[key],`${sample} ${mode} ${key}`);
    }
  }
});

test('earliest departure time excludes earlier first boardings but not later transfers',()=>{
  const n=net([train(1,[s(0,480,480,0),s(2,540,-1,100)]),train(2,[s(0,600,600,0),s(1,700,-1,50)]),
    train(3,[s(1,720,720,0),s(2,760,-1,50)])]);
  assert.equal(searchWindow(n,q()).departure,480);
  const r=searchWindow(n,q({startMinute:481}));
  assert.equal(r.departure,600);assert.equal(r.arrival,760);assert.equal(r.transfers,1);
  assert.equal(searchWindow(n,q({startMinute:600})).departure,600);
  assert.equal(searchWindow(n,q({startMinute:601})).found,false);
});

test('same-city transfers change station only when allowed and after their own minimum',()=>{
  const n=createNetwork({stations:[['A','','',''],['B1','','',''],['B2','','',''],['C','','','']],groups:[[1,2]],rules:[[1,1]],trains:[
    train(1,[s(0,480,480,0),s(1,540,-1,100)]),train(2,[s(2,610,610,0),s(3,700,-1,100)])]});
  const query={from:0,to:3,date:'2026-10-28',arrivalDate:'2026-10-28',maxTransfers:1,minTransfer:10,mode:'fastest'};
  assert.equal(searchWindow(n,query).found,false);
  const r=searchWindow(n,{...query,cityTransfer:60});
  assert.equal(r.transfers,1);assert.equal(r.legs[1].board,0);assert.equal(r.arrival,700);
  assert.equal(searchWindow(n,{...query,cityTransfer:71}).found,false);
});

test('latest arrival time is inclusive and applies on the arrival date',()=>{
  const n=net([train(1,[s(0,480,480,0),s(2,540,-1,100)]),train(2,[s(0,600,600,0),s(2,630,-1,100)])]);
  assert.equal(searchWindow(n,q()).departure,600);
  assert.equal(searchWindow(n,q({endMinute:629})).departure,480);
  assert.equal(searchWindow(n,q({endMinute:540})).departure,480);
  assert.equal(searchWindow(n,q({endMinute:539})).found,false);
});
