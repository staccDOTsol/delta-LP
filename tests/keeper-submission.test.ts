import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keccak256,toHex,type Hex} from 'viem';
import {Journal,recover} from '../keeper/journal.js';
import {submitPrepared,type PreparedCall,type SubmissionPort} from '../keeper/submission.js';

const address='0x0000000000000000000000000000000000000010' as Hex;
const prepared=(member=1):PreparedCall=>({call:{target:'controller',name:'reconcile',args:[],member:BigInt(member),reason:'fixture',expiresAt:2000},tx:{to:address,data:'0x'},gas:10n});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'delta-nonce-'));
  const journal=new Journal(dir,address,address),signed:number[]=[],broadcast:Hex[]=[];
  let nonce=4,advance=0,confirmed=false;
  const known=new Set<Hex>();
  const port:SubmissionPort={
    receipt:async hash=>confirmed&&known.has(hash)?{success:true,block:10n,blockHash:keccak256('0xab'),cost:5n}:null,
    transactionKnown:async hash=>known.has(hash),nonce:async()=>nonce,balance:async()=>1000n,
    sign:async(_p,n)=>{signed.push(n);return toHex(n,{size:8});},
    broadcast:async raw=>{
      // Verify durable reservation precedes the outbound request.
      const saved=JSON.parse(readFileSync(journal.path,'utf8'));
      assert.ok(saved.items.some((i:{raw:Hex})=>i.raw===raw));
      broadcast.push(raw);const hash=keccak256(raw);known.add(hash);nonce+=advance;return hash;
    },
  };
  return {dir,journal,port,signed,broadcast,known,setNonce:(n:number)=>{nonce=n;},setAdvance:(n:number)=>{advance=n;},confirm:()=>{confirmed=true;},clean:()=>rmSync(dir,{recursive:true,force:true})};
}
test('lagging pending nonce pauses a batch and resumes after restart without signing a duplicate',async()=>{
  const f=fixture();try{
    const first=await submitPrepared([prepared(1),prepared(2)],f.journal,f.port,1n,10000n,()=>1000);
    assert.deepEqual(first,{submitted:1,pending:true,waitingForRpcNonce:{expected:5,observed:4}});
    assert.deepEqual(f.signed,[4]);assert.equal(f.broadcast.length,1);
    const restarted=new Journal(f.dir,address,address);f.confirm();
    assert.equal(await recover(restarted.state.items[0],f.port,1100),'success');restarted.save();
    // Even after a confirmed receipt, a stale RPC must not cause reuse of nonce 4.
    assert.deepEqual(await submitPrepared([prepared(2)],restarted,f.port,1n,10000n,()=>1100),
      {submitted:0,pending:true,waitingForRpcNonce:{expected:5,observed:4}});
    f.setNonce(5);
    assert.equal((await submitPrepared([prepared(2)],restarted,f.port,1n,10000n,()=>1100)).submitted,1);
    assert.deepEqual(f.signed,[4,5]);assert.equal(f.broadcast.length,2);
    assert.deepEqual(new Journal(f.dir,address,address).state.items.map(i=>i.nonce),[4,5]);
  }finally{f.clean();}
});
test('a caught-up RPC pipelines all 100 reports with consecutive journaled nonces',async()=>{
  const f=fixture();try{
    f.setAdvance(1);
    const result=await submitPrepared(Array.from({length:100},(_,i)=>prepared(i+1)),f.journal,f.port,1n,10000n,()=>1000);
    assert.equal(result.submitted,100);assert.equal(f.broadcast.length,100);
    assert.deepEqual(f.signed,Array.from({length:100},(_,i)=>i+4));
    assert.equal(new Journal(f.dir,address,address).state.items.length,100);
  }finally{f.clean();}
});
test('a forward nonce jump stops before another signature and remains blocked after restart',async()=>{
  const f=fixture();try{
    f.setAdvance(2);
    await assert.rejects(submitPrepared([prepared(1),prepared(2)],f.journal,f.port,1n,10000n,()=>1000),/advanced outside its journal/);
    assert.deepEqual(f.signed,[4]);assert.equal(f.broadcast.length,1);
    f.confirm();await recover(f.journal.state.items[0],f.port,1100);f.journal.save();
    const restarted=new Journal(f.dir,address,address);
    await assert.rejects(submitPrepared([prepared(2)],restarted,f.port,1n,10000n,()=>1100),/expected 5, observed 6/);
    assert.deepEqual(f.signed,[4]);
  }finally{f.clean();}
});
test('a lost submission response preserves the same hash and blocks later calls until reconciliation',async()=>{
  const f=fixture();try{
    const send=f.port.broadcast;
    f.port.broadcast=async raw=>{await send(raw);throw new Error('response lost');};
    await assert.rejects(submitPrepared([prepared(1),prepared(2)],f.journal,f.port,1n,10000n,()=>1000),/response lost/);
    const restarted=new Journal(f.dir,address,address);
    assert.equal(await recover(restarted.state.items[0],f.port,1100),'pending');
    assert.deepEqual(await submitPrepared([prepared(2)],restarted,f.port,1n,10000n,()=>1100),{submitted:0,pending:true});
    assert.equal(f.broadcast.length,1);assert.deepEqual(f.signed,[4]);
  }finally{f.clean();}
});
test('expiry during balance lookup or signing prevents reservation and broadcast',async()=>{
  for(const expireDuring of ['balance','sign']){
    const f=fixture();try{
      let now=1000;
      if(expireDuring==='balance')f.port.balance=async()=>{now=2000;return 1000n;};
      else f.port.sign=async()=>{now=2000;return '0x1234';};
      assert.equal((await submitPrepared([prepared()],f.journal,f.port,1n,10000n,()=>now)).submitted,0);
      assert.equal(f.broadcast.length,0);assert.equal(f.journal.state.items.length,0);
    }finally{f.clean();}
  }
});
test('recovery waits on a lagging nonce, but expiration and unexpected advancement still stop it',async()=>{
  const f=fixture();try{
    const raw='0x1234' as Hex;
    const item={raw,hash:keccak256(raw),nonce:5,expiresAt:2000,maxCost:'10',callId:keccak256('0xab'),status:'prepared' as const};
    f.journal.reserve(item,10000n);
    assert.equal(await recover(item,f.port,1000),'pending');assert.equal(f.broadcast.length,0);
    await assert.rejects(recover(item,f.port,2000),/expired/);
    f.setNonce(6);await assert.rejects(recover(item,f.port,1000),/nonce changed/);
    assert.equal(f.broadcast.length,0);
  }finally{f.clean();}
});
