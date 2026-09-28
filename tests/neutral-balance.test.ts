import test from 'node:test';
import assert from 'node:assert/strict';
import {type EIP1193Provider} from 'viem';
import {NeutralClient} from '../web/trading/neutral-client.js';
import {neutralDeployments} from '../strategy/neutral-deployment.js';

test('USDG balance loads independently of unavailable pool and venue reads',async()=>{
  const original=globalThis.fetch,calls:string[]=[];
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(String(options?.body));calls.push(body.method);
    if(body.method==='eth_chainId')return Response.json({jsonrpc:'2.0',id:body.id,result:'0x1237'});
    if(body.method==='eth_call'&&body.params[0].to.toLowerCase()==='0x5fc5360d0400a0fd4f2af552add042d716f1d168'){
      assert.ok(body.params[0].data.startsWith('0x70a08231'));
      return Response.json({jsonrpc:'2.0',id:body.id,result:`0x${(28_900000n).toString(16).padStart(64,'0')}`});
    }
    throw new Error('Pool and venue unavailable');
  };
  try{
    const provider={request:async()=>{throw new Error('Balance must not prompt the wallet');}} as unknown as EIP1193Provider;
    const client=new NeutralClient(provider,'0x1111111111111111111111111111111111111111',neutralDeployments[0]);
    assert.equal(await client.walletBalance(),28_900000n);
    assert.deepEqual(calls.sort(),['eth_call','eth_chainId']);
  }finally{globalThis.fetch=original;}
});
