import {readFileSync} from 'node:fs';
import {createPublicClient,defineChain,http,keccak256,parseAbi,type Address,type Hex} from 'viem';
import {z} from 'zod';
import deployment from '../strategy/member-deployment.js';
import {LIGHTER_API} from '../strategy/lighter.js';
import {neutralAbi,allocationAbi} from '../strategy/neutral-abi.js';
import {controllerAbi,custodyAbi,exitAbi} from './abi.js';
import type {Action,Request,Snapshot} from './model.js';
import {serverRpcUrl} from '../strategy/server-rpc.js';

export const RPC=serverRpcUrl;
export const controller=deployment.contracts.MemberController.address;
export const vault=deployment.contracts.NeutralVault.address;
export const usdg='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const lighter='0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d';
export const chain=defineChain({id:4663,name:'Robinhood Chain',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[RPC]}},
  contracts:{multicall3:{address:'0xcA11bde05977b3631167028862bE2a173976CA11'}}});
export const erc20=parseAbi(['function balanceOf(address) view returns(uint256)','function totalSupply() view returns(uint256)']);
export const lighterAbi=parseAbi(['function executedPriorityRequestCount() view returns(uint64)',
  'function addressToAccountIndex(address) view returns(uint48)','function getPendingBalance(address,uint16) view returns(uint128)']);
// This chain's public endpoint does not reliably support JSON-RPC batch arrays.
export const client=createPublicClient({chain,batch:{multicall:{batchSize:65536,wait:10}},transport:http(RPC,{timeout:10000,retryCount:1})});
if(!/^4663-neutral-v[1-9][0-9]*-registry\.json$/.test(deployment.registryFile))throw new Error('Invalid keeper registry filename.');
const registry=JSON.parse(readFileSync(new URL(`../evm/deployments/${deployment.registryFile}`,import.meta.url),'utf8')) as {
  members:{id:string;token:Address;custody:Address;tokenCodeHash:Hex;custodyCodeHash:Hex}[]};
const genesis=BigInt(deployment.genesisBlock);
const exitEvents=parseAbi(['event ExitRequested(address indexed owner, address indexed receiver, uint256 shares, address exitEscrow)',
  'event PendingRecovered(uint256 indexed epoch, address indexed owner, address exitEscrow)']);

export async function venue(path:string){
  const r=await fetch(`${LIGHTER_API}/api/v1/${path}`,{signal:AbortSignal.timeout(8000),redirect:'error'});
  if(!r.ok)throw new Error(`Lighter ${path.split('?')[0]} returned HTTP ${r.status}.`);
  const body=await r.json();if(body.code!==200)throw new Error(`Lighter ${path.split('?')[0]} did not return success.`);
  return body as Record<string,unknown>;
}
export async function mapLimit<T,R>(items:T[],limit:number,fn:(item:T)=>Promise<R>):Promise<R[]>{
  const out:R[]=new Array(items.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const i=cursor++;out[i]=await fn(items[i]);}}));return out;
}
export async function verifyDeployment(){
  if(await client.getChainId()!==4663)throw new Error('Wrong keeper chain.');
  const feeAbi=parseAbi(['function ENTRY_FEE_BPS() view returns(uint256)','function EXIT_FEE_BPS() view returns(uint256)','function FEE_FANOUT() view returns(address)']);
  const [entryFee,exitFee,feeRecipient]=await Promise.all([
    client.readContract({address:controller,abi:feeAbi,functionName:'ENTRY_FEE_BPS'}),
    client.readContract({address:controller,abi:feeAbi,functionName:'EXIT_FEE_BPS'}),
    client.readContract({address:controller,abi:feeAbi,functionName:'FEE_FANOUT'}),
  ]);
  if(entryFee!==BigInt(deployment.feePolicy.entryFeeBps)||exitFee!==BigInt(deployment.feePolicy.exitFeeBps)||feeRecipient.toLowerCase()!==deployment.fanout.toLowerCase())throw new Error('Keeper fee policy mismatch.');
  const multicallCode=await client.getCode({address:chain.contracts.multicall3.address});
  if(!multicallCode||keccak256(multicallCode)!=='0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891')throw new Error('Multicall runtime mismatch.');
  await mapLimit(Object.values(deployment.contracts),6,async e=>{
    const code=await client.getCode({address:e.address});if(!code||keccak256(code)!==e.runtimeCodeHash)throw new Error('Keeper deployment runtime mismatch.');
  });
  const count=await client.readContract({address:controller,abi:controllerAbi,functionName:'memberCount'});
  if(count!==100n||registry.members.length!==100)throw new Error('Expected the complete frozen v3 ETH family.');
  // The pinned controller/factory create immutable children (no upgrade or
  // self-destruct path). Check every child's factory-recorded identity in the
  // per-block snapshot, without 200 rate-limited eth_getCode calls per restart.
}

/** Public action index, rebuilt from confirmed logs on startup. No local flag can
 * turn an unconfirmed action into a confirmed one. Recent blocks are replayed. */
export class ChainIndex {
  private next=genesis;
  private actions=new Map<string,{member:bigint;action:Action}>();
  private requests=new Map<string,bigint>();
  private exits=new Map<Address,bigint>();
  async update(block:bigint){
    const from=this.next>genesis+64n?this.next-64n:genesis;
    for(const [key,v] of this.actions)if(v.action.block>=from)this.actions.delete(key);
    for(const [key,value] of this.exits)if(value>=from)this.exits.delete(key);
    // Request IDs are reread from storage; reverted IDs return an empty owner.
    for(let start=from;start<=block;start+=2000n){
      const end=start+1999n<block?start+1999n:block;
      const [actions,requests,exits,recoveries]=await Promise.all([
        client.getContractEvents({address:controller,abi:controllerAbi,eventName:'VenueAction',fromBlock:start,toBlock:end,strict:true}),
        client.getContractEvents({address:controller,abi:controllerAbi,eventName:'Requested',fromBlock:start,toBlock:end,strict:true}),
        client.getContractEvents({address:vault,abi:exitEvents,eventName:'ExitRequested',fromBlock:start,toBlock:end,strict:true}),
        client.getContractEvents({address:vault,abi:exitEvents,eventName:'PendingRecovered',fromBlock:start,toBlock:end,strict:true}),
      ]);
      for(const log of actions)this.actions.set(`${log.transactionHash}:${log.logIndex}`,{member:log.args.member,action:{nonce:log.args.nonce,kind:log.args.kind,amount:log.args.amount,hash:log.transactionHash,block:log.blockNumber}});
      for(const log of requests)this.requests.set(String(log.args.request),log.args.member);
      for(const log of [...exits,...recoveries])if(log.args.exitEscrow!=='0x0000000000000000000000000000000000000000')this.exits.set(log.args.exitEscrow,log.blockNumber);
    }
    this.next=block+1n;
  }
  memberActions(id:bigint){return [...this.actions.values()].filter(a=>a.member===id).map(a=>a.action).sort((a,b)=>a.nonce<b.nonce?-1:a.nonce>b.nonce?1:0);}
  async pendingExits(blockNumber:bigint){
    const rows=await mapLimit([...this.exits.keys()],8,async address=>{
      const read=<N extends 'vault'|'controller'|'started'|'completed'|'deadline'|'queuedMembers'|'memberCount'|'ready'>(functionName:N)=>client.readContract({address,abi:exitAbi,functionName,blockNumber});
      const [v,c,started,completed,deadline,queued,count,ready]=await Promise.all([read('vault'),read('controller'),read('started'),read('completed'),read('deadline'),read('queuedMembers'),read('memberCount'),read('ready')]);
      if(v!==vault||c!==controller||count!==100n)throw new Error('Exit escrow identity mismatch.');
      return {address,started,completed,deadline,queued,count,ready};
    });return rows.filter(row=>!row.completed);
  }
  async pendingRequests(blockNumber:bigint){
    const rows=await mapLimit([...this.requests.keys()],8,async (id):Promise<Request|null>=>{
      const request=BigInt(id);
      const [r,batch]=await Promise.all([
        client.readContract({address:controller,abi:controllerAbi,functionName:'requests',args:[request],blockNumber}),
        client.readContract({address:controller,abi:controllerAbi,functionName:'requestBatch',args:[request],blockNumber}),
      ]);
      if(r[0]==='0x0000000000000000000000000000000000000000'||r[8])return null;
      return {id:request,member:r[2],amount:r[3],minimum:r[4],createdAt:r[5],deadline:r[6],redeem:r[7],completed:r[8],batch} satisfies Request;
    });return rows.filter((r):r is Request=>r!==null);
  }
}

export async function readMember(id:bigint,blockNumber:bigint,executedPriorityCount:bigint,index:ChainIndex,requests:Request[]):Promise<Snapshot>{
  const [m,setup]=await Promise.all([
    client.readContract({address:controller,abi:controllerAbi,functionName:'memberState',args:[id],blockNumber}),
    client.readContract({address:controller,abi:controllerAbi,functionName:'venueSetup',args:[id],blockNumber}),
  ]);
  const registered=registry.members.find(row=>row.id===String(id));
  if(!registered||registered.token.toLowerCase()!==m.token.toLowerCase()||registered.custody.toLowerCase()!==m.custody.toLowerCase())throw new Error('Member registry mismatch.');
  const [accountIndex,bound,priorityEnd,mappedIndex,supply,pendingWithdrawal,custodyCash]=await Promise.all([
    client.readContract({address:m.custody,abi:custodyAbi,functionName:'accountIndex',blockNumber}),
    client.readContract({address:m.custody,abi:custodyAbi,functionName:'bound',blockNumber}),
    client.readContract({address:m.custody,abi:custodyAbi,functionName:'priorityEnd',blockNumber}),
    client.readContract({address:lighter,abi:lighterAbi,functionName:'addressToAccountIndex',args:[m.custody],blockNumber}),
    client.readContract({address:m.token,abi:erc20,functionName:'totalSupply',blockNumber}),
    client.readContract({address:lighter,abi:lighterAbi,functionName:'getPendingBalance',args:[m.custody,3],blockNumber}),
    client.readContract({address:usdg,abi:erc20,functionName:'balanceOf',args:[m.custody],blockNumber}),
  ]);
  return {...m,id,accountIndex:Number(accountIndex),bound,priorityEnd,mappedIndex:Number(mappedIndex),supply,
    executedPriorityCount,pendingWithdrawal,custodyCash,setup:{publicKeyHash:setup[0],initialMarginBps:setup[1],generation:setup[2],pending:setup[3]},
    actions:index.memberActions(id),requests:requests.filter(r=>r.member===id)};
}

export async function marketData(){
  const [markets,book]=await Promise.all([venue('orderBookDetails?market_id=0'),venue('orderBookOrders?market_id=0&limit=100')]);
  const rows=z.array(z.object({market_id:z.number(),symbol:z.string()}).passthrough()).parse(markets.order_book_details);
  const market=rows.find(r=>r.market_id===0&&r.symbol==='ETH');if(!market)throw new Error('ETH market missing.');
  return {market,book,fetchedAt:Date.now()};
}
export async function readVault(blockNumber:bigint){
  const names=['configured','entriesOpen','phase','pendingAssets','minimumBatchAssets','allocation','epoch'] as const;
  const values=await Promise.all(names.map(functionName=>client.readContract({address:vault,abi:neutralAbi,functionName,blockNumber})));
  const allocation=values[5] as Address;
  const settled=allocation!=='0x0000000000000000000000000000000000000000'&&await client.readContract({address:allocation,abi:allocationAbi,functionName:'settled',blockNumber});
  const first=allocation!=='0x0000000000000000000000000000000000000000'?await client.readContract({address:allocation,abi:parseAbi(['function firstRequest() view returns(uint256)']),functionName:'firstRequest',blockNumber}):0n;
  return {configured:values[0] as boolean,entriesOpen:values[1] as boolean,phase:Number(values[2]),pendingAssets:values[3] as bigint,
    minimumBatchAssets:values[4] as bigint,allocation,epoch:values[6] as bigint,settled,first};
}
