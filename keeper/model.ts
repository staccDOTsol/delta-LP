import {keccak256, toHex, type Address, type Hex} from 'viem';
import {z} from 'zod';
import {accountSchema, assertNoOrders, exactUnits} from '../strategy/execution.js';
import {memberMarketSchema, memberPlan, memberReport, type MemberSnapshot} from '../strategy/member-reconciliation.js';
import {memberSetupReport, type SetupState} from '../strategy/member-setup.js';

export type Report = ReturnType<typeof memberReport>;
export type Action = {nonce:bigint;kind:number;amount:bigint;hash:Hex;block:bigint};
export type Request = {id:bigint;member:bigint;amount:bigint;minimum:bigint;deadline:bigint;createdAt:bigint;redeem:boolean;completed:boolean;batch:bigint};
export type Snapshot = MemberSnapshot & {id:bigint;enabled:boolean;bound:boolean;mappedIndex:number;confirmedAction:bigint;mark:bigint;
  observedAt:bigint;nav:bigint;position:bigint;venueAvailable:bigint;initialMarginBps:number;setup:SetupState;
  pendingWithdrawal:bigint;custodyCash:bigint;actions:Action[];requests:Request[]};
export type Call = {target:'controller'|'vault'|'exit'|'contribution'|'nft';address?:Address;name:string;args:readonly unknown[];member?:bigint;reason:string;expiresAt:number};
export type Decision = {state:'ready';call:Call}|{state:'idle'|'blocked'|'waiting';reason:string};
export type Policy = {maxMemberAssets:bigint;maxOrderNotional:bigint;refreshSeconds:number;cancelAfterSeconds:number};
const digest=(value:unknown)=>keccak256(toHex(JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v)));
const min=(a:bigint,b:bigint)=>a<b?a:b;

/** Evidence comes from confirmed L1 action logs and the corresponding venue API
 * lookup. It establishes processing, never an assumed full order fill. The
 * account snapshot still has to be newer and contain no remaining orders. */
export function actionEvidence(member:Snapshot, responses:Map<string,unknown>) {
  if(member.executedPriorityCount<member.priorityEnd)throw new Error('Priority requests are still pending.');
  const actions=member.actions.filter(a=>a.nonce>member.confirmedAction&&a.nonce<=member.requestedAction);
  const expected=member.requestedAction-member.confirmedAction;
  if(BigInt(actions.length)!==expected||actions.some((a,i)=>a.nonce!==member.confirmedAction+BigInt(i)+1n))throw new Error('Controller action history is incomplete.');
  // Include the most recent confirmed action as a watermark after restart.
  const anchor=member.actions.find(a=>a.nonce===member.confirmedAction);
  if(member.confirmedAction>0n&&!anchor)throw new Error('Confirmed action anchor is missing.');
  // A collection action has no venue transaction of its own. Keep the preceding
  // venue action as well, so collection cannot erase the withdrawal watermark.
  const prior=anchor?.kind===2?[...member.actions].reverse().find(a=>a.nonce<anchor.nonce&&a.kind!==2):undefined;
  const relevant=[...(prior?[prior]:[]),...(anchor?[anchor]:[]),...actions];
  let minimumTransactionTime=0;
  for(const action of relevant){
    if(action.kind===2)continue; // L1 collection is accounted by the confirmed controller cash state.
    const tx=z.object({code:z.literal(200),hash:z.string().min(1),account_index:z.number().int().safe(),
      l1_address:z.string(),status:z.number().int().min(0).max(5),transaction_time:z.number().int().safe().positive(),
      event_info:z.string()}).parse(responses.get(action.hash));
    if(tx.account_index!==member.accountIndex||tx.l1_address.toLowerCase()!==member.custody.toLowerCase())throw new Error('Venue action account identity mismatch.');
    const events=z.record(z.unknown()).parse(JSON.parse(tx.event_info||'{}'));
    if(tx.status===0||events.ae)throw new Error('Venue action failed; operator recovery is required.');
    if(tx.status<2)throw new Error('Venue action has not executed.');
    minimumTransactionTime=Math.max(minimumTransactionTime,tx.transaction_time);
  }
  return {minimumTransactionTime,evidenceHash:digest({member:member.id,actions:relevant,responses:[...responses]})};
}

export function emptyAccountReport(m:Snapshot,rawMarket:unknown,blockTimestamp:bigint):Report {
  const market=memberMarketSchema.parse(rawMarket);
  if(m.bound||m.mappedIndex!==0||m.accountIndex!==0||m.requestedAction!==0n||m.confirmedAction!==0n||m.priorityEnd!==0n||m.position!==0n||m.setup.pending)throw new Error('Account is not a provably unused custody account.');
  if(market.market_id!==m.market||market.supported_size_decimals!==m.sizeDecimals||market.supported_price_decimals!==m.priceDecimals||exactUnits(market.multiplier,18)!==10n**18n)throw new Error('Market configuration mismatch.');
  const mark=exactUnits(market.mark_price,6);if(mark===0n||mark>10n**18n)throw new Error('Invalid mark.');
  return {sequence:m.reportSequence+1n,action:0n,observedAt:blockTimestamp,venueEquity:0n,position:0n,mark,
    available:0n,ordersAndTransfersSettled:true,initialMarginBps:market.default_initial_margin_fraction,
    evidenceHash:digest({kind:'unused-L1-custody',m,market,blockTimestamp})};
}

export function observedReport(m:Snapshot,account:unknown,market:unknown,keys:unknown,responses:Map<string,unknown>,fetchedAt:number,now:number,blockTimestamp:bigint){
  const evidence=actionEvidence(m,responses);
  const observation={fetchedAt,now,blockTimestamp,minimumTransactionTime:evidence.minimumTransactionTime,actionEvidenceVerified:true};
  const candidate=m.setup.pending?memberSetupReport(m,m.setup,account,market,keys,observation):{report:memberReport(m,account,market,observation)};
  candidate.report.evidenceHash=digest({report:candidate.report,evidenceHash:evidence.evidenceHash});
  return candidate;
}

/** Validate full displayed depth inside the controller's immutable 10-bps bound.
 * This is pre-trade evidence only; execution is reconciled separately. */
export function executableLimit(m:Snapshot,report:Report,rawMarket:unknown,rawBook:unknown,maxNotional:bigint){
  const plan=memberPlan(m,report,rawMarket);
  if(plan.state!=='requires-order-review')throw new Error(plan.state==='blocked'?plan.reason:'No rebalance required.');
  const row=z.object({price:z.string(),remaining_base_amount:z.string()});
  const book=z.object({code:z.literal(200),bids:z.array(row).min(1).max(100),asks:z.array(row).min(1).max(100)}).parse(rawBook);
  const price=(s:string)=>exactUnits(s,m.priceDecimals),size=(s:string)=>exactUnits(s,m.sizeDecimals);
  if(price(book.bids[0].price)>=price(book.asks[0].price)||price(book.bids[0].price)<=0n)throw new Error('Invalid order book spread.');
  const side=plan.ask?book.bids:book.asks;let available=0n,last:bigint|undefined;
  for(const level of side){
    const p=price(level.price);if(p<=0n||(last!==undefined&&(plan.ask?p>last:p<last)))throw new Error('Unsorted order book.');last=p;
    if(plan.ask?p>=plan.limitPrice:p<=plan.limitPrice)available+=size(level.remaining_base_amount);
  }
  if(available<plan.size)throw new Error('Insufficient displayed depth inside the price bound.');
  const notional=(plan.size*plan.limitPrice*1_000_000n+10n**BigInt(m.sizeDecimals+m.priceDecimals)-1n)/10n**BigInt(m.sizeDecimals+m.priceDecimals);
  if(notional>maxNotional)throw new Error('Order exceeds the configured notional limit.');
  return Number(plan.limitPrice);
}

export function nextMemberAction(m:Snapshot,report:Report,rawMarket:unknown,rawBook:unknown,policy:Policy,now:number):Decision {
  const call=(name:string,args:readonly unknown[],reason:string):Decision=>({state:'ready',call:{target:'controller',name,args,member:m.id,reason,expiresAt:now+5_000}});
  const rebalance=(reason:string):Decision=>{
    try{
      const plan=memberPlan(m,report,rawMarket);
      const increasing=m.short?plan.delta<0n:plan.delta>0n;
      if(m.nav>policy.maxMemberAssets&&increasing)return {state:'blocked',reason:'Member NAV exceeds the capital limit; increasing exposure is blocked.'};
      return call('rebalance',[m.id,executableLimit(m,report,rawMarket,rawBook,policy.maxOrderNotional)],reason);
    }catch(error){return {state:'blocked',reason:(error as Error).message};}
  };
  if(m.pendingWithdrawal+m.custodyCash>0n)return call('collectVenueWithdrawal',[m.id],'Collect confirmed returned USDG.');
  const redeem=m.requests.filter(r=>r.redeem&&!r.completed&&r.deadline>=BigInt(Math.floor(now/1000)));
  if(redeem.length){
    const plan=memberPlan(m,report,rawMarket);
    if(plan.state!=='balanced'){
      return rebalance('Adjust actual exposure for queued exits.');
    }
    const required=m.supply?m.nav*m.redeemShares/m.supply:0n;
    if(required>m.cash){
      const amount=min(required-m.cash,report.available);
      if(amount<1_000_000n)return {state:'blocked',reason:'Exit collateral is below the withdrawal minimum or is unavailable.'};
      return call('requestVenueWithdrawal',[m.id,amount],'Return collateral needed for queued exits.');
    }
    return call('settleRequest',[redeem[0].id],'Settle the oldest eligible member exit.');
  }
  // Expired requests still reserve shares until their owner cancels. Do not fund
  // or restore exposure against those shares or silently cancel an owner request.
  if(m.redeemShares>0n)return {state:'blocked',reason:'An expired redemption must be recovered by its owner.'};
  const plan=memberPlan(m,report,rawMarket);
  // Reductions must not be starved by a capital-limit breach, idle cash or a
  // pending deposit. Keep the same venue, depth, slippage and order-size checks.
  const reducing=plan.state==='requires-order-review'&&(m.short
    ?report.position<plan.desired&&plan.desired<=0n
    :report.position>plan.desired&&plan.desired>=0n);
  if(reducing)return rebalance('Reduce existing exposure before considering additional capital.');
  if(m.nav>policy.maxMemberAssets)return {state:'blocked',reason:'Member NAV exceeds the configured capital limit.'};
  const deposit=m.requests.find(r=>!r.redeem&&!r.completed&&r.batch===0n&&r.deadline>=BigInt(Math.floor(now/1000)));
  if(deposit){
    if(!m.enabled)return {state:'blocked',reason:'Member entries are disabled.'};
    if(m.nav+deposit.amount>policy.maxMemberAssets)return {state:'blocked',reason:'Deposit exceeds the configured capital limit.'};
    return call('settleRequest',[deposit.id],'Issue an eligible individual member deposit.');
  }
  if(m.cash>=1_000_000n&&m.supply>0n)return call('fundVenue',[m.id,m.cash],'Fund the member with its own accounted USDG.');
  if(plan.state==='balanced')return {state:'idle',reason:'Actual member exposure is within the controller tolerance.'};
  return rebalance('Rebalance actual exposure using bounded order-book depth.');
}

export function hasOpenOrders(raw:unknown){const a=accountSchema.parse(raw);try{assertNoOrders(a);return false;}catch{return true;}}
export function callIdentity(call:Call):Hex{return digest(call);}
