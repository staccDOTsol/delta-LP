import {formatUnits, parseUnits} from 'viem';
import {z} from 'zod';
import {marketIds, quoteInput, type Market} from './lighter.js';

const decimal=z.string().regex(/^\d{1,18}(\.\d{1,18})?$/);
const signedDecimal=z.string().regex(/^-?\d{1,18}(\.\d{1,18})?$/);
export const positionSchema=z.object({market_id:z.number().int(),symbol:z.string(),sign:z.number().int().min(-1).max(1),
  position:decimal,initial_margin_fraction:decimal,margin_mode:z.number().int(),
  open_order_count:z.number().int().nonnegative(),pending_order_count:z.number().int().nonnegative(),position_tied_order_count:z.number().int().nonnegative(),
  unrealized_pnl:z.string(),liquidation_price:decimal});
export const accountSchema=z.object({index:z.number().int().nonnegative(),l1_address:z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  account_type:z.number().int(),account_trading_mode:z.number().int().default(0),available_balance:signedDecimal,collateral:signedDecimal,
  total_order_count:z.number().int().nonnegative(),pending_order_count:z.number().int().nonnegative(),positions:z.array(positionSchema),
  assets:z.array(z.object({asset_id:z.number().int(),symbol:z.string(),margin_mode:z.string(),margin_balance:signedDecimal,multiplier:decimal})).optional()});
export type TradingAccount=z.infer<typeof accountSchema>;
export type OrderPlan={marketId:number;symbol:keyof typeof marketIds;side:'long'|'short';leverage:3|5|10;collateral:string;
  size:string;price:string;baseTicks:string;priceTicks:string;sizeDecimals:number;priceDecimals:number;
  before:string;reduceOnly:boolean;expiresAt:number;notional:string;marginBps:number};
export const marginBps=(leverage:3|5|10)=>Math.ceil(10000/leverage);
export function signedPosition(account:TradingAccount,id:number,decimals:number){
  const rows=account.positions.filter(value=>value.market_id===id);
  if(rows.length>1)throw new Error('Duplicate market positions.');
  const row=rows[0];if(!row)return 0n;
  const units=exactUnits(row.position,decimals);
  if(units&&row.sign===0)throw new Error('Position direction unavailable.');
  return units*BigInt(row.sign);
}
export function exactUnits(value:string,decimals:number):bigint{
  decimal.parse(value);
  const units=parseUnits(value,decimals);
  // viem rounds excess precision; order inputs must never silently round up.
  if(Number.isNaN(Number(value)) || decimalCanonical(value)!==decimalCanonical(formatUnits(units,decimals)))throw new Error('Amount exceeds supported precision.');
  return units;
}
const decimalCanonical=(value:string)=>value.replace(/^0+(?=\d)/,'').replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
export function signedUnits(value:string,decimals:number){signedDecimal.parse(value);return value.startsWith('-')?-exactUnits(value.slice(1),decimals):exactUnits(value,decimals);}
export function assertNoOrders(account:TradingAccount){
  if(account.total_order_count||account.pending_order_count||account.positions.some(p=>p.open_order_count||p.pending_order_count||p.position_tied_order_count))throw new Error('Cancel existing orders on Lighter before placing this trade.');
}
export function assertTradingAccount(account:TradingAccount){
  if(account.account_type!==0||![0,1].includes(account.account_trading_mode))throw new Error('Use a dedicated Lighter master account in Classic or Unified mode.');
}
export function availableUSDG(account:TradingAccount){
  assertTradingAccount(account);
  const available=signedUnits(account.available_balance,6);
  if(account.account_trading_mode===0)return available;
  // Unified available_balance includes other collateral valued in dollars. Never
  // silently treat that buying power as spendable USDG or change account mode.
  if(!account.assets)throw new Error('Unified USDG collateral details are unavailable. Refresh status.');
  const usdg=account.assets.filter(asset=>asset.asset_id===3);
  if(usdg.length!==1||usdg[0].symbol!=='USDG'||usdg[0].margin_mode!=='enabled'||exactUnits(usdg[0].multiplier,18)!==10n**18n)throw new Error('USDG margin is not confirmed for this account.');
  if(account.assets.some(asset=>asset.asset_id!==3&&signedUnits(asset.margin_balance,18)!==0n))throw new Error('This flow supports USDG-only collateral. Manage mixed collateral on Lighter.');
  const usdBalance=signedUnits(usdg[0].margin_balance,6);
  return available<usdBalance?available:usdBalance;
}
export function makePlan(raw:unknown,market:Market,account:TradingAccount,reduceOnly=false,now=Date.now()):OrderPlan{
  const input=quoteInput.parse(raw);accountSchema.parse(account);
  const age=now-Date.parse(market.observedAt);
  if(!Number.isFinite(age)||age<0||age>10_000)throw new Error('Quote expired. Review a fresh quote.');
  if(market.symbol!==input.symbol||market.id!==marketIds[input.symbol])throw new Error('Market identity mismatch.');
  if(!market.active)throw new Error('Market is not accepting this order.');
  assertTradingAccount(account);
  assertNoOrders(account);
  const before=signedPosition(account,market.id,market.sizeDecimals);
  const scale=10n**BigInt(market.sizeDecimals),priceScale=10n**BigInt(market.priceDecimals);
  const ask=exactUnits(market.ask,market.priceDecimals),bid=exactUnits(market.bid,market.priceDecimals);
  if(bid<=0n||bid>=ask)throw new Error('Invalid market spread.');
  const upper=(ask*(10000n+BigInt(input.slippageBps))+9999n)/10000n;
  const side=reduceOnly?(before>0n?'short':'long'):input.side;
  // Round price bounds inward, never beyond the tolerance the user reviewed.
  const price=side==='long'?ask*(10000n+BigInt(input.slippageBps))/10000n:(bid*(10000n-BigInt(input.slippageBps))+9999n)/10000n;
  let base:bigint;
  const collateral=exactUnits(input.collateral,6),imf=marginBps(input.leverage);
  if(reduceOnly){if(!before)throw new Error('No position to close.');base=before<0n?-before:before;}
  else{
    if(account.positions.some(p=>exactUnits(p.position,18)>0n))throw new Error('Close existing positions before opening a new one in this account.');
    if(!collateral||collateral>availableUSDG(account))throw new Error('Not enough available USDG in Lighter.');
    if(input.leverage>market.maxLeverage)throw new Error('Selected leverage is not available.');
    // Reserve 1% for fees and rounding; isolated margin rounds 3x down to 2.9994x.
    base=collateral*99n*10000n*priceScale*scale/(100n*BigInt(imf)*upper*1000000n);
  }
  const notional=base*price*1000000n/(scale*priceScale);
  if(!base||base>=2n**48n||!price||price>=2n**32n)throw new Error('Order is outside venue limits.');
  if(!reduceOnly&&(base<exactUnits(market.minBase,market.sizeDecimals)||notional<exactUnits(market.minNotional,6)))throw new Error('Amount is below the market minimum. Increase collateral.');
  return {marketId:market.id,symbol:input.symbol,side,leverage:input.leverage,collateral:formatUnits(collateral,6),
    size:formatUnits(base,market.sizeDecimals),price:formatUnits(price,market.priceDecimals),baseTicks:String(base),priceTicks:String(price),
    sizeDecimals:market.sizeDecimals,priceDecimals:market.priceDecimals,before:String(before),reduceOnly,
    expiresAt:Date.parse(market.observedAt)+10_000,notional:formatUnits(notional,6),marginBps:imf};
}

export type OrderIdentity={accountIndex:number;clientOrderIndex:number;plan:OrderPlan};
export const orderSchema=z.object({owner_account_index:z.number().int(),market_index:z.number().int(),client_order_index:z.number().int(),
  order_index:z.number().int(),initial_base_amount:decimal,price:decimal,is_ask:z.boolean(),reduce_only:z.boolean(),
  time_in_force:z.string(),status:z.string(),filled_base_amount:decimal,filled_quote_amount:decimal});
export function reconcileOrder(identity:OrderIdentity,raw:unknown,account:TradingAccount){
  const order=orderSchema.parse(raw),p=identity.plan;
  if(order.owner_account_index!==identity.accountIndex||order.market_index!==p.marketId||order.client_order_index!==identity.clientOrderIndex
    ||order.is_ask!==(p.side==='short')||order.reduce_only!==p.reduceOnly||order.time_in_force!=='immediate-or-cancel'
    ||exactUnits(order.initial_base_amount,p.sizeDecimals)!==BigInt(p.baseTicks)||exactUnits(order.price,p.priceDecimals)!==BigInt(p.priceTicks))throw new Error('Order identity mismatch. Stop and reconcile on Lighter.');
  const filled=exactUnits(order.filled_base_amount,p.sizeDecimals),wanted=BigInt(p.baseTicks);
  if(filled>wanted||(order.status==='filled'&&filled!==wanted))throw new Error('Inconsistent fill amount.');
  if(filled){
    const quote=exactUnits(order.filled_quote_amount,6),bound=filled*BigInt(p.priceTicks)*1000000n/(10n**BigInt(p.sizeDecimals+p.priceDecimals));
    if(p.side==='short'?quote+1n<bound:quote>bound+1n)throw new Error('Fill exceeds the reviewed price bound.');
  }
  const terminal=order.status==='filled'||/^canceled(?:-|$)/.test(order.status);
  const expected=BigInt(p.before)+(p.side==='short'?-filled:filled);
  const actual=signedPosition(account,p.marketId,p.sizeDecimals);
  const settled=terminal&&expected===actual;
  return {state:settled?(filled===wanted?'filled':filled?'partial':'canceled'):'pending',filled:formatUnits(filled,p.sizeDecimals),position:formatUnits(actual,p.sizeDecimals),orderIndex:order.order_index,terminal:settled} as const;
}

export function transactionState(raw:unknown,hash:string,accountIndex:number){
  const tx=z.object({hash:z.string(),account_index:z.number().int(),status:z.number().int().min(0).max(5),event_info:z.string()}).parse(raw);
  if(tx.hash!==hash||tx.account_index!==accountIndex)throw new Error('Transaction identity mismatch.');
  const events=z.object({ae:z.unknown().optional()}).passthrough().parse(JSON.parse(tx.event_info||'{}'));
  if(tx.status===0||events.ae)return 'failed';
  return tx.status>=2?'executed':'pending';
}
