import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

test('vendored signer matches the pinned upstream artifact hashes',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../public/vendor/lighter/manifest.json',import.meta.url),'utf8'));
  for(const [name,value] of Object.entries(manifest.files) as [string,{sha256:string}][]){
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../public/vendor/lighter/${name}`,import.meta.url))).digest('hex'),value.sha256);
  }
});
test('real WASM signer encodes orders, margin and USDG withdrawals without network access',()=>{
  const script=`
    import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
    globalThis.window=globalThis;vm.runInThisContext(readFileSync('public/vendor/lighter/wasm_exec.js','utf8'));
    const go=new Go();const {instance}=await WebAssembly.instantiate(readFileSync('public/vendor/lighter/main.wasm'),go.importObject);void go.run(instance);
    const call=async(name,...args)=>(await globalThis[name](...args))();
    const client=await call('_createClient','11'.repeat(32),466324,100000,0,42,false);assert.ok(client.pk);assert.ok(!client.error);
    for(const ask of [0,1])for(const reduce of [0,1]){
      const signed=await call('_signCreateOrder',100000,0,12345,'50','265000',ask,0,0,reduce,'0',0,1);
      const tx=JSON.parse(signed.txInfo);assert.equal(tx.ApiKeyIndex,42);assert.equal(tx.AccountIndex,100000);assert.equal(tx.IsAsk,ask);assert.equal(tx.ReduceOnly,reduce);assert.equal(tx.BaseAmount,50);assert.equal(tx.Price,265000);assert.equal(tx.TimeInForce,0);assert.equal(tx.Type,0);assert.equal(tx.OrderExpiry,0);assert.equal(tx.Nonce,1);assert.ok(tx.Sig);
    }
    const margin=JSON.parse((await call('_signUpdateLeverage',100000,0,3334,1,2)).txInfo);assert.equal(margin.InitialMarginFraction,3334);assert.equal(margin.MarginMode,1);
    const withdrawal=JSON.parse((await call('_signWithdraw',100000,3,0,'5000000',3)).txInfo);assert.equal(withdrawal.AssetIndex,3);assert.equal(withdrawal.RouteType,0);assert.equal(withdrawal.Amount,5000000);
    const first=await call('_signCreateOrder',100000,0,12345,'50','265000',1,0,0,0,'0',0,1);
    await call('_createClient','11'.repeat(32),304,100000,0,42,false);
    const other=await call('_signCreateOrder',100000,0,12345,'50','265000',1,0,0,0,'0',0,1);assert.notEqual(first.txHash,other.txHash);
    process.exit(0);
  `;
  execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),timeout:10000,stdio:'pipe'});
});
test('keeper bootstrap recovers the wallet-derived member key and signs only the requested margin setup',()=>{
  const script=`
    import assert from 'node:assert/strict';
    import {privateKeyToAccount} from 'viem/accounts';
    import {setupSigner} from './keeper/setup-signer.ts';
    globalThis.fetch=async()=>{throw new Error('Network access is forbidden in this signer test.');};
    const owner=privateKeyToAccount('0x'+'11'.repeat(32));
    const member={id:1n,custody:'0x0000000000000000000000000000000000000010',accountIndex:100000,market:0};
    const a=await setupSigner(owner,member,1n),b=await setupSigner(owner,member,2n);assert.notEqual(a.publicKey,b.publicKey);
    const recovered=await setupSigner(owner,member,1n);assert.equal(a.publicKey,recovered.publicKey);
    const signed=await recovered.margin(200,7),tx=JSON.parse(signed.info);
    assert.equal(tx.AccountIndex,100000);assert.equal(tx.ApiKeyIndex,42);assert.equal(tx.InitialMarginFraction,200);assert.equal(tx.MarginMode,0);assert.equal(tx.Nonce,7);assert.ok(tx.Sig);assert.ok(signed.hash);
    process.exit(0);
  `;
  execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),timeout:10000,stdio:'pipe'});
});
