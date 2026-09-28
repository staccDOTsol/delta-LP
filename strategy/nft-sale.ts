import {parseAbi,zeroAddress,type Address,type PublicClient} from 'viem';
import {nftDeployment} from './nft-deployment.js';

export const SEA_DROP='0x00005EA00Ac477B1030CE78506496e8C2dE24bf5' as const;
export const NFT_FEE_RECIPIENT='0x0000a26b00c1F0DF003000390027140000fAa719' as const;
export const QUOTER='0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94' as const;
export const nftAbi=parseAbi([
  'struct PublicDrop { uint80 mintPrice; uint48 startTime; uint48 endTime; uint16 maxTotalMintableByWallet; uint16 feeBps; bool restrictFeeRecipients; }',
  'function owner() view returns(address)', 'function paused() view returns(bool)',
  'function configured() view returns(bool)', 'function totalMinted() view returns(uint256)',
  'function mintedBy(address) view returns(uint256)', 'function quoteValidUntil() view returns(uint48)',
  'function minUSDGPerEth() view returns(uint256)',
  'function setFundingQuote(uint256 minimum,uint48 validUntil)',
  'function setPaused(bool value)', 'function updatePublicDrop(address seaDropImpl,PublicDrop value)',
]);
export const adapterAbi=parseAbi([
  'function owner() view returns(address)', 'function paused() view returns(bool)',
  'function ready() view returns(bool)', 'function minimumUsdPerEth() view returns(uint256)',
  'function remainingNative() view returns(uint256)', 'function validUntil() view returns(uint48)',
  'function setQuote(uint256 minimumUsd,uint256 nativeCap,uint48 expiry)', 'function setPaused(bool value)',
]);
export const seaDropAbi=parseAbi([
  'struct PublicDrop { uint80 mintPrice; uint48 startTime; uint48 endTime; uint16 maxTotalMintableByWallet; uint16 feeBps; bool restrictFeeRecipients; }',
  'function getPublicDrop(address nftContract) view returns(PublicDrop)',
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
]);
export const quoterAbi=parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns(uint256 amountOut,uint256 gasEstimate)',
]);
export const nftPool={currency0:zeroAddress,currency1:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',fee:8388608,tickSpacing:60,hooks:'0xC74E7983718DAEEfE5dA80690Afbd65d7eF74088'} as const;
export type PublicDrop={mintPrice:bigint;startTime:number;endTime:number;maxTotalMintableByWallet:number;feeBps:number;restrictFeeRecipients:boolean};
export type NftSaleState={block:bigint;timestamp:number;paused:boolean;configured:boolean;totalMinted:bigint;mintedBy:bigint;
  quoteValidUntil:number;floor:bigint;drop:PublicDrop;adapter:{paused:boolean;ready:boolean;floor:bigint;cap:bigint;validUntil:number}};
export function strategyNative(gross:bigint){return gross-gross*1000n/10000n-gross*100n/10000n;}
export function mintUnavailable(s:NftSaleState,quantity:number,now:number):string|null{
  if(!Number.isInteger(quantity)||quantity<1||quantity>20)return 'Choose 1–20 NFTs per mint.';
  if(now-s.timestamp>90||s.timestamp>now+15)return 'Sale status is stale. Refresh before minting.';
  if(s.paused||!s.configured)return 'Minting is paused on-chain.';
  if(s.drop.mintPrice===0n)return 'The mint price has not been set.';
  if(s.drop.feeBps!==1000||!s.drop.restrictFeeRecipients)return 'The sale fee configuration does not match this collection.';
  if(now<s.drop.startTime)return 'This sale has not started.';
  if(now>=s.drop.endTime)return 'This sale has ended.';
  if(s.totalMinted+BigInt(quantity)>10000n)return 'This quantity exceeds the remaining supply.';
  if(s.mintedBy+BigInt(quantity)>BigInt(s.drop.maxTotalMintableByWallet))return 'This quantity exceeds your wallet mint limit.';
  if(s.quoteValidUntil<=now+30||s.adapter.validUntil<=now+30||!s.adapter.ready)return 'Waiting for a fresh funding quote.';
  if(s.adapter.cap<strategyNative(s.drop.mintPrice*BigInt(quantity)))return 'The funding quote capacity is too small for this mint.';
  return null;
}
export async function readNftSale(client:PublicClient,address:Address,wallet:Address=zeroAddress):Promise<NftSaleState>{
  if(!nftDeployment?.collections.some(c=>c.address.toLowerCase()===address.toLowerCase()))throw new Error('Unknown NFT collection.');
  const [chainId,head]=await Promise.all([client.getChainId(),client.getBlockNumber({cacheTime:0})]);
  if(chainId!==4663)throw new Error('Wrong NFT chain.');
  // The chain's load-balanced RPC occasionally lags its reported head.
  const blockNumber=head>32n?head-32n:head;
  const [block,values]=await Promise.all([client.getBlock({blockNumber}),client.multicall({blockNumber,multicallAddress:'0xcA11bde05977b3631167028862bE2a173976CA11',allowFailure:false,contracts:[
    {address,abi:nftAbi,functionName:'paused'}, {address,abi:nftAbi,functionName:'configured'},
    {address,abi:nftAbi,functionName:'totalMinted'}, {address,abi:nftAbi,functionName:'mintedBy',args:[wallet]},
    {address,abi:nftAbi,functionName:'quoteValidUntil'}, {address,abi:nftAbi,functionName:'minUSDGPerEth'},
    {address:SEA_DROP,abi:seaDropAbi,functionName:'getPublicDrop',args:[address]},
    {address:nftDeployment.adapter,abi:adapterAbi,functionName:'paused'},
    {address:nftDeployment.adapter,abi:adapterAbi,functionName:'ready'},
    {address:nftDeployment.adapter,abi:adapterAbi,functionName:'minimumUsdPerEth'},
    {address:nftDeployment.adapter,abi:adapterAbi,functionName:'remainingNative'},
    {address:nftDeployment.adapter,abi:adapterAbi,functionName:'validUntil'},
  ]})]);
  const [paused,configured,totalMinted,mintedBy,quoteValidUntil,floor,drop,adapterPaused,ready,adapterFloor,cap,validUntil]=values;
  return {block:blockNumber,timestamp:Number(block.timestamp),paused,configured,totalMinted,mintedBy,quoteValidUntil,floor,drop,
    adapter:{paused:adapterPaused,ready,floor:adapterFloor,cap,validUntil}};
}
