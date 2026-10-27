import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createNetwork,searchWindow,operates,dateDay} from '../web/router.mjs';
import {searchVerified,installCalendar} from '../web/verified-search.mjs';
import {normalizeCalendar,fetchServiceCalendar,isKnownCode} from '../lib/service-calendar.mjs';
const stop=(id,arrival,departure,km)=>[id,arrival,departure,km,'',0];
const train=(id,codes,stops,more={})=>({id,n:codes.join('/'),c:codes,f:20260101,t:20261231,r:0,s:stops,...more});
const net=trains=>createNetwork({stations:['A','B','C'].map(n=>[n,'','']),rules:[[1,1]],trains});
const query={from:0,to:2,date:'2026-10-28',endDate:'2026-10-28',arrivalDate:'2026-10-28',maxTransfers:2,minTransfer:10,mode:'fastest'};

test('G2083 real calendar fixture says not running, despite daily offline rules',()=>{
  const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/g2083-diagram.json',import.meta.url)));
  const calendar=normalizeCalendar(raw,'G2082');
  assert.equal(calendar.days['20261028'],'0');
  const n=net([train(6640,['G2082','G2083'],[stop(0,420,420,0),stop(2,480,-1,100)])]);
  assert.equal(searchWindow(n,query).found,true);
  installCalendar(n,calendar);
  assert.equal(searchWindow(n,query).found,false);
});

test('cancelled fastest service is rejected and a confirmed alternative is returned',async()=>{
  const n=net([train(6640,['G2082','G2083'],[stop(0,420,420,0),stop(2,480,-1,100)]),train(1,['G25'],[stop(0,600,600,0),stop(2,720,-1,100)])]);
  const calls=[];
  const result=await searchVerified(n,query,{fetchCalendar:async(code,date)=>{
    calls.push([code,date]);return {code,days:{[date]:code==='G2082'?'0':'1'},checkedAt:'2026-10-28T00:00:00Z'};
  }});
  assert.equal(result.legs[0].name,'G25');assert.equal(result.verification.rejected,1);
  assert.equal(result.verification.status,'confirmed');assert.equal(result.journeyMinutes,120);
  assert.deepEqual(calls,[['G2082','20261028'],['G25','20261028']]);
});

test('each transfer is validated and an origin on the previous day uses its own date',async()=>{
  const n=net([train(1,['K1'],[stop(0,1390,1390,0),stop(1,1450,-1,100)]),
    train(2,['K2'],[stop(0,1380,1380,0),stop(1,1500,1510,100),stop(2,1560,-1,200)],{f:20261027,t:20261027})]);
  const calls=[];
  const result=await searchVerified(n,{...query,from:1},{fetchCalendar:async(code,date)=>{
    calls.push([code,date]);return {code,days:{[date]:'1'},checkedAt:'2026-10-28T00:00:00Z'};
  }});
  assert.equal(result.departure,70);assert.deepEqual(calls,[['K2','20261027']]);
});

test('unknown status, failed API and dates outside calendar fail closed',async()=>{
  const source=()=>net([train(1,['G1'],[stop(0,500,500,0),stop(2,600,-1,100)])]);
  await assert.rejects(()=>searchVerified(source(),query,{fetchCalendar:async()=>{throw new Error('offline');}}),/无法核验/);
  await assert.rejects(()=>searchVerified(source(),query,{fetchCalendar:async code=>({code,days:{20261029:'1'}})}),/不在官方开行日历范围内/);
  await assert.rejects(()=>searchVerified(source(),query,{fetchCalendar:async code=>({code,days:{20261028:'unknown'}})}),/不在官方开行日历范围内/);
});

test('cancellation on one origin date does not exclude the next operating day',async()=>{
  const n=net([train(1,['G1'],[stop(0,500,500,0),stop(2,600,-1,100)])]);
  const r=await searchVerified(n,{...query,endDate:'2026-10-29',arrivalDate:'2026-10-29'},
    {fetchCalendar:async code=>({code,days:{20261028:'0',20261029:'1'}})});
  assert.equal(r.departure,1940);assert.equal(r.verification.rejected,1);
});

test('whole-train sch cancellation and later restoration are applied before routing',()=>{
  const n=net([train(1,['G1'],[stop(0,500,500,0),stop(2,600,-1,100)],
    {x:[[1,20261028,20261030],[2,20261029,20261030]]})]);
  assert.equal(operates(n,n.trains[0],dateDay('2026-10-28')),false);
  assert.equal(operates(n,n.trains[0],dateDay('2026-10-29')),true);
});

test('public API adapter validates response, flags and request destination',async()=>{
  const result=await fetchServiceCalendar('G25','20261028',async(url,init)=>{
    assert.equal(url,'https://mobile.12306.cn/wxxcx/wechat/bigScreen/queryTrainDiagram');
    assert.equal(new URLSearchParams(init.body).get('trainCode'),'G25');
    assert.equal(new URLSearchParams(init.body).get('queryDate'),'20261028');
    return new Response(JSON.stringify({status:true,data:{running_list:[{date:'20261028',flag:'1'}]}}));
  });
  assert.equal(result.days['20261028'],'1');
  assert.throws(()=>normalizeCalendar({status:false},'G25'),/未返回/);
  assert.throws(()=>normalizeCalendar({status:true,data:{running_list:[{date:'20261028',flag:'2'}]}},'G25'),/无法识别/);
});

test('calendar proxy only forwards known codes',()=>{
  const known=new Set(['G25']);
  assert.equal(isKnownCode('G25',known),true);
  assert.equal(isKnownCode('G9999',known),false);
  assert.equal(isKnownCode(['G25'],known),false);
  assert.equal(isKnownCode(null,known),false);
  // Before any timetable is cached, only the code shape is checked; V/N placeholders never pass.
  assert.equal(isKnownCode('G807',null),true);
  assert.equal(isKnownCode('V1049',null),false);
  assert.equal(isKnownCode('G25;DROP',null),false);
});

test('lltskb announcement is parsed despite being invalid JSON',async()=>{
  const {parseAnnouncement}=await import('../lib/database.mjs');
  const text=fs.readFileSync(new URL('./fixtures/android.ver',import.meta.url),'utf8');
  assert.throws(()=>JSON.parse(text));
  assert.deepEqual(parseAnnouncement(text),{version:'20261105',urls:['http://223.107.87.50:8011/an.db','http://down.lltskb.com/an.db']});
  assert.throws(()=>parseAnnouncement('{}'),/无法解析/);
});

test('a train 12306 does not list follows offline rules unless verification is strict',async()=>{
  const unlisted=normalizeCalendar({status:false,errorMsg:'未查询到数据(M0025)'},'S8668','2026-10-28T00:00:00Z');
  assert.equal(unlisted.unlisted,true);
  assert.throws(()=>normalizeCalendar({status:false,errorMsg:'系统繁忙'},'G25'),/未返回/);
  const source=()=>net([train(1,['S8668'],[stop(0,420,420,0),stop(2,480,-1,100)]),train(2,['G25'],[stop(0,600,600,0),stop(2,720,-1,100)])]);
  const fetchCalendar=async(code,date)=>code==='S8668'?unlisted:{code,days:{[date]:'1'}};
  const loose=await searchVerified(source(),query,{fetchCalendar});
  assert.equal(loose.legs[0].name,'S8668');assert.equal(loose.legs[0].unlisted,true);
  assert.equal(loose.verification.status,'partial');
  const strict=await searchVerified(source(),{...query,strict:true},{fetchCalendar});
  assert.equal(strict.legs[0].name,'G25');assert.equal(strict.legs[0].unlisted,false);
  assert.equal(strict.verification.status,'confirmed');
  assert.equal(strict.verification.unlistedRejected,1);assert.equal(strict.verification.rejected,0);
});

test('cheapest seat per train is read from left-ticket rows of the exact station pair',async()=>{
  const {parseFares}=await import('../lib/fares.mjs');
  const payload=JSON.parse(fs.readFileSync(new URL('./fixtures/left-ticket.json',import.meta.url)));
  assert.deepEqual(parseFares(payload,'DBN','LFN'),{G868:{seat:'二等座',price:40},D5852:{seat:'二等座',price:41}});
  const standing={status:true,data:{result:[['','','','K1','','','AAA','BBB',...Array(31).fill(''),'1005000300W005003000'].join('|')]}};
  assert.deepEqual(parseFares(standing,'AAA','BBB'),{K1:{seat:'硬座',price:50}});
  assert.throws(()=>parseFares({status:false},'AAA','BBB'),/未返回/);
});
