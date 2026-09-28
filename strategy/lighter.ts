import { formatUnits, parseUnits } from 'viem';
import { z } from 'zod';

export const LIGHTER_API = 'https://api.rh.lighter.xyz';
export const marketIds = { ETH:0, NVDA:15, SPY:26 } as const;
export const quoteInput = z.object({
  symbol:z.enum(['ETH','NVDA','SPY']), side:z.enum(['long','short']),
  leverage:z.union([z.literal(3),z.literal(5),z.literal(10)]),
  collateral:z.string().regex(/^\d{1,7}(\.\d{1,6})?$/),
  slippageBps:z.number().int().min(1).max(50).default(10),
}).strict();
const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const marketSchema = z.object({symbol:z.string(),market_id:z.number().int(),status:z.string(),
  mark_price:decimal,min_base_amount:decimal,min_quote_amount:decimal,
  supported_size_decimals:z.number().int().min(0).max(12),supported_price_decimals:z.number().int().min(0).max(8),
  min_initial_margin_fraction:z.number().int().positive(),maintenance_margin_fraction:z.number().int().nonnegative(),
  market_config:z.object({force_reduce_only:z.boolean()}),
});
type VenueMarket = z.infer<typeof marketSchema>;
export type Market = {
  symbol:string; id:number; active:boolean; mark:string; bid:string; ask:string;
  maxLeverage:number; minBase:string; minNotional:string; sizeDecimals:number; priceDecimals:number;
  maintenanceMarginBps:number; bidDepth10bps:number; askDepth10bps:number; observedAt:string;
};
const bookSchema = z.object({bids:z.array(z.object({price:decimal,remaining_base_amount:decimal})).max(100),asks:z.array(z.object({price:decimal,remaining_base_amount:decimal})).max(100)});
async function get(path:string) {
  const response=await fetch(`${LIGHTER_API}${path}`,{signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('Market data unavailable.');
  return response.json();
}
let pending:Promise<Market[]>|undefined;
let cached:{at:number;markets:Market[]}|undefined;
export async function markets():Promise<Market[]> {
  if(cached && Date.now()-cached.at<15_000)return cached.markets;
  if(pending)return pending;
  pending=(async()=>{
    const payload=await get('/api/v1/orderBookDetails');
    const rows=z.array(marketSchema).parse(payload.order_book_details);
    const result=await Promise.all(Object.entries(marketIds).map(async([symbol,id])=>{
      const row:VenueMarket|undefined=rows.find(value=>value.symbol===symbol && value.market_id===id);
      if(!row)throw new Error('Market identity mismatch.');
      const book=bookSchema.parse(await get(`/api/v1/orderBookOrders?market_id=${id}&limit=100`));
      if(!book.bids.length || !book.asks.length)throw new Error('Order book is empty.');
      const bid=Number(book.bids[0].price),ask=Number(book.asks[0].price),mid=(bid+ask)/2;
      if(!Number.isFinite(mid)||bid<=0||bid>=ask)throw new Error('Invalid market spread.');
      const depth=(side:typeof book.bids)=>side.filter(value=>Math.abs(Number(value.price)/mid-1)<=0.001).reduce((sum,value)=>sum+Number(value.price)*Number(value.remaining_base_amount),0);
      return {symbol,id,active:row.status==='active'&&!row.market_config.force_reduce_only,mark:row.mark_price,bid:book.bids[0].price,ask:book.asks[0].price,maxLeverage:Math.floor(10000/row.min_initial_margin_fraction),minBase:row.min_base_amount,minNotional:row.min_quote_amount,sizeDecimals:row.supported_size_decimals,priceDecimals:row.supported_price_decimals,maintenanceMarginBps:row.maintenance_margin_fraction,bidDepth10bps:depth(book.bids),askDepth10bps:depth(book.asks),observedAt:new Date().toISOString()};
    }));
    cached={at:Date.now(),markets:result};return result;
  })();
  try{return await pending;}finally{pending=undefined;}
}

// Read-only sizing. This does not sign an order, transfer funds, or attest to a fill.
export function sizeOrder(raw:unknown,market:Market,now=Date.now()) {
  const input=quoteInput.parse(raw);
  if(market.symbol!==input.symbol || market.id!==marketIds[input.symbol])throw new Error('Market identity mismatch.');
  const age=now-Date.parse(market.observedAt);
  if(!Number.isFinite(age)||age<0||age>20_000)throw new Error('Market quote expired. Refresh and try again.');
  if(!market.active || input.leverage>market.maxLeverage)throw new Error('This market or leverage is unavailable.');
  const collateral=parseUnits(input.collateral,6);
  if(collateral<=0n)throw new Error('Enter a positive collateral amount.');
  const bid=parseUnits(market.bid,market.priceDecimals),ask=parseUnits(market.ask,market.priceDecimals);
  if(bid<=0n||bid>=ask)throw new Error('Invalid market spread.');
  const priceScale=10n**BigInt(market.priceDecimals),sizeScale=10n**BigInt(market.sizeDecimals);
  const buffer=BigInt(input.slippageBps);
  const upper=(ask*(10000n+buffer)+9999n)/10000n;
  const limit=input.side==='long' ? upper : bid*(10000n-buffer)/10000n;
  const size=collateral*BigInt(input.leverage)*priceScale*sizeScale/(upper*1000000n);
  const minBase=parseUnits(market.minBase,market.sizeDecimals);
  const notional=size*limit*1000000n/(priceScale*sizeScale);
  if(size<minBase || notional<parseUnits(market.minNotional,6))throw new Error('Amount is below the venue minimum. Increase collateral.');
  const availableDepth=input.side==='long'?market.askDepth10bps:market.bidDepth10bps;
  // This estimate uses only displayed depth in a 10 bps window and never guarantees execution.
  if(Number(formatUnits(notional,6))>availableDepth)throw new Error('Insufficient displayed depth for this estimate.');
  return {symbol:input.symbol,side:input.side,leverage:input.leverage,collateral:formatUnits(collateral,6),
    baseAmount:formatUnits(size,market.sizeDecimals),limitPrice:formatUnits(limit,market.priceDecimals),
    estimatedNotional:formatUnits(notional,6),slippageBps:input.slippageBps,observedAt:market.observedAt,
    expiresAt:new Date(Date.parse(market.observedAt)+20_000).toISOString(),
    executable:false as const,reason:'The deltaLP execution adapter is not connected. No order has been placed.',
  };
}
