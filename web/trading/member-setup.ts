import {createPublicClient,createWalletClient,custom,http,keccak256,parseAbi,type Address,type EIP1193Provider,type Hash} from 'viem';
import {z} from 'zod';
import deployment from '../../strategy/member-deployment.js';
import {memberOperatorAbi} from '../../strategy/member-setup-abi.js';
import {MEMBER_KEY_SLOT,memberMarginPlan,registeredMemberKey,setupKeyMessage,venuePublicKey,type SetupState} from '../../strategy/member-setup.js';
import {accountSchema,exactUnits,transactionState} from '../../strategy/execution.js';
import {memberMarketSchema} from '../../strategy/member-reconciliation.js';
import {chain,venueGet} from './client.js';
import {wasm} from './wasm.js';

const rpc=createPublicClient({chain,transport:http(undefined,{timeout:10000,retryCount:0})});
const custodyAbi=parseAbi(['function accountIndex() view returns(uint48)','function bound() view returns(bool)','function priorityProcessed() view returns(bool)']);
const controller=deployment.contracts.MemberController.address as Address;
type Pending={kind:'key'|'margin';generation:string;publicKey:string;hash?:Hash;venueHash?:string;createdAt:number};
const pendingSchema=z.object({kind:z.enum(['key','margin']),generation:z.string().regex(/^[1-9]\d*$/),publicKey:z.string(),
  hash:z.string().regex(/^0x[0-9a-f]{64}$/i).optional(),venueHash:z.string().min(1).max(200).optional(),createdAt:z.number().int().nonnegative()});
function rejectedByUser(error:unknown):boolean {
  for(let depth=0;error&&typeof error==='object'&&depth<8;depth++){
    if((error as {code?:number}).code===4001)return true;
    error=(error as {cause?:unknown}).cause;
  }
  return false;
}

/** User-operated key/margin setup only. This client cannot fund an account or place an order. */
export class MemberSetupClient {
  constructor(readonly provider:EIP1193Provider,readonly owner:Address,readonly member:bigint,private signer:typeof wasm=wasm){}
  private get journal(){return `dlp.member.setup.v1.${controller.toLowerCase()}.${this.member}.${this.owner.toLowerCase()}`;}
  private wallet(){return createWalletClient({account:this.owner,chain,transport:custom(this.provider,{retryCount:0})});}
  private save(p:Pending){localStorage.setItem(this.journal,JSON.stringify(p));}
  pending():Pending|null {
    const raw=localStorage.getItem(this.journal);if(!raw)return null;
    const p=pendingSchema.parse(JSON.parse(raw));venuePublicKey(p.publicKey);
    if(p.kind==='margin'&&!p.venueHash)throw new Error('Pending margin hash is missing. Inspect the saved setup journal.');
    return p as Pending;
  }
  private async locked<T>(work:()=>Promise<T>){
    if(!navigator.locks)throw new Error('Use a browser with Web Locks for account setup.');
    return navigator.locks.request(this.journal,{mode:'exclusive'},work);
  }
  private async identity(){
    const [accounts,chainId]=await Promise.all([this.provider.request({method:'eth_accounts'}),this.provider.request({method:'eth_chainId'})]);
    if(accounts[0]?.toLowerCase()!==this.owner.toLowerCase()||Number(chainId)!==4663)throw new Error('Wallet account or network changed.');
  }
  async snapshot(){
    const blockNumber=await rpc.getBlockNumber({cacheTime:0});
    const code=await rpc.getCode({address:controller,blockNumber});
    if(!code||keccak256(code)!==deployment.contracts.MemberController.runtimeCodeHash)throw new Error('Controller code does not match the deployment.');
    const [owner,count]=await Promise.all([
      rpc.readContract({address:controller,abi:memberOperatorAbi,functionName:'owner',blockNumber}),
      rpc.readContract({address:controller,abi:memberOperatorAbi,functionName:'memberCount',blockNumber}),
    ]);
    if(owner.toLowerCase()!==this.owner.toLowerCase())throw new Error('Connect the controller owner wallet.');
    if(this.member<1n||this.member>count)throw new Error(`No member ${this.member}. The controller has ${count} registered members.`);
    const [m,s]=await Promise.all([
      rpc.readContract({address:controller,abi:memberOperatorAbi,functionName:'memberState',args:[this.member],blockNumber}),
      rpc.readContract({address:controller,abi:memberOperatorAbi,functionName:'venueSetup',args:[this.member],blockNumber}),
    ]);
    const [accountIndex,bound,priorityProcessed]=await Promise.all([
      rpc.readContract({address:m.custody,abi:custodyAbi,functionName:'accountIndex',blockNumber}),
      rpc.readContract({address:m.custody,abi:custodyAbi,functionName:'bound',blockNumber}),
      rpc.readContract({address:m.custody,abi:custodyAbi,functionName:'priorityProcessed',blockNumber}),
    ]);
    if(!bound||accountIndex<=2)throw new Error('The custody account must be funded and bound before key setup.');
    const setup:SetupState={publicKeyHash:s[0],initialMarginBps:s[1],generation:s[2],pending:s[3]};
    return {custody:m.custody,accountIndex,market:m.market,leverage:m.leverage,setup,priorityProcessed};
  }
  private async key(s:Awaited<ReturnType<MemberSetupClient['snapshot']>>,generation:bigint){
    await this.identity();
    const signature=await this.wallet().signMessage({message:setupKeyMessage({controller,custody:s.custody,owner:this.owner,member:this.member,accountIndex:s.accountIndex,generation},location.origin)});
    const seed=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(signature)))).map(b=>b.toString(16).padStart(2,'0')).join('');
    const generated=await this.signer<{pk:string}>('_createClient',seed,466324,s.accountIndex,0,MEMBER_KEY_SLOT,false);
    return venuePublicKey(generated.pk);
  }
  private async keys(index:number){return venueGet(`apikeys?account_index=${index}&api_key_index=255`);}
  async register(marginBps:number){return this.locked(async()=>{
    await this.identity();if(this.pending())throw new Error('Reconcile the pending setup before another registration.');
    if(!Number.isInteger(marginBps)||marginBps<1||marginBps>10000)throw new Error('Margin must be 1–10,000 basis points.');
    const s=await this.snapshot();
    // Existing key lookup must succeed before requesting an owner signature.
    registeredMemberKey(await this.keys(s.accountIndex),s.accountIndex);
    const generation=s.setup.generation+1n,publicKey=await this.key(s,generation);
    const fresh=await this.snapshot();
    if(fresh.setup.generation!==s.setup.generation)throw new Error('Key generation changed. Refresh setup.');
    const request={address:controller,abi:memberOperatorAbi,functionName:'configureVenueKey' as const,args:[this.member,publicKey,marginBps] as const,account:this.owner};
    await rpc.simulateContract(request);
    const pending:Pending={kind:'key',generation:String(generation),publicKey,createdAt:Date.now()};
    this.save(pending); // journal even an ambiguous wallet/RPC response
    try {await this.identity();pending.hash=await this.wallet().writeContract(request);this.save(pending);}
    catch(error){if(rejectedByUser(error))localStorage.removeItem(this.journal);throw new Error('Registration was not confirmed. Refresh setup before retrying.');}
    return 'Registration submitted. Entries are paused until the registered key and margin are reconciled.';
  });}
  async configureMargin(){return this.locked(async()=>{
    await this.identity();if(this.pending())throw new Error('Reconcile the pending transaction first.');
    const s=await this.snapshot();if(!s.priorityProcessed)throw new Error('The L1 priority request is still pending.');
    const [keys,accounts,markets]=await Promise.all([this.keys(s.accountIndex),venueGet(`account?by=index&value=${s.accountIndex}`),venueGet(`orderBookDetails?market_id=${s.market}`)]);
    const account=z.object({accounts:z.array(accountSchema)}).parse(accounts).accounts.find(a=>a.index===s.accountIndex);
    const market=z.object({order_book_details:z.array(memberMarketSchema)}).parse(markets).order_book_details.find(m=>m.market_id===s.market);
    const plan=memberMarginPlan(s,s.setup,account,market,keys);
    const publicKey=await this.key(s,s.setup.generation);
    if(keccak256(publicKey)!==s.setup.publicKeyHash)throw new Error('This signature does not recover the registered operator key. Rotate the key to recover access.');
    const nonce=z.object({nonce:z.number().int().safe().nonnegative()}).parse(await venueGet(`nextNonce?account_index=${s.accountIndex}&api_key_index=${MEMBER_KEY_SLOT}`)).nonce;
    const fresh=await this.snapshot();
    if(fresh.setup.generation!==s.setup.generation||!fresh.setup.pending||fresh.setup.initialMarginBps!==s.setup.initialMarginBps)throw new Error('Setup changed before signing.');
    const signed=await this.signer<{txHash:string;txInfo:string}>('_signUpdateLeverage',plan.accountIndex,plan.marketId,plan.initialMarginBps,plan.marginMode,nonce);
    const pending:Pending={kind:'margin',generation:String(s.setup.generation),publicKey,venueHash:signed.txHash,createdAt:Date.now()};
    await this.identity();this.save(pending);
    const body=new FormData();body.set('tx_type','20');body.set('tx_info',signed.txInfo);
    try{await fetch('https://api.rh.lighter.xyz/api/v1/sendTx',{method:'POST',body,signal:AbortSignal.timeout(10000)});}catch{/* Resolve the exact persisted hash, never resend on timeout. */}
    return 'Margin update submitted. Refresh to confirm the transaction and the observed account setting.';
  });}
  async abandonMargin(){return this.locked(async()=>{
    await this.identity();if(this.pending())throw new Error('Reconcile the pending transaction first.');
    const s=await this.snapshot();if(!s.setup.pending)throw new Error('No setup is pending.');
    const request={address:controller,abi:memberOperatorAbi,functionName:'abandonVenueMargin' as const,args:[this.member] as const,account:this.owner};
    await rpc.simulateContract(request);await this.wallet().writeContract(request);
    return 'Margin requirement removal submitted. Entries remain paused; the reporter must still verify the installed key and current account state.';
  });}
  async reconcile(){return this.locked(async()=>{
    const s=await this.snapshot(),p=this.pending();
    if(!p)return s.setup.pending?'Setup pending. Register the key, configure margin, then submit a verified reporter candidate.':'No setup transaction pending.';
    if(BigInt(p.generation)!==s.setup.generation||keccak256(venuePublicKey(p.publicKey))!==s.setup.publicKeyHash){
      if(s.setup.generation>BigInt(p.generation)&&s.priorityProcessed){
        const latest=registeredMemberKey(await this.keys(s.accountIndex),s.accountIndex);
        if(latest&&keccak256(latest)===s.setup.publicKeyHash){
          localStorage.removeItem(this.journal);
          return 'A newer registered key replaced this setup. The old transaction was not retried; inspect current account state before continuing.';
        }
      }
      if(p.kind==='key'&&p.hash){const receipt=await rpc.getTransactionReceipt({hash:p.hash}).catch(()=>null);if(receipt?.status==='reverted'){localStorage.removeItem(this.journal);return 'Registration reverted. No retry was sent.';}}
      return 'Registration is unconfirmed or superseded. Inspect the saved transaction and current key generation before recovery.';
    }
    if(!s.priorityProcessed)return 'L1 priority execution is pending.';
    const key=registeredMemberKey(await this.keys(s.accountIndex),s.accountIndex);
    if(!key||keccak256(key)!==s.setup.publicKeyHash)return 'The requested public key is not yet visible at Lighter.';
    if(p.kind==='margin'){
      const status=transactionState(await venueGet(`tx?by=hash&value=${p.venueHash}`),p.venueHash!,s.accountIndex);
      if(status==='pending')return 'Margin transaction is pending.';
      if(status==='failed'){localStorage.removeItem(this.journal);return 'Margin update failed. No retry was sent.';}
      const accounts=z.object({accounts:z.array(accountSchema)}).parse(await venueGet(`account?by=index&value=${s.accountIndex}`));
      const account=accounts.accounts.find(a=>a.index===s.accountIndex&&a.l1_address.toLowerCase()===s.custody.toLowerCase());
      const rows=account?.positions.filter(r=>r.market_id===s.market);
      if(!rows||rows.length!==1||rows[0].margin_mode!==0||exactUnits(rows[0].initial_margin_fraction,2)!==BigInt(s.setup.initialMarginBps))return 'Transaction executed; the requested cross-margin setting is not yet confirmed.';
    }
    localStorage.removeItem(this.journal);
    return p.kind==='key'?'Registered key confirmed. Continue with margin configuration.':'Margin confirmed. The reporter must still reconcile account equity, queue execution and setup evidence before entries can reopen.';
  });}
}
