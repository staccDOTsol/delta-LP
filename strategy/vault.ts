import {createPublicClient,http,parseAbi,formatUnits} from 'viem';
export const vaultAddress='0x32C47683D0E41DAc58A750fccb7200ad031D3993' as const;
const client=createPublicClient({transport:http('https://rpc.mainnet.chain.robinhood.com',{timeout:8000,retryCount:1})});
const vaultAbi=parseAbi(['function depositsEnabled() view returns (bool)','function totalSupply() view returns (uint256)','function phase() view returns (uint8)','function liquidity() view returns (uint128)']);
let pending:Promise<unknown>|undefined;
let cached:{at:number;value:unknown}|undefined;
export async function vaultState(){
  if(cached&&Date.now()-cached.at<15000)return cached.value;
  if(pending)return pending;
  pending=(async()=>{
    const block=await client.getBlockNumber();
    const read=(functionName:'depositsEnabled'|'totalSupply'|'phase'|'liquidity')=>client.readContract({address:vaultAddress,abi:vaultAbi,functionName,blockNumber:block});
    const [chainId,enabled,supply,phase,liquidity,market]=await Promise.all([client.getChainId(),read('depositsEnabled'),read('totalSupply'),read('phase'),read('liquidity'),client.readContract({address:'0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010',abi:parseAbi(['function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)']),functionName:'market',args:['0xfa02b9d58bb338ea1ac14d89c2586683bf7c209b60073662a7c0dfaa72078be1'],blockNumber:block})]);
    if(chainId!==4663)throw new Error('Unexpected chain.');
    const value={address:vaultAddress,chainId,block:block.toString(),depositsEnabled:enabled,totalShares:formatUnits(supply as bigint,18),phase:Number(phase),liquidity:String(liquidity),borrowAvailableNvda:formatUnits(market[0]-market[2],18),observedAt:new Date().toISOString()};
    cached={at:Date.now(),value};return value;
  })();
  try{return await pending;}finally{pending=undefined;}
}
