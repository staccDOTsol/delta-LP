import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {rpcEndpoint,defaultRobinhoodRpc} from '../strategy/rpc-config.js';

test('RPC configuration validates HTTPS without exposing credential-bearing URLs in errors',()=>{
  for(const value of ['invalid-secret','http://example.com/key','https://user:secret@example.com/','https://example.com/key#secret']){
    assert.throws(()=>rpcEndpoint(value),e=>e instanceof Error&&e.message==='Invalid Robinhood HTTPS RPC configuration.');
  }
  assert.equal(rpcEndpoint('  https://example.com/key  '),'https://example.com/key');
  assert.equal(rpcEndpoint(),defaultRobinhoodRpc);
});
test('server RPC uses its own environment setting independently of the browser setting',()=>{
  const script="const {serverRpcUrl}=await import('./strategy/server-rpc.ts');if(serverRpcUrl!=='https://example.com/server-only-key')process.exit(1);";
  const r=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,
    ROBINHOOD_RPC_URL:'https://example.com/server-only-key',VITE_ROBINHOOD_RPC_URL:'https://example.com/browser-key'}});
  assert.equal(r.status,0,r.stderr);
});
