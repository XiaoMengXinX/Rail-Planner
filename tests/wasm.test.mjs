import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createNetwork,searchWindow} from '../web/router.mjs';
import {wasmRouter} from '../web/router-wasm.mjs';

const bytes=fs.readFileSync(new URL('../web/router.wasm',import.meta.url));
const code=n=>`${'GDCZTKS'[n%7]}${n}`;

function randomNetwork(seed) {
  const random=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
  const int=n=>Math.floor(random()*n);
  const stations=Array.from({length:24},(_,i)=>[`S${i}`,'','',`T${i}`]);
  const rules=[[1,1],[2,1],[3,5],[7,0b1011011]];
  const trains=Array.from({length:120},(_,id)=>{
    let station=int(24),minute=int(1440),km=0;
    const s=[];
    for(let i=0,n=2+int(5);i<n;i++) {
      const arrival=minute;minute+=i?2+int(10):0;
      s.push([station,arrival,i<n-1?minute:-1,km,'',0]);
      station=(station+1+int(5))%24;minute+=20+int(240);km+=10+int(300);
    }
    const cancels=random()<0.2?[[int(3),'20261028','20261030']]:[];
    return {id,n:code(id),c:[code(id%90)],f:'20261001',t:'20261231',r:int(rules.length),s,x:cancels,...(random()<0.1?{d:false}:{})};
  });
  return createNetwork({stations,rules,trains,groups:[[0,1,2],[5,6],[10,11,12,13]]});
}

test('the WebAssembly router returns exactly what the JS router returns',async()=>{
  for(const seed of [1,2,3]) {
    const network=randomNetwork(seed);
    const search=await wasmRouter(network,bytes);
    network.serviceCalendars=new Map([[code(3),{code:code(3),days:{20261029:'0',20261030:'1'}}],[code(8),{code:code(8),unlisted:true,days:{},excluded:true}]]);
    let found=0;
    for(let from=0;from<24;from+=3) for(let to=1;to<24;to+=4) {
      if(from===to)continue;
      for(const mode of ['fastest','shortest']) for(const cityTransfer of [null,30]) for(const types of [undefined,'ZTKO','GD']) {
        const query={from,to,date:'2026-10-29',arrivalDate:'2026-10-31',maxTransfers:3,minTransfer:10,mode,cityTransfer,types,startMinute:from*30,
          cityPairs:cityTransfer===null?{}:{'1-2':false,'5-6':90}};
        const expected=searchWindow(network,query);
        if(expected.found)found++;
        assert.equal(JSON.stringify(search(query)),JSON.stringify(expected),JSON.stringify(query));
      }
    }
    assert.ok(found>100);
  }
});
