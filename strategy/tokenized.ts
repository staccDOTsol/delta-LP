import {createPublicClient,getAddress,http,keccak256,parseAbi} from 'viem';
import deployment from './member-deployment.js';

const client=createPublicClient({transport:http('https://rpc.mainnet.chain.robinhood.com',{timeout:10_000})});
const abi=parseAbi(['function memberCount() view returns (uint256)','function ENTRY_FEE_BPS() view returns (uint256)',
  'function EXIT_FEE_BPS() view returns (uint256)','function FEE_FANOUT() view returns (address)']);
export type TokenizedStatus={chainId:number;block:string;observedAt:string;status:'prototype';memberCount:number;
  entryFeeBps:number;exitFeeBps:number;fanout:string;contracts:{name:string;address:string;explorer:string}[]};
let cached:{at:number;value:TokenizedStatus}|undefined;
let pending:Promise<TokenizedStatus>|undefined;
export async function tokenizedState():Promise<TokenizedStatus>{
  if(cached&&Date.now()-cached.at<15_000)return cached.value;
  if(pending)return pending;
  pending=(async()=>{
    const chainId=await client.getChainId();
    if(chainId!==deployment.chainId)throw new Error('Chain identity mismatch.');
    const blockNumber=await client.getBlockNumber();
    const contracts=await Promise.all(Object.entries(deployment.contracts).map(async([name,entry])=>{
      const address=getAddress(entry.address),code=await client.getCode({address,blockNumber});
      if(!code||keccak256(code)!==entry.runtimeCodeHash)throw new Error('Contract code mismatch.');
      return {name,address,explorer:`https://robin.etherscan.io/address/${address}#code`};
    }));
    const address=getAddress(deployment.contracts.MemberController.address);
    const [count,entry,exit,fanout]=await Promise.all([
      client.readContract({address,abi,functionName:'memberCount',blockNumber}),
      client.readContract({address,abi,functionName:'ENTRY_FEE_BPS',blockNumber}),
      client.readContract({address,abi,functionName:'EXIT_FEE_BPS',blockNumber}),
      client.readContract({address,abi,functionName:'FEE_FANOUT',blockNumber}),
    ]);
    if(entry!==200n||exit!==400n||fanout.toLowerCase()!==deployment.fanout.toLowerCase())throw new Error('Fee policy mismatch.');
    const value:TokenizedStatus={chainId,block:String(blockNumber),observedAt:new Date().toISOString(),status:'prototype',
      memberCount:Number(count),entryFeeBps:Number(entry),exitFeeBps:Number(exit),fanout,contracts};
    cached={at:Date.now(),value};return value;
  })();
  try{return await pending;}finally{pending=undefined;}
}
