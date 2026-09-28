import {createPublicClient,createWalletClient,custom,defineChain,encodeFunctionData,formatUnits,http,parseAbi,toHex,type Address,type EIP1193Provider,type Hash} from 'viem';
import {z} from 'zod';
import {accountSchema,assertNoOrders,exactUnits,makePlan,marginBps,reconcileOrder,signedPosition,transactionState,type OrderPlan,type TradingAccount} from '../../strategy/execution.js';
import {LIGHTER_API,marketIds,type Market} from '../../strategy/lighter.js';
import {wasm} from './wasm.js';

export const chain=defineChain({id:4663,name:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:['https://rpc.mainnet.chain.robinhood.com']}},blockExplorers:{default:{name:'Blockscout',url:'https://robinhoodchain.blockscout.com'}}});
export const USDG='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const;
export const LIGHTER='0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d' as const;
const KEY_INDEX=42;
const publicClient=createPublicClient({chain,transport:http(undefined,{timeout:10_000,retryCount:0})});
const erc20=parseAbi(['function balanceOf(address) view returns (uint256)','function allowance(address,address) view returns (uint256)','function approve(address,uint256) returns (bool)']);
const depositAbi=parseAbi(['function deposit(address,uint16,uint8,uint256) payable']);
type Signed={txHash:string;txInfo:string};
type Pending={hash:string;kind:'order'|'margin'|'key'|'withdraw';accountIndex:number;createdAt:number;plan?:OrderPlan;clientOrderIndex?:number};
export type Outcome={state:string;message:string;hash?:string};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export async function venueGet(path:string,token?:string):Promise<unknown>{
  const response=await fetch(`${LIGHTER_API}/api/v1/${path}`,{headers:token?{Authorization:token}:{},signal:AbortSignal.timeout(10_000),cache:'no-store'});
  const value=await response.json();if(value.code===21100)return null;
  if(!response.ok||value.code!==200)throw new Error('Lighter did not return a valid response. Try refreshing.');
  return value;
}
const txSchema=z.object({code:z.number(),tx_hash:z.string()});

export class TradingClient{
  address:Address;account:TradingAccount|null=null;authorized=false;
  readonly provider:EIP1193Provider;
  constructor(provider:EIP1193Provider,address:Address,private signer:typeof wasm=wasm,private pause:typeof delay=delay){this.provider=provider;this.address=address;}
  private get storageKey(){return `dlp.execution.v1.${this.address.toLowerCase()}`;}
  private wallet(){return createWalletClient({account:this.address,chain,transport:custom(this.provider,{retryCount:0})});}
  private async identity(){
    const [addresses,chainId]=await Promise.all([this.provider.request({method:'eth_accounts'}),this.provider.request({method:'eth_chainId'})]);
    if(addresses[0]?.toLowerCase()!==this.address.toLowerCase()||Number(chainId)!==4663)throw new Error('Wallet account or network changed. Reconnect your wallet.');
  }
  async refresh(){
    const payload=await venueGet(`accountsByL1Address?l1_address=${this.address}`);
    if(payload===null){this.account=null;return null;}
    const rows=z.object({sub_accounts:z.array(z.object({index:z.number().int(),account_type:z.number().int()}))}).parse(payload).sub_accounts.filter(a=>a.account_type===0);
    if(rows.length!==1)throw new Error('Cannot identify one master account. Use Lighter to inspect your accounts.');
    const data=z.object({accounts:z.array(accountSchema)}).parse(await venueGet(`account?by=index&value=${rows[0].index}`));
    const account=data.accounts.find(a=>a.index===rows[0].index);
    if(!account||account.l1_address.toLowerCase()!==this.address.toLowerCase())throw new Error('Wallet/account mismatch.');
    this.account=account;return account;
  }
  async balances(){
    const [usdg,eth]=await Promise.all([publicClient.readContract({address:USDG,abi:erc20,functionName:'balanceOf',args:[this.address]}),publicClient.getBalance({address:this.address})]);
    return {usdg:formatUnits(usdg,6),eth:formatUnits(eth,18)};
  }
  pending():Pending|null{const raw=localStorage.getItem(this.storageKey);return raw?JSON.parse(raw):null;}
  private save(value:Pending){localStorage.setItem(this.storageKey,JSON.stringify(value));}
  private async lock<T>(fn:()=>Promise<T>):Promise<T>{
    if(!navigator.locks)throw new Error('This browser cannot coordinate trading tabs. Use a current browser.');
    return navigator.locks.request(this.storageKey,{ifAvailable:true},async lock=>{if(!lock)throw new Error('Another tab is processing a transaction.');return fn();});
  }
  private ensureClear(){if(this.pending()||localStorage.getItem(`${this.storageKey}.deposit`))throw new Error('A transaction is pending. Refresh its status before continuing.');}
  private async nonce(){
    if(!this.account)throw new Error('Deposit USDG to create your Lighter account first.');
    return z.object({nonce:z.number().int().nonnegative()}).parse(await venueGet(`nextNonce?account_index=${this.account.index}&api_key_index=${KEY_INDEX}`)).nonce;
  }
  async authorize(){return this.lock(async()=>{
    await this.identity();await this.refresh();if(!this.account)throw new Error('Deposit USDG first.');
    const index=this.account.index,nonce=await this.nonce();
    // Wallet signature derives a reproducible browser key. Nothing secret is persisted,
    // sent to deltaLP, or included in the execution journal.
    const message=`deltaLP browser trading key\nOnly sign this on ${location.origin}.\nRobinhood Chain: 4663\nLighter signing domain: 466324\nWallet: ${this.address.toLowerCase()}\nAccount: ${index}\nAPI key: ${KEY_INDEX}\nThis signature derives a key that can submit orders. Never share this signature.\nVersion: 1`;
    const signature=await this.wallet().signMessage({message});await this.identity();
    const seed=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(signature)))).map(v=>v.toString(16).padStart(2,'0')).join('');
    const generated=await this.signer<{pk:string;body:string}>('_createClient',seed,466324,index,nonce,KEY_INDEX,false);
    const keys=z.object({api_keys:z.array(z.object({public_key:z.string()}))}).parse(await venueGet(`apikeys?account_index=${index}&api_key_index=${KEY_INDEX}`));
    const current=keys.api_keys[0]?.public_key;
    if(current&&current.replace(/^0x/,'')===generated.pk.replace(/^0x/,'')){this.authorized=true;return {state:'ready',message:'Trading authorized in this browser.'};}
    this.ensureClear();
    if(current&&!/^0+$/.test(current.replace(/^0x/,'')))throw new Error('API key 42 is already in use. Revoke it in Lighter before authorizing deltaLP.');
    const proof=await this.signer<{body:string}>('_getChangePubKeyTransaction',index,nonce,KEY_INDEX);
    const registration=await this.wallet().signMessage({message:proof.body});await this.identity();
    const signed=await this.signer<Signed>('_signChangePubKey',index,registration,nonce,KEY_INDEX);
    const result=await this.submit(signed,8,{kind:'key',accountIndex:index});
    if(result.state==='executed'){this.authorized=true;return {...result,message:'Trading authorized in this browser.'};}return result;
  });}
  async revoke(){return this.lock(async()=>{
    await this.identity();this.ensureClear();if(!this.account)throw new Error('No Lighter account.');
    const index=this.account.index,nonce=await this.nonce();
    const proof=await this.signer<{body:string}>('_getRevokePubKeyTransaction',index,nonce,KEY_INDEX);
    const signature=await this.wallet().signMessage({message:proof.body});await this.identity();
    const signed=await this.signer<Signed>('_signRevokePubKey',index,signature,nonce,KEY_INDEX);
    const result=await this.submit(signed,8,{kind:'key',accountIndex:index});this.authorized=false;return result;
  });}
  async deposit(value:string){return this.lock(async()=>{
    await this.identity();this.ensureClear();const units=exactUnits(value,6);
    if(units<1_000_000n)throw new Error('Deposit at least 1 USDG.');
    const [balance,allowance]=await Promise.all([publicClient.readContract({address:USDG,abi:erc20,functionName:'balanceOf',args:[this.address]}),publicClient.readContract({address:USDG,abi:erc20,functionName:'allowance',args:[this.address,LIGHTER]})]);
    if(units>balance)throw new Error('Not enough USDG in your wallet.');
    if(allowance<units){
      const hash=await this.wallet().writeContract({address:USDG,abi:erc20,functionName:'approve',args:[LIGHTER,units]});
      const receipt=await publicClient.waitForTransactionReceipt({hash,timeout:60_000});if(receipt.status!=='success')throw new Error('USDG approval failed.');
    }
    await this.identity();
    // Validate the exact call before asking the wallet. Only the user's wallet signs.
    await publicClient.simulateContract({address:LIGHTER,abi:depositAbi,functionName:'deposit',args:[this.address,3,0,units],account:this.address});
    localStorage.setItem(`${this.storageKey}.deposit`,JSON.stringify({state:'wallet',amount:value}));
    try{
      const hash=await this.wallet().sendTransaction({to:LIGHTER,data:encodeFunctionData({abi:depositAbi,functionName:'deposit',args:[this.address,3,0,units]})});
      localStorage.setItem(`${this.storageKey}.deposit`,JSON.stringify({state:'submitted',hash,amount:value}));
      return this.depositStatus();
    }catch(error){
      // User rejection proves no send; transport errors do not. Preserve the journal.
      if((error as {code?:number}).code===4001||(error as {cause?:{code?:number}}).cause?.code===4001)localStorage.removeItem(`${this.storageKey}.deposit`);
      throw new Error('Deposit was not confirmed. Check your wallet and refresh deposit status.');
    }
  });}
  async depositStatus():Promise<Outcome>{
    const raw=localStorage.getItem(`${this.storageKey}.deposit`);if(!raw)return {state:'none',message:'No deposit pending.'};
    const pending=JSON.parse(raw) as {hash?:Hash;amount:string};
    if(!pending.hash)return {state:'unknown',message:'Check your wallet for the deposit transaction. Its hash was not returned; do not deposit again.'};
    try{
      const receipt=await publicClient.getTransactionReceipt({hash:pending.hash});
      if(receipt.status!=='success'){localStorage.removeItem(`${this.storageKey}.deposit`);return {state:'failed',hash:pending.hash,message:'Deposit reverted. Funds were not deposited.'};}
      // An L1 receipt is NOT Lighter collateral confirmation.
      const tx=await venueGet(`txFromL1TxHash?hash=${pending.hash}`);
      const account=await this.refresh();if(!tx||!account)return {state:'pending',hash:pending.hash,message:'Deposit mined; waiting for Lighter to credit the account.'};
      const state=transactionState(tx,z.object({hash:z.string()}).parse(tx).hash,account.index);
      if(state==='executed'){localStorage.removeItem(`${this.storageKey}.deposit`);return {state,hash:pending.hash,message:'Deposit credited by Lighter.'};}
      return {state,hash:pending.hash,message:'Waiting for Lighter deposit confirmation.'};
    }catch{return {state:'pending',hash:pending.hash,message:'Deposit confirmation is pending. Refresh its status.'};}
  }
  private async freshMarket(symbol:keyof typeof marketIds,closing=false):Promise<Market>{
    const started=new Date().toISOString();const [detail,book]=await Promise.all([venueGet(`orderBookDetails?market_id=${marketIds[symbol]}`),venueGet(`orderBookOrders?market_id=${marketIds[symbol]}&limit=100`)]);
    const row=z.object({order_book_details:z.array(z.object({symbol:z.string(),market_id:z.number(),status:z.string(),taker_fee:z.string(),mark_price:z.string(),min_base_amount:z.string(),min_quote_amount:z.string(),supported_size_decimals:z.number().int(),supported_price_decimals:z.number().int(),min_initial_margin_fraction:z.number(),maintenance_margin_fraction:z.number(),multiplier:z.string(),market_config:z.object({force_reduce_only:z.boolean()})}))}).parse(detail).order_book_details.find(r=>r.symbol===symbol&&r.market_id===marketIds[symbol]);
    if(!row||exactUnits(row.multiplier,18)!==10n**18n)throw new Error('Unsupported market configuration.');
    // Fee is a percentage in the venue API. Reserve permits <= 5 bps per fill.
    if(exactUnits(row.taker_fee,6)>5000n)throw new Error('Trading fee exceeds this adapter’s reserve.');
    const levels=z.object({bids:z.array(z.object({price:z.string(),remaining_base_amount:z.string()})),asks:z.array(z.object({price:z.string(),remaining_base_amount:z.string()}))}).parse(book);
    if(!levels.bids.length||!levels.asks.length)throw new Error('Empty order book.');
    const bid=levels.bids[0].price,ask=levels.asks[0].price;
    const depth=(rows:typeof levels.bids)=>rows.filter(r=>Math.abs(Number(r.price)/((Number(bid)+Number(ask))/2)-1)<=.001).reduce((n,r)=>n+Number(r.price)*Number(r.remaining_base_amount),0);
    return {symbol,id:row.market_id,active:row.status==='active'&&(closing||!row.market_config.force_reduce_only),mark:row.mark_price,bid,ask,maxLeverage:Math.floor(10000/row.min_initial_margin_fraction),minBase:row.min_base_amount,minNotional:row.min_quote_amount,sizeDecimals:row.supported_size_decimals,priceDecimals:row.supported_price_decimals,maintenanceMarginBps:row.maintenance_margin_fraction,bidDepth10bps:depth(levels.bids),askDepth10bps:depth(levels.asks),observedAt:started};
  }
  async prepare(input:{symbol:keyof typeof marketIds;side:'long'|'short';leverage:3|5|10;collateral:string},close=false){return this.lock(async()=>{
    await this.identity();this.ensureClear();if(!this.authorized)throw new Error('Authorize trading first.');
    const account=await this.refresh();if(!account)throw new Error('Deposit USDG first.');assertNoOrders(account);
    if(!close){
      if(account.positions.some(p=>exactUnits(p.position,18)>0n))throw new Error('Close existing positions before opening another.');
      const current=account.positions.find(p=>p.market_id===marketIds[input.symbol]);
      if(current?.margin_mode!==1||exactUnits(current.initial_margin_fraction,2)!==BigInt(marginBps(input.leverage))){
        const signed=await this.signer<Signed>('_signUpdateLeverage',account.index,marketIds[input.symbol],marginBps(input.leverage),1,await this.nonce());
        const result=await this.submit(signed,20,{kind:'margin',accountIndex:account.index});
        if(result.state!=='executed')throw new Error(result.message);
        await this.refresh();
      }
    }
    const market=await this.freshMarket(input.symbol,close);const plan=makePlan({...input,slippageBps:10},market,this.account!,close);
    if(Number(plan.notional)>(plan.side==='long'?market.askDepth10bps:market.bidDepth10bps))throw new Error('Insufficient displayed depth.');
    return plan;
  });}
  async trade(plan:OrderPlan){return this.lock(async()=>{
    await this.identity();this.ensureClear();if(!this.authorized)throw new Error('Authorize trading first.');
    const account=await this.refresh();if(!account||Date.now()>plan.expiresAt)throw new Error('Quote expired. Review a fresh quote.');
    assertNoOrders(account);
    if(signedPosition(account,plan.marketId,plan.sizeDecimals)!==BigInt(plan.before))throw new Error('Position changed. Review a fresh quote.');
    if(!plan.reduceOnly){
      if(account.positions.some(p=>exactUnits(p.position,18)>0n)||exactUnits(account.available_balance,6)<exactUnits(plan.collateral,6))throw new Error('Account exposure or balance changed.');
      const margin=account.positions.find(p=>p.market_id===plan.marketId);
      if(!margin||margin.margin_mode!==1||exactUnits(margin.initial_margin_fraction,2)!==BigInt(plan.marginBps))throw new Error('Isolated margin is not confirmed.');
    }
    const random=crypto.getRandomValues(new Uint32Array(2));const id=random[0]*32768+(random[1]&32767);
    const signed=await this.signer<Signed>('_signCreateOrder',account.index,plan.marketId,id,plan.baseTicks,plan.priceTicks,plan.side==='short'?1:0,0,0,plan.reduceOnly?1:0,'0',0,await this.nonce());
    if(Date.now()>plan.expiresAt)throw new Error('Quote expired before submission. Nothing submitted.');
    return this.submit(signed,14,{kind:'order',accountIndex:account.index,plan,clientOrderIndex:id});
  });}
  async withdraw(value:string){return this.lock(async()=>{
    await this.identity();this.ensureClear();if(!this.authorized)throw new Error('Authorize trading first.');
    const account=await this.refresh();if(!account)throw new Error('No Lighter account.');assertNoOrders(account);
    if(account.positions.some(p=>exactUnits(p.position,18)>0n))throw new Error('Close positions before withdrawing.');
    const units=exactUnits(value,6);if(!units||units>exactUnits(account.available_balance,6))throw new Error('Insufficient available USDG.');
    const signed=await this.signer<Signed>('_signWithdraw',account.index,3,0,String(units),await this.nonce());
    const outcome=await this.submit(signed,13,{kind:'withdraw',accountIndex:account.index});
    return outcome.state==='executed'?{...outcome,message:'Withdrawal accepted by Lighter. Settlement to your wallet is still pending; check your wallet balance.'}:outcome;
  });}
  private async submit(signed:Signed,type:number,meta:Omit<Pending,'hash'|'createdAt'>):Promise<Outcome>{
    await this.identity();this.ensureClear();this.save({...meta,hash:signed.txHash,createdAt:Date.now()});
    const body=new FormData();body.set('tx_type',String(type));body.set('tx_info',signed.txInfo);body.set('price_protection','true');
    try{
      const response=await fetch(`${LIGHTER_API}/api/v1/sendTx`,{method:'POST',body,signal:AbortSignal.timeout(10_000)});
      const ack=txSchema.parse(await response.json());if(!response.ok||ack.code!==200||ack.tx_hash!==signed.txHash)throw new Error();
    }catch{/* It may have been accepted. Reconcile this exact hash; never resubmit. */}
    for(let n=0;n<10;n++){const result=await this.reconcileUnlocked();if(result.state!=='pending')return result;await this.pause(1000);}
    return {state:'pending',hash:signed.txHash,message:'Confirmation pending. Refresh status; do not submit the order again.'};
  }
  async reconcile(){return this.lock(()=>this.reconcileUnlocked());}
  private async reconcileUnlocked():Promise<Outcome>{
    const pending=this.pending();if(!pending)return this.depositStatus();
    try{
      const tx=await venueGet(`tx?by=hash&value=${pending.hash}`);if(!tx)throw new Error();
      const state=transactionState(tx,pending.hash,pending.accountIndex);
      if(state==='failed'){localStorage.removeItem(this.storageKey);return {state,hash:pending.hash,message:'Lighter rejected the transaction. No retry was sent.'};}
      if(state==='pending')throw new Error();
      if(pending.kind==='order'){
        if(!this.authorized)return {state:'pending',hash:pending.hash,message:'Reconnect trading authorization to reconcile order fills.'};
        const auth=await this.signer<{token:string}>('_createAuthToken',pending.accountIndex,KEY_INDEX);
        const orders=z.object({orders:z.array(z.unknown()),next_cursor:z.string().nullish()});
        let cursor:string|undefined,matched:unknown;
        const active=orders.parse(await venueGet(`accountActiveOrders?account_index=${pending.accountIndex}&market_id=${pending.plan!.marketId}`,auth.token));
        matched=active.orders.find(r=>(r as {client_order_index:number}).client_order_index===pending.clientOrderIndex);
        for(let n=0;!matched&&n<10;n++){
          const page=orders.parse(await venueGet(`accountInactiveOrders?account_index=${pending.accountIndex}&market_id=${pending.plan!.marketId}&limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,auth.token));
          matched=page.orders.find(r=>(r as {client_order_index:number}).client_order_index===pending.clientOrderIndex);
          if(!page.next_cursor||page.next_cursor===cursor)break;cursor=page.next_cursor;
        }
        if(!matched)throw new Error();const account=await this.refresh();if(!account)throw new Error();
        const result=reconcileOrder({accountIndex:pending.accountIndex,clientOrderIndex:pending.clientOrderIndex!,plan:pending.plan!},matched,account);
        if(!result.terminal)throw new Error();
        localStorage.removeItem(this.storageKey);
        return {state:result.state,hash:pending.hash,message:`${result.state==='filled'?'Filled':result.state==='partial'?'Partially filled':'Canceled'}: ${result.filled} ${pending.plan!.symbol}. Confirmed position: ${result.position} ${pending.plan!.symbol}.`};
      }
      localStorage.removeItem(this.storageKey);await this.refresh();
      return {state:'executed',hash:pending.hash,message:'Transaction confirmed by Lighter.'};
    }catch(error){
      const message=error instanceof Error?error.message:'';
      if(/identity mismatch|Inconsistent fill|Fill exceeds|supported precision/.test(message))return {state:'needs-review',hash:pending.hash,message:'Venue data does not match this order. Trading is blocked; inspect the position on Lighter before continuing.'};
      return {state:'pending',hash:pending.hash,message:'Awaiting confirmed transaction, fill, and position state. Refresh status to reconcile.'};
    }
  }
}

export async function connectWallet(){
  const provider=(window as Window&{ethereum?:EIP1193Provider}).ethereum;
  if(!provider)throw new Error('Open deltaLP in your wallet’s browser, or install a browser wallet.');
  const addresses=await provider.request({method:'eth_requestAccounts'});const address=addresses[0];if(!address)throw new Error('No wallet selected.');
  try{await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:toHex(chain.id)}]});}
  catch(error){if((error as {code?:number}).code!==4902)throw new Error('Switch your wallet to Robinhood Chain.');await provider.request({method:'wallet_addEthereumChain',params:[{chainId:toHex(chain.id),chainName:chain.name,nativeCurrency:chain.nativeCurrency,rpcUrls:chain.rpcUrls.default.http as unknown as string[],blockExplorerUrls:[chain.blockExplorers.default.url]}]});}
  return new TradingClient(provider,address);
}
