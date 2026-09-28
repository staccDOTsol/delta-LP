import test from 'node:test';
import assert from 'node:assert/strict';
import type {EIP1193Provider} from 'viem';
import {NeutralClient} from '../web/trading/neutral-client.js';
import {legacyNeutralDeployment} from '../strategy/legacy-neutral-deployment.js';
import {neutralDeployments} from '../strategy/neutral-deployment.js';

test('previous vault remains addressable for recovery but cannot accept new entries through this client',async()=>{
  assert.notEqual(neutralDeployments[0].address,legacyNeutralDeployment.address);
  const provider={request:async()=>{throw new Error('Must not prompt the wallet');}} as unknown as EIP1193Provider;
  const client=new NeutralClient(provider,'0x1111111111111111111111111111111111111111',legacyNeutralDeployment);
  await assert.rejects(client.enter('1'),/recovery only/);
  await assert.rejects(client.openEntries(),/recovery only/);
  assert.throws(()=>new NeutralClient(provider,client.address,{...legacyNeutralDeployment,runtimeCodeHash:`0x${'00'.repeat(32)}`}),/Unknown neutral vault/);
});
