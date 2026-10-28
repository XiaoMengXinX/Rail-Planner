import test from 'node:test';
import assert from 'node:assert/strict';
import {createNetwork,searchWindow,expandResult} from '../web/router.mjs';

const stop=(station,arrival,departure,km)=>[station,arrival,departure,km,'',0];
const train=(id,stops,extra={})=>({id,n:`G${id}`,c:[`G${id}`],f:20260101,t:20261231,r:0,s:stops,...extra});
const net=(trains,rules=[[1,1]])=>createNetwork({stations:['A','B','C','D','E'].map(n=>[n,'','']),rules,trains});
const query=(extra={})=>({from:0,to:2,date:'2026-10-28',arrivalDate:'2026-10-28',maxTransfers:1,minTransfer:10,mode:'fastest',...extra});

test('fastest and shortest select different feasible routes',()=>{
  const n=net([train(1,[stop(0,450,450,0),stop(2,600,-1,200)]),
    train(2,[stop(0,460,460,0),stop(1,510,-1,30)]),
    train(3,[stop(1,540,540,0),stop(2,660,-1,40)])]);
  assert.equal(searchWindow(n,query()).journeyMinutes,150);
  const r=searchWindow(n,query({mode:'shortest'}));
  assert.equal(r.km,70);assert.equal(r.transfers,1);
  assert.equal(searchWindow(n,query({mode:'shortest',maxTransfers:0})).km,200);
});

test('transfer buffer, missed connection, arrival date and no-route handling',()=>{
  const n=net([train(1,[stop(0,450,450,0),stop(1,500,-1,10)]),train(2,[stop(1,505,505,0),stop(2,600,-1,20)])]);
  assert.equal(searchWindow(n,query({minTransfer:5})).found,true);
  assert.equal(searchWindow(n,query({minTransfer:6})).found,false);
  assert.equal(searchWindow(n,query({minTransfer:6,arrivalDate:'2026-10-29'})).arrival,2040);
  assert.equal(searchWindow(n,query({maxTransfers:0})).found,false);
});

test('later cheaper labels survive and a train can be boarded en route',()=>{
  const n=net([train(1,[stop(0,450,450,0),stop(1,500,-1,100)]),
    train(2,[stop(0,460,460,0),stop(1,520,-1,10)]),
    train(3,[stop(3,400,400,0),stop(1,540,550,200),stop(2,600,-1,220)])]);
  assert.equal(searchWindow(n,query({mode:'shortest'})).km,30);
});

test('service dates are checked at origin, including trains from the previous day',()=>{
  const n=net([train(1,[stop(3,1380,1380,0),stop(0,1500,1510,100),stop(2,1620,-1,150)],{f:20261027,t:20261027})]);
  const r=expandResult(n,searchWindow(n,query({maxTransfers:0})));
  assert.equal(r.arrival,180);assert.equal(r.departure,70);assert.equal(r.km,50);
  assert.equal(searchWindow(n,query({date:'2026-10-29',arrivalDate:'2026-10-29'})).found,false);
});

test('period bitmasks use days since valid_from and support >32-bit masks',()=>{
  const n=net([train(1,[stop(0,450,450,0),stop(2,500,-1,100)],{f:20261027,t:20261028,r:1})],[[1,1],[2,1]]);
  assert.equal(searchWindow(n,query()).found,false);
  assert.equal(searchWindow(n,query({date:'2026-10-27',arrivalDate:'2026-10-27'})).found,true);
  const wide=net([train(1,[stop(0,450,450,0),stop(2,500,-1,100)],{f:20260918,t:20261028,r:1})],[[1,1],[50,2**40]]);
  assert.equal(searchWindow(wide,query()).found,true);
});

test('zero-minute transfers and repeated stops do not create a cheaper cycle',()=>{
  const n=net([train(1,[stop(0,450,450,0),stop(1,500,500,10),stop(0,550,550,20),stop(2,600,-1,30)])]);
  const r=searchWindow(n,query({minTransfer:0,maxTransfers:8}));
  assert.equal(r.km,10);assert.equal(r.transfers,0);assert.equal(r.departure,550);
});

test('missing mileage is never treated as zero-cost travel',()=>{
  const n=net([train(1,[stop(0,450,450,0),stop(2,500,-1,0)],{d:false}),
    train(2,[stop(0,450,450,0),stop(2,550,-1,100)])]);
  const fastest=expandResult(n,searchWindow(n,query()));
  assert.equal(fastest.arrival,500);assert.equal(fastest.km,null);
  assert.equal(fastest.legs[0].stops[1].km,null);
  assert.equal(searchWindow(n,query({mode:'shortest'})).km,100);
  assert.equal(searchWindow(net([n.trains[0]]),query({mode:'shortest'})).found,false);
});
