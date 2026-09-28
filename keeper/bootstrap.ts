import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {keccak256,type PrivateKeyAccount} from 'viem';
import {z} from 'zod';
import {accountSchema,exactUnits,transactionState} from '../strategy/execution.js';
import {registeredMemberKey,memberMarginPlan} from '../strategy/member-setup.js';
import {memberMarketSchema} from '../strategy/member-reconciliation.js';
import {LIGHTER_API} from '../strategy/lighter.js';
import type {Cycle} from './observe.js';
import type {Call} from './model.js';
import {marketData,venue} from './rpc.js';
import {setupSigner} from './setup-signer.js';

const pendingSchema=z.record(z.object({hash:z.string().min(1),generation:z.string().regex(/^\d+$/),accountIndex:z.number().int(),nonce:z.number().int(),status:z.enum(['prepared','confirmed'])}));
/** Optional owner bootstrap. It never rotates a previously configured key,
 * loosens a user's redemption minimum, or transfers funds from the owner's wallet. */
export function bootstrap(account:PrivateKeyAccount,directory:string,enabled:boolean){
  const path=join(directory,'margin-transactions.json');
  const pending=existsSync(path)?pendingSchema.parse(JSON.parse(readFileSync(path,'utf8'))):{};
  const save=()=>{writeFileSync(path+'.tmp',JSON.stringify(pending,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);};
  return async(cycle:Cycle):Promise<{calls:Call[];busy:Set<bigint>;notes:string[]}>=>{
    const calls:Call[]=[],busy=new Set<bigint>(),notes:string[]=[];
    if(!enabled)return {calls,busy,notes};
    const {market:rawMarket}=await marketData(),market=memberMarketSchema.parse(rawMarket);
    if(market.status!=='active'||market.market_config.force_reduce_only)throw new Error('Venue does not permit bootstrap.');
    for(const result of cycle.members){
      const m=result.snapshot;if(!m)continue;
      const call=(name:string,args:readonly unknown[],reason:string)=>{busy.add(m.id);calls.push({target:'controller',member:m.id,name,args,reason,expiresAt:Date.now()+30000});};
      // Initial empty accounts can accept the first internal allocation, whose
      // member cash creates their Lighter accounts. Reports are required first.
      if(!m.bound){
        if(!m.enabled&&m.requestedAction===0n&&m.reportSequence>0n&&m.observedAt>=BigInt(Math.floor(Date.now()/1000)-30))call('setEnabled',[m.id,true],'Enable the fresh empty member for its first allocation.');
        continue;
      }
      if(m.executedPriorityCount<m.priorityEnd)continue;
      if(m.setup.generation===0n){
        if(m.requestedAction!==m.confirmedAction||m.position!==0n)continue;
        const existing=registeredMemberKey(await venue(`apikeys?account_index=${m.accountIndex}&api_key_index=255`),m.accountIndex);
        if(existing){notes.push(`Member ${m.id}: an existing venue key requires operator review.`);busy.add(m.id);continue;}
        const signer=await setupSigner(account,m,1n);
        call('configureVenueKey',[m.id,signer.publicKey,market.min_initial_margin_fraction],'Register the first custody operator key and required margin setting.');
        continue;
      }
      if(m.setup.pending&&m.setup.initialMarginBps!==0){
        busy.add(m.id);
        const key=registeredMemberKey(await venue(`apikeys?account_index=${m.accountIndex}&api_key_index=255`),m.accountIndex);
        if(!key||keccak256(key)!==m.setup.publicKeyHash)continue;
        const body=await venue(`account?by=index&value=${m.accountIndex}`);
        const rows=z.array(accountSchema).parse(body.accounts);
        const owned=rows.find(a=>a.index===m.accountIndex&&a.l1_address.toLowerCase()===m.custody.toLowerCase());
        if(!owned)throw new Error('Bootstrap account identity mismatch.');
        const p=pending[String(m.id)];
        if(p){
          if(p.generation!==String(m.setup.generation)||p.accountIndex!==m.accountIndex)throw new Error('Margin journal generation changed.');
          const tx=await venue(`tx?by=hash&value=${encodeURIComponent(p.hash)}`);
          const status=transactionState(tx,p.hash,m.accountIndex);
          if(status==='failed')throw new Error(`Member ${m.id} margin setup failed; inspect the saved transaction.`);
          if(status!=='executed')continue;
        }
        const row=owned.positions.find(p=>p.market_id===m.market);
        if(row&&row.margin_mode===0&&exactUnits(row.initial_margin_fraction,2)===BigInt(m.setup.initialMarginBps)){
          if(p){p.status='confirmed';save();}busy.delete(m.id);continue;
        }
        if(p)continue; // Never send a second signed margin request after an ambiguous response.
        memberMarginPlan(m,m.setup,owned,market,{code:200,api_keys:[{account_index:m.accountIndex,api_key_index:42,public_key:key}]});
        const signer=await setupSigner(account,m,m.setup.generation);
        if(signer.publicKey!==key)throw new Error('Owner signature cannot recover the registered setup key.');
        const nonce=z.object({nonce:z.number().int().safe().nonnegative()}).parse(await venue(`nextNonce?account_index=${m.accountIndex}&api_key_index=42`)).nonce;
        const signed=await signer.margin(m.setup.initialMarginBps,nonce);
        pending[String(m.id)]={hash:signed.hash,generation:String(m.setup.generation),accountIndex:m.accountIndex,nonce,status:'prepared'};save();
        const form=new FormData();form.set('tx_type','20');form.set('tx_info',signed.info);
        try{await fetch(`${LIGHTER_API}/api/v1/sendTx`,{method:'POST',body:form,signal:AbortSignal.timeout(8000),redirect:'error'});}catch{/* Lookup the persisted hash on the next cycle, never blind retry. */}
        notes.push(`Member ${m.id}: margin transaction recorded; awaiting venue confirmation.`);
      }else if(!m.enabled&&!m.setup.pending&&m.requestedAction===m.confirmedAction&&m.initialMarginBps===market.min_initial_margin_fraction){
        call('setEnabled',[m.id,true],'Re-enable the member after confirmed custody setup.');
      }
    }
    if(!cycle.vault.entriesOpen&&cycle.members.every(m=>m.snapshot?.enabled&&m.snapshot.reportSequence>0n&&!m.snapshot.setup.pending))calls.push({target:'vault',name:'setEntriesOpen',args:[true],reason:'Open collection after all 100 members have initial reports and are enabled.',expiresAt:Date.now()+5000});
    return {calls,busy,notes};
  };
}
