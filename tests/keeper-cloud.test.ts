import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudHealth} from '../keeper/cloud-health.js';

const now=Date.now();
const snapshot={mode:'observation',at:new Date(now).toISOString(),block:'74600000',vault:{entriesOpen:false},
  members:Array.from({length:100},(_,i)=>({id:String(i+1),decision:{state:'ready'}}))};
test('cloud health reports only a fresh complete observation from this process and mode',()=>{
  assert.equal(cloudHealth(snapshot,'observation',now-1000,now).ok,true);
  for(const raw of [undefined,{}, {...snapshot,members:snapshot.members.slice(1)}, {...snapshot,at:new Date(now-100_000).toISOString()}, {...snapshot,at:new Date(now+10_000).toISOString()}])assert.equal(cloudHealth(raw,'observation',now-1000,now).ok,false);
  assert.equal(cloudHealth(snapshot,'execution',now-1000,now).ok,false);
  assert.equal(cloudHealth(snapshot,'observation',now+1,now).ok,false);
});
test('cloud health rejects duplicate members and exposes a completely blocked worker as unhealthy',()=>{
  assert.equal(cloudHealth({...snapshot,members:Array(100).fill(snapshot.members[0])},'observation',now-1000,now).ok,false);
  const blocked={...snapshot,members:snapshot.members.map(m=>({...m,decision:{state:'blocked'}}))};
  assert.equal(cloudHealth(blocked,'observation',now-1000,now).ok,false);
});
