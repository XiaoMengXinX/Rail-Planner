import test from 'node:test';
import assert from 'node:assert/strict';
import {convert,readTrainCodes} from '../lib/lltskb-db.mjs';
import {createNetwork,searchWindow,PLAIN_TYPES} from '../web/router.mjs';

const b255=n=>[Math.floor(n/255),n%255];
const date=n=>Array.from({length:4},(_,i)=>Math.floor(n/128**i)%128);
function index(names) {
  return Uint8Array.from([names.length>>8,names.length&255,...names.flatMap(name=>{
    const bytes=[...new TextEncoder().encode(name)];
    return [bytes.length>>8,bytes.length&255,...bytes];
  })]);
}

test('new codes survive timetable decoding and keep their own service dates',()=>{
  const names=['K101','V101','T102','N102','Y103B'];
  const files=new Map([
    ['ver.txt',new TextEncoder().encode('20261113')],['s.i',index(['A','B'])],['t.i',index(names)],
    ['t.rule',new TextEncoder().encode('1 1')],['plat.dat',new Uint8Array(4)],
    ['xw.dat',new Uint8Array(2)],['sch.dat',new Uint8Array()],['sn.dat',new Uint8Array(4)],
  ]);
  for(let shard=0;shard<20;shard++)files.set(`t${shard}.dat`,new Uint8Array());
  names.forEach((name,id)=>{
    const reformed=name.startsWith('V')||name.startsWith('N');
    files.set(`t${(id+1)%20}.dat`,Uint8Array.from([
      ...b255(id),0,...b255(0),...date(reformed?20261125:20261101),...date(reformed?20261231:20261124),
      ...b255(0),...b255(2),...b255(0),8,0,0,...b255(0),...b255(1),10,0,0,...b255(100),
    ]));
  });
  assert.deepEqual([...readTrainCodes(files)],['K101','V101','T102','N102','Y103']);
  const data=convert(files);
  assert.deepEqual(data.trains.map(train=>train.c[0]),['K101','V101','T102','N102','Y103']);
  const network=createNetwork(data);
  for(const [day,types,code] of [['2026-11-24','K','K101'],['2026-11-24','T','T102'],
    ['2026-11-25','V','V101'],['2026-11-25','N','N102']]) {
    const query={from:0,to:1,date:day,arrivalDate:day,maxTransfers:0,minTransfer:0,mode:'fastest',types};
    const result=searchWindow(network,query);
    assert.equal(result.found,true);
    assert.equal(network.trains[result.legs[0].trainIndex].c[0],code);
    assert.equal(searchWindow(network,{...query,types:PLAIN_TYPES}).found,true);
    const otherDay=day==='2026-11-24'?'2026-11-25':'2026-11-24';
    assert.equal(searchWindow(network,{...query,date:otherDay,arrivalDate:otherDay}).found,false);
  }
});
