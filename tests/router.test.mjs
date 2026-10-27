import test from 'node:test';
import assert from 'node:assert/strict';
import {createNetwork,search,expandResult} from '../web/router.mjs';

const stop=(station,arrival,departure,km)=>[station,arrival,departure,km,'',0];
const train=(id,stops,extra={})=>({id,n:`G${id}`,c:[`G${id}`],f:20260101,t:20261231,r:0,s:stops,...extra});
const net=(trains,rules=[[1,1]])=>createNetwork({stations:['A','B','C','D','E'].map(n=>[n,'','']),rules,trains});
const query=(extra={})=>({from:0,to:2,date:'2026-10-28',startMinute:420,maxTransfers:1,minTransfer:10,horizonHours:24,mode:'fastest',...extra});

test('earliest arrival and shortest distance select different feasible routes',()=>{
  const n=net([train(1,[stop(0,450,450,0),stop(2,600,-1,200)]),
    train(2,[stop(0,460,460,0),stop(1,510,-1,30)]),
    train(3,[stop(1,540,540,0),stop(2,660,-1,40)])]);
  assert.equal(search(n,query()).arrival,600);
  const r=search(n,query({mode:'shortest'}));
  assert.equal(r.km,70);assert.equal(r.transfers,1);
  assert.equal(search(n,query({mode:'shortest',maxTransfers:0})).km,200);
});

test('transfer buffer, missed connection, horizon and no-route handling',()=>{
  const n=net([train(1,[stop(0,450,450,0),stop(1,500,-1,10)]),train(2,[stop(1,505,505,0),stop(2,600,-1,20)])]);
  assert.equal(search(n,query({minTransfer:5})).found,true);
  assert.equal(search(n,query({minTransfer:6})).found,false);
  assert.equal(search(n,query({minTransfer:6,horizonHours:48})).arrival,2040);
  assert.equal(search(n,query({maxTransfers:0})).found,false);
});

test('later cheaper labels survive and the train can be boarded en route',()=>{
  const n=net([train(1,[stop(0,450,450,0),stop(1,500,-1,100)]),
    train(2,[stop(0,460,460,0),stop(1,520,-1,10)]),
    train(3,[stop(3,400,400,0),stop(1,540,550,200),stop(2,600,-1,220)])]);
  assert.equal(search(n,query({mode:'shortest'})).km,30);
});

test('service dates are checked at origin, including trains from the previous day',()=>{
  const n=net([train(1,[stop(3,1380,1380,0),stop(0,1500,1510,100),stop(2,1620,-1,150)],{f:20261027,t:20261027})]);
  const r=expandResult(n,search(n,query({startMinute:30,maxTransfers:0})));
  assert.equal(r.arrival,180);assert.equal(r.departure,70);assert.equal(r.km,50);
  assert.equal(search(n,query({date:'2026-10-29',startMinute:30})).found,false);
});

test('period bitmasks use days since valid_from and support >32-bit masks',()=>{
  const n=net([train(1,[stop(0,450,450,0),stop(2,500,-1,100)],{f:20261027,t:20261028,r:1})],[[1,1],[2,1]]);
  assert.equal(search(n,query()).found,false);
  assert.equal(search(n,query({date:'2026-10-27'})).found,true);
  const wide=net([train(1,[stop(0,450,450,0),stop(2,500,-1,100)],{f:20260918,t:20261028,r:1})],[[1,1],[50,2**40]]);
  assert.equal(search(wide,query()).found,true);
});

test('zero-minute transfers and repeated stops do not create a cheaper cycle',()=>{
  const n=net([train(1,[stop(0,450,450,0),stop(1,500,500,10),stop(0,550,550,20),stop(2,600,-1,30)])]);
  const r=search(n,query({minTransfer:0,maxTransfers:8}));
  assert.equal(r.km,10);assert.equal(r.transfers,0);
  assert.equal(r.departure,550);
});

test('invalid input is rejected',()=>{
  const n=net([]);
  assert.throws(()=>search(n,query({from:2})),/不能相同/);
  assert.throws(()=>search(n,query({maxTransfers:9})),/0–8/);
});

test('missing mileage is never treated as zero-cost travel',()=>{
  const n=net([train(1,[stop(0,450,450,0),stop(2,500,-1,0)],{d:false}),
    train(2,[stop(0,450,450,0),stop(2,550,-1,100)])]);
  const fastest=expandResult(n,search(n,query()));
  assert.equal(fastest.arrival,500);assert.equal(fastest.km,null);
  assert.equal(fastest.legs[0].stops[1].km,null);
  assert.equal(search(n,query({mode:'shortest'})).km,100);
  assert.equal(search(net([n.trains[0]]),query({mode:'shortest'})).found,false);
});

// Exhaustive reference enumerates every service occurrence and downstream stop,
// without a heap or dominance pruning. It provides an independent optimum.
function exhaustive(n,q) {
  let best=null;
  function visit(station,time,km,legs) {
    if(station===q.to) {
      const candidate={arrival:time,km,transfers:legs-1};
      const a=q.mode==='fastest'?[time,km,legs]:[km,time,legs];
      if(!best || a[0]<best.key[0] || a[0]===best.key[0]&&(a[1]<best.key[1] || a[1]===best.key[1]&&a[2]<best.key[2])) best={...candidate,key:a};
      return;
    }
    if(legs>q.maxTransfers)return;
    const ready=time+(legs?q.minTransfer:0),deadline=q.startMinute+q.horizonHours*60;
    for(const t of n.trains)for(let i=0;i<t.s.length-1;i++)if(t.s[i][0]===station&&t.s[i][2]>=0) {
      for(let day=-1;day<=1;day++) {
        const dep=t.s[i][2]+day*1440;
        if(dep<ready||dep>deadline)continue;
        for(let j=i+1;j<t.s.length;j++) {
          const arrival=t.s[j][1]+day*1440;
          if(arrival>=dep&&arrival<=deadline)visit(t.s[j][0],arrival,km+t.s[j][3]-t.s[i][3],legs+1);
        }
      }
    }
  }
  visit(q.from,q.startMinute,0,0);return best;
}

test('both objectives match exhaustive enumeration on 100 generated networks',()=>{
  let seed=123456;
  const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(let sample=0;sample<100;sample++) {
    const trains=[];
    for(let i=0;i<8;i++) {
      const a=rand(4);let b=rand(3);if(b>=a)b++;
      const departure=430+rand(500),arrival=departure+10+rand(150);
      trains.push(train(i,[stop(a,departure,departure,0),stop(b,arrival,-1,1+rand(200))]));
    }
    const n=net(trains);
    for(const mode of ['fastest','shortest']) {
      const q=query({mode,maxTransfers:2,minTransfer:rand(25)}),expected=exhaustive(n,q),actual=search(n,q);
      assert.equal(actual.found,!!expected,`sample ${sample}`);
      if(expected)for(const key of ['arrival','km','transfers'])assert.equal(actual[key],expected[key],`${sample} ${mode} ${key}`);
    }
  }
});
