import {keccak256, toHex} from 'viem';
import {z} from 'zod';
import {accountSchema, assertNoOrders, assertTradingAccount, availableUSDG, exactUnits, signedPosition, signedUnits} from './execution.js';

const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const accountDetails = accountSchema.extend({
  total_asset_value: z.string().regex(/^-?\d+(\.\d+)?$/),
  transaction_time: z.number().int().safe().nonnegative(),
  assets:z.array(z.object({asset_id:z.number().int(),symbol:z.string(),balance:decimal,locked_balance:decimal,
    margin_mode:z.string(),margin_balance:z.string().regex(/^-?\d+(\.\d+)?$/),multiplier:decimal})),
});
export const memberMarketSchema = z.object({
  market_id:z.number().int(), symbol:z.string(), status:z.string(),
  mark_price:decimal, min_base_amount:decimal, min_quote_amount:decimal,
  supported_size_decimals:z.number().int().min(0).max(12),
  supported_price_decimals:z.number().int().min(0).max(6),
  min_initial_margin_fraction:z.number().int().min(1).max(10_000),
  default_initial_margin_fraction:z.number().int().min(1).max(10_000),
  multiplier:decimal, market_config:z.object({force_reduce_only:z.boolean()}),
});
export type MemberSnapshot = {
  custody:string; accountIndex:number; market:number; sizeDecimals:number; priceDecimals:number;
  short:boolean; leverage:number; cash:bigint; supply:bigint; redeemShares:bigint;
  reportSequence:bigint; requestedAction:bigint; lastActionAt:bigint;
  priorityEnd:bigint; executedPriorityCount:bigint;
};
export type Observation = {
  fetchedAt:number; now:number; blockTimestamp:bigint;
  // Taken from the latest successfully reconciled venue transaction, NOT the L1 receipt time.
  minimumTransactionTime:number;
  actionEvidenceVerified:boolean;
};

/** Produces an unsigned, trusted-reporter candidate. It never submits a transaction.
 * Queue processing and an HTTP response alone cannot establish economic settlement.
 */
export function memberReport(member:MemberSnapshot, rawAccount:unknown, rawMarket:unknown, observation:Observation) {
  const account=accountDetails.parse(rawAccount), market=memberMarketSchema.parse(rawMarket);
  const age=observation.now-observation.fetchedAt;
  const blockAge=observation.now-Number(observation.blockTimestamp)*1000;
  if(age<0||age>10_000||blockAge<0||blockAge>15_000)throw new Error('Observation expired.');
  if(member.requestedAction!==0n&&!observation.actionEvidenceVerified)throw new Error('Action evidence is incomplete.');
  if(member.executedPriorityCount<member.priorityEnd)throw new Error('L1 priority requests are still pending.');
  if(observation.blockTimestamp<member.lastActionAt)throw new Error('Observation predates the action.');
  if(account.index!==member.accountIndex||account.l1_address.toLowerCase()!==member.custody.toLowerCase())throw new Error('Custody account identity mismatch.');
  if(account.transaction_time<observation.minimumTransactionTime)throw new Error('Account snapshot predates venue execution.');
  assertTradingAccount(account);
  assertNoOrders(account);
  const usd=account.assets.filter(a=>a.asset_id===3);
  if(usd.length!==1||usd[0].symbol!=='USDG'||exactUnits(usd[0].multiplier,18)!==10n**18n)throw new Error('USDG asset identity mismatch.');
  if(account.assets.some(a=>a.asset_id!==3&&(exactUnits(a.balance,18)!==0n||exactUnits(a.locked_balance,18)!==0n||signedUnits(a.margin_balance,18)!==0n)))throw new Error('Foreign collateral cannot price a USDG claim.');
  // Opposite strategies must be isolated by account; foreign positions invalidate NAV attribution.
  if(account.positions.some(p=>p.market_id!==member.market&&exactUnits(p.position,18)!==0n))throw new Error('Foreign market exposure.');
  if(market.market_id!==member.market||market.supported_size_decimals!==member.sizeDecimals||market.supported_price_decimals!==member.priceDecimals||exactUnits(market.multiplier,18)!==10n**18n)throw new Error('Market configuration mismatch.');
  const position=signedPosition(account,member.market,member.sizeDecimals);
  if((member.short&&position>0n)||(!member.short&&position<0n))throw new Error('Position direction mismatch.');
  if(position>2n**48n-1n||position<-(2n**48n-1n))throw new Error('Position exceeds venue bounds.');
  const row=account.positions.find(p=>p.market_id===member.market);
  // API reports this field in percent: "50.00" is 5,000 basis points (2x), not 50 bps.
  const initialMarginBps=row?Number(exactUnits(row.initial_margin_fraction,2)):market.default_initial_margin_fraction;
  if(initialMarginBps<market.min_initial_margin_fraction||initialMarginBps>10_000)throw new Error('Invalid initial margin setting.');
  const mark=exactUnits(market.mark_price,6);
  if(mark===0n||mark>10n**18n)throw new Error('Invalid mark.');
  const venueEquity=signedUnits(account.total_asset_value,6);
  const available=availableUSDG(account);
  if(available>venueEquity&&venueEquity>=0n)throw new Error('Available collateral exceeds equity.');
  const evidenceHash=keccak256(toHex(JSON.stringify({member,account,market,observation},(_,v)=>typeof v==='bigint'?v.toString():v)));
  return {sequence:member.reportSequence+1n,action:member.requestedAction,observedAt:observation.blockTimestamp,
    venueEquity,position,mark,available:available>0n?available:0n,ordersAndTransfersSettled:true,evidenceHash,initialMarginBps};
}

/** Exact integer target matches the controller, including shares queued for exit. */
export function memberPlan(member:MemberSnapshot, report:ReturnType<typeof memberReport>, rawMarket:unknown) {
  const market=memberMarketSchema.parse(rawMarket);
  if(member.leverage<1||member.leverage>50||member.redeemShares>member.supply)throw new Error('Invalid member accounting.');
  const total=member.cash+report.venueEquity, nav=total>0n?total:0n;
  const backing=member.supply===0n?0n:nav*(member.supply-member.redeemShares)/member.supply;
  const base=backing*BigInt(member.leverage)*10n**BigInt(member.sizeDecimals)/report.mark;
  const desired=member.short?-base:base, delta=desired-report.position, size=delta<0n?-delta:delta;
  const needed=size!==0n&&(base===0n||size*10_000n>base*100n);
  if(!needed)return {state:'balanced' as const,desired,delta};
  const increasing=(delta>0n&&!member.short)||(delta<0n&&member.short);
  const notional=(base*report.mark+10n**BigInt(member.sizeDecimals)-1n)/10n**BigInt(member.sizeDecimals);
  const margin=(notional*BigInt(report.initialMarginBps)+9999n)/10_000n;
  const reason=market.status!=='active'?'Market is inactive.'
    :increasing&&market.market_config.force_reduce_only?'Market permits reductions only.'
    :increasing&&member.leverage>Math.floor(10_000/market.min_initial_margin_fraction)?'Requested leverage is unsupported.'
    :increasing&&margin>(report.venueEquity>0n?report.venueEquity*9900n/10_000n:0n)?'Initial margin or collateral headroom is insufficient.'
    :size<exactUnits(market.min_base_amount,member.sizeDecimals)||size*report.mark/10n**BigInt(member.sizeDecimals)<exactUnits(market.min_quote_amount,6)?'Order is below the venue minimum.'
    :size>=2n**48n?'Order exceeds venue size bounds.':undefined;
  if(reason)return {state:'blocked' as const,desired,delta,reason};
  // Candidate limit only. A live order-book/slippage check is still required before signing.
  const markTicks=report.mark/10n**BigInt(6-member.priceDecimals);
  const limitPrice=delta>0n?markTicks*10010n/10000n:(markTicks*9990n+9999n)/10000n;
  if(limitPrice<=0n||limitPrice>=2n**32n)throw new Error('Price exceeds venue bounds.');
  return {state:'requires-order-review' as const,desired,delta,size,ask:delta<0n,limitPrice};
}
