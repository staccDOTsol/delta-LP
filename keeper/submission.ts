import {keccak256,type Hex} from 'viem';
import {callIdentity,type Call} from './model.js';
import {Journal,recover,type RecoveryPort} from './journal.js';

export type PreparedCall={call:Call;tx:{to:Hex;data:Hex};gas:bigint};
export type SubmissionPort=RecoveryPort&{
  balance:()=>Promise<bigint>;
  sign:(prepared:PreparedCall,nonce:number,gasPrice:bigint)=>Promise<Hex>;
};

/** A lagging pending nonce is not evidence of a second signer. Wait without
 * reserving/signing another transaction; reconcile the journal on the next cycle.
 * A nonce beyond our journaled sequence still requires operator reconciliation. */
export async function submitPrepared(prepared:(PreparedCall|null)[],journal:Journal,port:SubmissionPort,
  gasPrice:bigint,budget:bigint,now=Date.now){
  if(journal.state.items.some(i=>i.status==='prepared'))return {submitted:0,pending:true};
  if(journal.state.items.some(i=>i.status==='reverted'))throw new Error('A reverted keeper transaction requires operator review.');
  const networkNonce=await port.nonce();
  const journalNext=journal.state.items.reduce((next,item)=>Math.max(next,item.nonce+1),0);
  let nonce=journal.state.items.length?journalNext:networkNonce,submitted=0;
  if(!Number.isSafeInteger(nonce)||nonce<0)throw new Error('Invalid keeper nonce.');
  const check=(observed:number)=>{
    if(!Number.isSafeInteger(observed)||observed<0)throw new Error('Invalid RPC nonce.');
    if(observed>nonce)throw new Error(`Keeper nonce advanced outside its journal (expected ${nonce}, observed ${observed}); reconcile the account before resuming.`);
    return observed===nonce;
  };
  const waiting=(observed:number)=>({submitted,pending:true,waitingForRpcNonce:{expected:nonce,observed}});
  if(!check(networkNonce))return waiting(networkNonce);
  for(const p of prepared){
    if(!p||now()>=p.call.expiresAt)continue;
    const observed=await port.nonce();
    if(!check(observed))return waiting(observed);
    if(await port.balance()<p.gas*gasPrice)throw new Error('Insufficient keeper gas.');
    // Expiry is checked again after RPC reads and signing, before reservation.
    if(now()>=p.call.expiresAt)continue;
    const raw=await port.sign(p,nonce,gasPrice);
    if(now()>=p.call.expiresAt)continue;
    const item={hash:keccak256(raw),raw,nonce,expiresAt:p.call.expiresAt,maxCost:String(p.gas*gasPrice),
      callId:callIdentity(p.call),status:'prepared' as const};
    journal.reserve(item,budget);
    // Journal + exact raw hash exist on disk before any network submission.
    await recover(item,port,now());journal.save();nonce++;submitted++;
  }
  return {submitted,pending:journal.state.items.some(i=>i.status==='prepared')};
}
