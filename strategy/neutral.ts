import {createPublicClient,http,keccak256,zeroAddress,type Address} from 'viem';
import deployment from './member-deployment.js';
import {neutralAbi,allocationAbi} from './neutral-abi.js';
import {neutralDeployments,type NeutralDeployment} from './neutral-deployment.js';

export type NeutralState={symbol:string;address:Address;block:string;observedAt:string;tiers:number;
  configured:boolean;entriesOpen:boolean;epoch:string;phase:number;pendingAssets:string;minimumBatchAssets:string;
  totalSupply:string;nav:string|null;delta:string|null;gross:string|null;allocationSettled:boolean;
  readyToActivate:boolean;activationIssue:string|null};
const rpc=createPublicClient({transport:http('https://rpc.mainnet.chain.robinhood.com',{timeout:10000})});
export async function readNeutral(d:NeutralDeployment):Promise<NeutralState>{
  if(await rpc.getChainId()!==4663)throw new Error('Wrong chain.');
  const block=await rpc.getBlock({blockTag:'latest'});
  const call=<N extends 'controller'|'asset'|'configured'|'entriesOpen'|'tiers'|'epoch'|'phase'|'pendingAssets'|'minimumBatchAssets'|'totalSupply'|'allocation'>(functionName:N)=>rpc.readContract({address:d.address,abi:neutralAbi,functionName,blockNumber:block.number});
  const [code,controller,asset,configured,entriesOpen,tiers,epoch,phase,pending,minimum,supply,allocation]=await Promise.all([
    rpc.getCode({address:d.address,blockNumber:block.number}),call('controller'),call('asset'),call('configured'),call('entriesOpen'),call('tiers'),
    call('epoch'),call('phase'),call('pendingAssets'),call('minimumBatchAssets'),call('totalSupply'),call('allocation'),
  ]);
  if(!code||keccak256(code)!==d.runtimeCodeHash||controller.toLowerCase()!==deployment.contracts.MemberController.address.toLowerCase()
    ||asset.toLowerCase()!=='0x5fc5360d0400a0fd4f2af552add042d716f1d168'||tiers!==d.tiers)throw new Error('Neutral deployment mismatch.');
  const portfolio=await rpc.readContract({address:d.address,abi:neutralAbi,functionName:'portfolio',blockNumber:block.number}).catch(()=>null);
  const allocationSettled=allocation!==zeroAddress&&await rpc.readContract({address:allocation,abi:allocationAbi,functionName:'settled',blockNumber:block.number});
  let readyToActivate=false,activationIssue:string|null=null;
  if(phase===1&&allocationSettled){
    try{await rpc.simulateContract({address:d.address,abi:neutralAbi,functionName:'activate',blockNumber:block.number});readyToActivate=true;}
    catch{activationIssue='Waiting for reconciled positions, pool pricing, and deposit minimums.';}
  }
  return {symbol:d.symbol,address:d.address,block:String(block.number),observedAt:new Date(Number(block.timestamp)*1000).toISOString(),tiers,
    configured,entriesOpen,epoch:String(epoch),phase,pendingAssets:String(pending),minimumBatchAssets:String(minimum),totalSupply:String(supply),
    nav:portfolio?String(portfolio[0]):null,delta:portfolio?String(portfolio[1]):null,gross:portfolio?String(portfolio[2]):null,
    allocationSettled,readyToActivate,activationIssue};
}
let cached:{at:number;value:NeutralState[]}|undefined,pending:Promise<NeutralState[]>|undefined;
export async function neutralState(){
  if(cached&&Date.now()-cached.at<10000)return cached.value;
  if(pending)return pending;
  pending=Promise.all(neutralDeployments.map(readNeutral));
  try{const value=await pending;cached={at:Date.now(),value};return value;}finally{pending=undefined;}
}
