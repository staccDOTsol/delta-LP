import {keccak256,type PublicClient} from 'viem';
import {nftDeployment} from '../strategy/nft-deployment.js';
import {nftOwner,nftPins} from '../strategy/nft-pins.js';
import {nftAbi,adapterAbi,readNftSale,QUOTER,quoterAbi,nftPool} from '../strategy/nft-sale.js';
import {planNftSale,quoteFloor,quoteSizes,type NftSalePolicy} from '../nft/sale-policy.js';

export async function verifyNftSale(client:PublicClient){
  if(await client.getChainId()!==4663||!nftDeployment)throw new Error('NFT deployment is unavailable on this chain.');
  // Sequential reads keep public RPC load bounded during startup.
  for(const pin of nftPins){
    const code=await client.getCode({address:pin.address});
    if(!code||keccak256(code)!==pin.runtimeCodeHash)throw new Error('NFT dependency bytecode mismatch.');
  }
  for(const address of [nftDeployment.adapter,...nftDeployment.collections.map(c=>c.address)]){
    if((await client.readContract({address,abi:adapterAbi,functionName:'owner'})).toLowerCase()!==nftOwner.toLowerCase())throw new Error('NFT owner changed; review the operator.');
  }
}
export async function executableNftQuote(client:PublicClient,amount:bigint){
  const {result}=await client.simulateContract({address:QUOTER,abi:quoterAbi,functionName:'quoteExactInputSingle',args:[{poolKey:nftPool,zeroForOne:true,exactAmount:amount,hookData:'0x'}]});
  if(result[0]<=0n)throw new Error('No executable ETH/USDG quote.');
  return {native:amount,usdg:result[0]};
}
export async function observeNftSale(client:PublicClient,policy:NftSalePolicy){
  if(!nftDeployment)throw new Error('NFT deployment missing.');
  const states=[];
  for(const c of nftDeployment.collections)states.push(await readNftSale(client,c.address));
  const samples=[];for(const amount of quoteSizes(policy))samples.push(await executableNftQuote(client,amount));
  const minimum=quoteFloor(samples,policy),now=Math.floor(Date.now()/1000);
  return {states,calls:planNftSale(policy,states,minimum,now),status:{kind:'nft-sale' as const,at:new Date().toISOString(),block:String(states[0].block),
    collections:states.map((s,i)=>({address:nftDeployment!.collections[i].address,paused:s.paused,minted:String(s.totalMinted)})),
    quoteExpiresAt:Math.min(...states.map(s=>s.quoteValidUntil),states[0].adapter.validUntil)}};
}
export function nftOperation(address:string,name:string){
  if(address.toLowerCase()===nftDeployment?.adapter.toLowerCase()&&['setQuote','setPaused'].includes(name))return adapterAbi;
  if(nftDeployment?.collections.some(c=>c.address.toLowerCase()===address.toLowerCase())&&['setFundingQuote','updatePublicDrop','setPaused'].includes(name))return nftAbi;
  throw new Error('Unrecognized NFT sale operation.');
}
