import {createPublicClient,http,keccak256,parseAbi,zeroAddress,type Address} from 'viem';
import deployment from './member-deployment.js';
import {legacyNeutralDeployment} from './legacy-neutral-deployment.js';
import {neutralAbi,allocationAbi} from './neutral-abi.js';
import {neutralDeployments,type NeutralDeployment} from './neutral-deployment.js';
import {rpcEndpoint} from './rpc-config.js';
import {nftDeployment} from './nft-deployment.js';

export type NeutralState={symbol:string;address:Address;block:string;observedAt:string;tiers:number;
  entryFeeBps:number;exitFeeBps:number;
  configured:boolean;entriesOpen:boolean;epoch:string;phase:number;pendingAssets:string;nftContributions:string;minimumBatchAssets:string;
  totalSupply:string;nav:string|null;delta:string|null;gross:string|null;allocationSettled:boolean;
  readyToActivate:boolean;activationIssue:string|null};
// This reader is also imported by the browser. Only the public endpoint belongs
// here; the server wrapper supplies its own client without importing secrets.
const publicRpc=createPublicClient({transport:http(rpcEndpoint(import.meta.env?.VITE_ROBINHOOD_RPC_URL),{timeout:10000})});
const batchAbi=parseAbi(['function currentBatch() view returns(address)','function collecting() view returns(bool)','function totalContributions() view returns(uint256)']);
// USDG minted into the NFT contribution escrow counts toward the batch minimum
// (NftContributionBatch.queue checks contributions + vault.pendingAssets) but only
// reaches vault.pendingAssets once queued, so it is read separately while collecting.
async function readNftContributions(vault:Address,rpc:typeof publicRpc,blockNumber:bigint):Promise<bigint>{
  if(!nftDeployment||nftDeployment.receipt.toLowerCase()!==vault.toLowerCase())return 0n;
  const batch=await rpc.readContract({address:nftDeployment.adapter,abi:batchAbi,functionName:'currentBatch',blockNumber}).catch(()=>zeroAddress);
  if(batch===zeroAddress)return 0n;
  const [collecting,total]=await Promise.all([
    rpc.readContract({address:batch,abi:batchAbi,functionName:'collecting',blockNumber}),
    rpc.readContract({address:batch,abi:batchAbi,functionName:'totalContributions',blockNumber}),
  ]).catch(()=>[false,0n] as const);
  return collecting?total:0n;
}
const feeAbi=parseAbi(['function ENTRY_FEE_BPS() view returns(uint256)','function EXIT_FEE_BPS() view returns(uint256)']);
export async function readNeutral(d:NeutralDeployment,rpc=publicRpc):Promise<NeutralState>{
  const legacy=d.address.toLowerCase()===legacyNeutralDeployment.address.toLowerCase();
  const expectedController=legacy?legacyNeutralDeployment.controller:deployment.contracts.MemberController.address;
  const fees=legacy?legacyNeutralDeployment:deployment.feePolicy;
  if(legacy&&d.runtimeCodeHash!==legacyNeutralDeployment.runtimeCodeHash)throw new Error('Legacy vault identity mismatch.');
  if(await rpc.getChainId()!==4663)throw new Error('Wrong chain.');
  const block=await rpc.getBlock({blockTag:'latest'});
  const call=<N extends 'controller'|'asset'|'configured'|'entriesOpen'|'tiers'|'epoch'|'phase'|'pendingAssets'|'minimumBatchAssets'|'totalSupply'|'allocation'>(functionName:N)=>rpc.readContract({address:d.address,abi:neutralAbi,functionName,blockNumber:block.number});
  const [code,controller,asset,configured,entriesOpen,tiers,epoch,phase,pending,minimum,supply,allocation]=await Promise.all([
    rpc.getCode({address:d.address,blockNumber:block.number}),call('controller'),call('asset'),call('configured'),call('entriesOpen'),call('tiers'),
    call('epoch'),call('phase'),call('pendingAssets'),call('minimumBatchAssets'),call('totalSupply'),call('allocation'),
  ]);
  if(!code||keccak256(code)!==d.runtimeCodeHash||controller.toLowerCase()!==expectedController.toLowerCase()
    ||asset.toLowerCase()!=='0x5fc5360d0400a0fd4f2af552add042d716f1d168'||tiers!==d.tiers)throw new Error('Neutral deployment mismatch.');
  const [entryFee,exitFee]=await Promise.all([
    rpc.readContract({address:controller,abi:feeAbi,functionName:'ENTRY_FEE_BPS',blockNumber:block.number}),
    rpc.readContract({address:controller,abi:feeAbi,functionName:'EXIT_FEE_BPS',blockNumber:block.number}),
  ]);
  if(entryFee!==BigInt(fees.entryFeeBps)||exitFee!==BigInt(fees.exitFeeBps))throw new Error('Neutral fee policy mismatch.');
  const [portfolio,nftContributions]=await Promise.all([
    rpc.readContract({address:d.address,abi:neutralAbi,functionName:'portfolio',blockNumber:block.number}).catch(()=>null),
    legacy?Promise.resolve(0n):readNftContributions(d.address,rpc,block.number),
  ]);
  const allocationSettled=allocation!==zeroAddress&&await rpc.readContract({address:allocation,abi:allocationAbi,functionName:'settled',blockNumber:block.number});
  let readyToActivate=false,activationIssue:string|null=null;
  if(phase===1&&allocationSettled){
    try{await rpc.simulateContract({address:d.address,abi:neutralAbi,functionName:'activate',blockNumber:block.number});readyToActivate=true;}
    catch{activationIssue='Waiting for reconciled positions, pool pricing, and deposit minimums.';}
  }
  return {symbol:d.symbol,address:d.address,block:String(block.number),observedAt:new Date(Number(block.timestamp)*1000).toISOString(),tiers,
    entryFeeBps:Number(entryFee),exitFeeBps:Number(exitFee),
    configured,entriesOpen,epoch:String(epoch),phase,pendingAssets:String(pending),nftContributions:String(nftContributions),minimumBatchAssets:String(minimum),totalSupply:String(supply),
    nav:portfolio?String(portfolio[0]):null,delta:portfolio?String(portfolio[1]):null,gross:portfolio?String(portfolio[2]):null,
    allocationSettled,readyToActivate,activationIssue};
}
