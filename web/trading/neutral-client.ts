import {createPublicClient,createWalletClient,custom,http,keccak256,parseAbi,parseUnits,encodeFunctionData,zeroAddress,type Address,type EIP1193Provider,type Hash,type Hex} from 'viem';
import {z} from 'zod';
import {chain,USDG} from './client.js';
import {neutralAbi,exitAbi,allocationAbi} from '../../strategy/neutral-abi.js';
import {neutralDeployments,type NeutralDeployment} from '../../strategy/neutral-deployment.js';
import {readNeutral} from '../../strategy/neutral.js';
import {receiptMinimum,usdgAmount,exitMinimum} from '../../strategy/neutral-quotes.js';

const rpc=createPublicClient({chain,transport:http(undefined,{timeout:10000,retryCount:0})});
const tokenAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)']);
const journalSchema=z.object({to:z.string().regex(/^0x[0-9a-f]{40}$/i),data:z.string().regex(/^0x[0-9a-f]*$/i),nonce:z.number().int().nonnegative(),
  label:z.string(),hash:z.string().regex(/^0x[0-9a-f]{64}$/i).optional()});
type Journal=z.infer<typeof journalSchema>;
function rejected(error:unknown):boolean{for(let n=0;error&&typeof error==='object'&&n<8;n++,error=(error as {cause?:unknown}).cause)if((error as {code?:number}).code===4001)return true;return false;}

/** User-wallet only. No server signer and no automatic retry of an ambiguous write. */
export class NeutralClient {
  constructor(readonly provider:EIP1193Provider,readonly address:Address,readonly deployment:NeutralDeployment){
    if(!neutralDeployments.some(d=>d.address===deployment.address&&d.runtimeCodeHash===deployment.runtimeCodeHash))throw new Error('Unknown neutral vault.');
  }
  private get key(){return `dlp.neutral.tx.v1.${this.deployment.address.toLowerCase()}.${this.address.toLowerCase()}`;}
  pending(){const raw=localStorage.getItem(this.key);return raw?journalSchema.parse(JSON.parse(raw)):null;}
  hasPending(){return localStorage.getItem(this.key)!==null;}
  /** Wallet cash is independent of receipt valuation, venue setup and exit history. */
  async walletBalance(){
    const [chainId,balance]=await Promise.all([
      rpc.getChainId(),
      rpc.readContract({address:USDG,abi:tokenAbi,functionName:'balanceOf',args:[this.address]}),
    ]);
    if(chainId!==4663)throw new Error('Wallet balance RPC is on the wrong chain.');
    return balance;
  }
  private async identity(){
    const [accounts,id,code]=await Promise.all([this.provider.request({method:'eth_accounts'}),this.provider.request({method:'eth_chainId'}),rpc.getCode({address:this.deployment.address})]);
    if(accounts[0]?.toLowerCase()!==this.address.toLowerCase()||Number(id)!==4663)throw new Error('Wallet changed. Reconnect to continue.');
    if(!code||keccak256(code)!==this.deployment.runtimeCodeHash)throw new Error('Vault bytecode mismatch.');
  }
  private async locked<T>(work:()=>Promise<T>){
    if(!navigator.locks)throw new Error('This wallet browser must support Web Locks to prevent duplicate transactions.');
    return navigator.locks.request(this.key,{mode:'exclusive'},async()=>{await this.identity();if(this.pending())throw new Error('Confirm the saved transaction before another action.');return work();});
  }
  private async send(to:Address,data:Hex,label:string){
    await this.identity();
    await rpc.call({account:this.address,to,data});
    const nonce=await rpc.getTransactionCount({address:this.address,blockTag:'pending'});
    const journal:Journal={to,data,nonce,label};
    localStorage.setItem(this.key,JSON.stringify(journal));
    const wallet=createWalletClient({account:this.address,chain,transport:custom(this.provider,{retryCount:0})});
    try{
      journal.hash=await wallet.sendTransaction({to,data,nonce,value:0n});
      localStorage.setItem(this.key,JSON.stringify(journal));
    }catch(error){if(rejected(error))localStorage.removeItem(this.key);throw new Error(`${label} was not confirmed. Use transaction recovery before trying again.`);}
    const receipt=await rpc.waitForTransactionReceipt({hash:journal.hash as Hash,confirmations:1,timeout:45000});
    localStorage.removeItem(this.key);
    if(receipt.status!=='success')throw new Error(`${label} reverted. Your next action will use fresh state.`);
    return receipt.transactionHash;
  }
  async reconcile(hash?:string){
    return navigator.locks.request(this.key,{mode:'exclusive'},async()=>{
      await this.identity();const journal=this.pending();if(!journal)return 'No wallet transaction is pending.';
      const candidate=hash||journal.hash;if(!candidate||!/^0x[0-9a-f]{64}$/i.test(candidate))throw new Error('Paste the transaction hash from your wallet. No transaction will be resent.');
      const tx=await rpc.getTransaction({hash:candidate as Hash});
      if(tx.from.toLowerCase()!==this.address.toLowerCase()||tx.to?.toLowerCase()!==journal.to.toLowerCase()||tx.nonce!==journal.nonce||tx.input!==journal.data||tx.value!==0n)throw new Error('That transaction does not match the saved action.');
      journal.hash=candidate;localStorage.setItem(this.key,JSON.stringify(journal));
      const receipt=await rpc.getTransactionReceipt({hash:candidate as Hash}).catch(()=>null);
      if(!receipt)return `${journal.label} is pending; no duplicate was sent.`;
      localStorage.removeItem(this.key);return receipt.status==='success'?`${journal.label} confirmed. Refreshing your position.`:`${journal.label} reverted. No duplicate was sent.`;
    });
  }
  async snapshot(){
    const state=await readNeutral(this.deployment);
    const blockNumber=BigInt(state.block),address=this.deployment.address;
    const [balance,pending,usdg,count,allocation]=await Promise.all([
      rpc.readContract({address,abi:neutralAbi,functionName:'balanceOf',args:[this.address],blockNumber}),
      rpc.readContract({address,abi:neutralAbi,functionName:'deposits',args:[this.address],blockNumber}),
      rpc.readContract({address:USDG,abi:tokenAbi,functionName:'balanceOf',args:[this.address],blockNumber}),
      rpc.readContract({address,abi:neutralAbi,functionName:'exitCount',args:[this.address],blockNumber}),
      rpc.readContract({address,abi:neutralAbi,functionName:'allocation',blockNumber}),
    ]);
    return {state,balance,pendingAssets:pending[0],minimumShares:pending[1],usdg,exitCount:count,
      issued:allocation!==zeroAddress&&await rpc.readContract({address:allocation,abi:allocationAbi,functionName:'settled',blockNumber})};
  }
  async enter(text:string){return this.locked(async()=>{
    const assets=usdgAmount(text),s=await this.snapshot();
    if(!s.state.configured||!s.state.entriesOpen||s.state.phase!==0)throw new Error('This pool is not collecting deposits right now.');
    if(assets>s.usdg)throw new Error('Your wallet has insufficient USDG.');
    const minimum=receiptMinimum(assets,BigInt(s.state.totalSupply),s.state.nav===null?null:BigInt(s.state.nav),s.state.entryFeeBps);
    const allowance=await rpc.readContract({address:USDG,abi:tokenAbi,functionName:'allowance',args:[this.address,this.deployment.address]});
    if(allowance<assets)await this.send(USDG,encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[this.deployment.address,assets]}),'USDG approval');
    await this.send(this.deployment.address,encodeFunctionData({abi:neutralAbi,functionName:'enter',args:[assets,minimum,this.address,BigInt(Math.floor(Date.now()/1000)+300)]}),'DN deposit');
    return 'Deposit received. Receipt issuance follows confirmed paired exposure and V4 liquidity.';
  });}
  async cancel(){return this.locked(async()=>{
    const s=await this.snapshot();
    if(s.pendingAssets===0n)throw new Error('No pending deposit.');
    if(s.state.phase===1){
      if(s.issued)throw new Error('Member claims have been issued. Use recovery instead.');
      await this.send(this.deployment.address,encodeFunctionData({abi:neutralAbi,functionName:'cancelAllocation'}),'Cancel allocation');
    }
    await this.send(this.deployment.address,encodeFunctionData({abi:neutralAbi,functionName:'refund',args:[this.address]}),'USDG refund');
    return 'Pending deposit returned to your wallet.';
  });}
  async recover(asUSDG:boolean,minimumText='0'){return this.locked(async()=>{
    const minimum=asUSDG?usdgAmount(minimumText):0n;
    await this.send(this.deployment.address,encodeFunctionData({abi:neutralAbi,functionName:'recoverPending',args:[asUSDG,minimum,BigInt(Math.floor(Date.now()/1000)+86400)]}),'Pending claim recovery');
    return asUSDG?'USDG exit requested. It settles after positions close and collateral returns.':'Member claims returned to your wallet.';
  });}
  async activate(){return this.locked(async()=>{
    await this.send(this.deployment.address,encodeFunctionData({abi:neutralAbi,functionName:'activate'}),'Receipt activation');
    return 'Paired pools funded and receipts issued to every depositor.';
  });}
  async exit(inKind=false){return this.locked(async()=>{
    const s=await this.snapshot();
    const minimum=inKind?0n:exitMinimum(s.balance,BigInt(s.state.totalSupply),s.state.nav===null?null:BigInt(s.state.nav),s.state.exitFeeBps);
    await this.send(this.deployment.address,encodeFunctionData({abi:neutralAbi,functionName:'requestExit',args:[s.balance,minimum,this.address,BigInt(Math.floor(Date.now()/1000)+86400)]}),'DN exit');
    return 'LP receipt burned. USDG payout is pending position reduction and collateral settlement.';
  });}
  async lowerDepositMinimum(text:string){return this.locked(async()=>{
    if(!/^\d{1,20}(\.\d{1,18})?$/.test(text))throw new Error('Enter a receipt share minimum.');
    const minimum=parseUnits(text,18);if(minimum===0n)throw new Error('Minimum must be positive.');
    await this.send(this.deployment.address,encodeFunctionData({abi:neutralAbi,functionName:'lowerMinimum',args:[minimum]}),'Receipt minimum update');
    return 'Your pending receipt minimum has been lowered.';
  });}
  async exitDetails(index:bigint){
    const address=await rpc.readContract({address:this.deployment.address,abi:neutralAbi,functionName:'exitAt',args:[this.address,index]});
    await this.assertExit(address);
    const [ready,completed,minimum,balance,queued,total,deadline]=await Promise.all([
      rpc.readContract({address,abi:exitAbi,functionName:'ready'}),rpc.readContract({address,abi:exitAbi,functionName:'completed'}),
      rpc.readContract({address,abi:exitAbi,functionName:'minimumAssets'}),rpc.readContract({address:USDG,abi:tokenAbi,functionName:'balanceOf',args:[address]}),
      rpc.readContract({address,abi:exitAbi,functionName:'queuedMembers'}),rpc.readContract({address,abi:exitAbi,functionName:'memberCount'}),
      rpc.readContract({address,abi:exitAbi,functionName:'deadline'}),
    ]);return {address,ready,completed,minimum,balance,queued,total,deadline};
  }
  private async assertExit(address:Address){
    const [owner,vault]=await Promise.all([rpc.readContract({address,abi:exitAbi,functionName:'owner'}),rpc.readContract({address,abi:exitAbi,functionName:'vault'})]);
    if(owner.toLowerCase()!==this.address.toLowerCase()||vault.toLowerCase()!==this.deployment.address.toLowerCase())throw new Error('Exit owner or vault mismatch.');
  }
  async finishExit(address:Address,inKind=false){return this.locked(async()=>{
    await this.assertExit(address);
    await this.send(address,encodeFunctionData({abi:exitAbi,functionName:inKind?'recoverInKind':'finish'}),inKind?'In-kind recovery':'USDG payout');
    return inKind?'Unsettled member claims and available USDG returned to your wallet.':'USDG paid to your recorded receiver.';
  });}
  async lowerExitMinimum(address:Address,text:string){return this.locked(async()=>{
    await this.assertExit(address);const minimum=usdgAmount(text);
    await this.send(address,encodeFunctionData({abi:exitAbi,functionName:'lowerMinimum',args:[minimum]}),'Exit minimum update');
    return 'Minimum updated. Claim when collateral settlement completes.';
  });}
  async progressExit(address:Address,extend=false){return this.locked(async()=>{
    await this.assertExit(address);
    const data=extend?encodeFunctionData({abi:exitAbi,functionName:'extendDeadline',args:[BigInt(Math.floor(Date.now()/1000)+86400)]}):encodeFunctionData({abi:exitAbi,functionName:'queue',args:[20n]});
    await this.send(address,data,extend?'Exit deadline extension':'Member redemption batch');
    return extend?'Exit deadline extended.':'Next paired redemption batch queued.';
  });}
}
