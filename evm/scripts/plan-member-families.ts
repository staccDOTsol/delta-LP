import {writeFileSync,mkdirSync} from 'node:fs';
import {createPublicClient,encodeFunctionData,http,keccak256,parseAbi,toHex,type Address} from 'viem';
import {memberMarketSchema} from '../../strategy/member-reconciliation.js';
import {exactUnits} from '../../strategy/execution.js';
import deployment from '../../strategy/member-deployment.js';

// Produces unsigned registry calls for EVERY supported integer tier. No private keys,
// approvals, deposits, orders, or network writes. Quotes are not executable guarantees.
const controller=deployment.contracts.MemberController.address as Address;
const client=createPublicClient({transport:http('https://rpc.mainnet.chain.robinhood.com')});
if(await client.getChainId()!==4663)throw new Error('Wrong chain.');
const response=await fetch('https://api.rh.lighter.xyz/api/v1/orderBookDetails',{signal:AbortSignal.timeout(10_000)});
if(!response.ok)throw new Error('Market registry unavailable.');
const payload=await response.json();
if(payload.code!==200||!Array.isArray(payload.order_book_details))throw new Error('Invalid market registry.');
const abi=parseAbi(['function createMember(bytes32,uint16,uint8,bool,uint8,uint8,string,string) returns (uint256)',
  'function registeredSeries(bytes32) view returns (uint256)']);
const markets={ETH:0,NVDA:15,SPY:26};
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
const families=[];
for(const [symbol,marketId] of Object.entries(markets)){
  const market=memberMarketSchema.parse(payload.order_book_details.find((r:{market_id:number})=>r.market_id===marketId));
  if(market.symbol!==symbol||market.status!=='active'||market.market_config.force_reduce_only)throw new Error(`${symbol} market is unavailable.`);
  const maxLeverage=Math.floor(10_000/market.min_initial_margin_fraction);
  if(maxLeverage>50)throw new Error(`${symbol} supports tiers beyond this controller's bounds; do not omit them silently.`);
  const group=keccak256(toHex(symbol)),calls=[];
  const mark=exactUnits(market.mark_price,6),scale=10n**BigInt(market.supported_size_decimals);
  const baseNotional=ceil(exactUnits(market.min_base_amount,market.supported_size_decimals)*mark,scale);
  const minNotional=exactUnits(market.min_quote_amount,6)>baseNotional?exactUnits(market.min_quote_amount,6):baseNotional;
  // The 1x tier determines the equal-per-leg lower bound when all integer tiers participate.
  const netPerLeg=minNotional>1_000_000n?minNotional:1_000_000n;
  const grossPerLeg=ceil(netPerLeg*10_000n,9800n);
  for(let leverage=1;leverage<=maxLeverage;leverage++)for(const short of [false,true]){
    const args=[group,marketId,leverage,short,market.supported_size_decimals,market.supported_price_decimals,
      `deltaLP ${symbol} ${leverage}x ${short?'Short':'Long'}`,`dlp${symbol}${leverage}${short?'S':'L'}`] as const;
    calls.push({to:controller,value:'0',leverage,side:short?'short':'long',data:encodeFunctionData({abi,functionName:'createMember',args})});
  }
  families.push({symbol,marketId,group,tiers:Array.from({length:maxLeverage},(_,i)=>i+1),members:calls.length,
    minimumEqualAllocationUSDGMicro:String(grossPerLeg*BigInt(calls.length)),defaultInitialMarginBps:market.default_initial_margin_fraction,
    requiresAccountMarginSetup:true,includesMarginAndExecutionBuffer:false,calls});
}
const result={mode:'unsigned-registry-plan',chainId:4663,controller,observedAt:new Date().toISOString(),families};
mkdirSync(new URL('../../artifacts/',import.meta.url),{recursive:true});
writeFileSync(new URL('../../artifacts/member-family-plan.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({mode:result.mode,controller,families:families.map(({calls,...family})=>family)},null,2));
