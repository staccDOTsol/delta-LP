import {readFileSync,statSync} from 'node:fs';
import {createWalletClient,encodeFunctionData,http,type Abi,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {neutralAbi} from '../strategy/neutral-abi.js';
import {controllerAbi,exitAbi} from './abi.js';
import {chain,client,controller,RPC,vault,mapLimit} from './rpc.js';
import {type Call} from './model.js';
import {Journal,recover,type RecoveryPort} from './journal.js';
import {bootstrap} from './bootstrap.js';
import {submitPrepared} from './submission.js';
import {contributionBatchAbi} from './nft-batch.js';
import {nftOperation} from './nft-sale.js';
import {nftOwner} from '../strategy/nft-pins.js';

const controllerCalls=new Set(['bindAccount','reconcile','reconcileVenueSetup','fundVenue','requestVenueWithdrawal','collectVenueWithdrawal','rebalance','cancelVenueOrders','settleRequest','settleBatch','markGroupChecked','configureVenueKey','setEnabled']);
const vaultCalls=new Set(['startAllocation','activate','setEntriesOpen']);
export function transactionFor(call:Call){
  if(call.target==='nft'){
    if(!call.address)throw new Error('Missing NFT sale destination.');
    return {to:call.address,data:encodeFunctionData({abi:nftOperation(call.address,call.name) as Abi,functionName:call.name,args:call.args})};
  }
  if(call.target==='contribution'){
    if(!call.address||call.name!=='queue'||call.args.length!==0)throw new Error('Unrecognized contribution operation.');
    return {to:call.address,data:encodeFunctionData({abi:contributionBatchAbi,functionName:'queue'})};
  }
  if(call.target==='exit'){
    if(!call.address||!['queue','finish'].includes(call.name))throw new Error('Unrecognized exit operation.');
    return {to:call.address,data:encodeFunctionData({abi:exitAbi as Abi,functionName:call.name,args:call.args})};
  }
  if(!(call.target==='controller'?controllerCalls:vaultCalls).has(call.name))throw new Error('Unrecognized keeper operation.');
  return {to:call.target==='controller'?controller:vault,data:encodeFunctionData({abi:(call.target==='controller'?controllerAbi:neutralAbi) as Abi,functionName:call.name,args:call.args})};
}

/** Instantiated ONLY by the owner's explicit --execute command. Observation mode
 * never loads a signing key or submits any transaction. */
export async function executor(keyFile:string,stateDirectory:string,maximumGasWei:bigint,ownerBootstrap=false,nftSales=false){
  if(statSync(keyFile).mode&0o077)throw new Error('Keeper signing file must be private (mode 600).');
  const key=readFileSync(keyFile,'utf8').trim();if(!/^(0x)?[a-fA-F0-9]{64}$/.test(key))throw new Error('Invalid keeper key-file format.');
  const account=privateKeyToAccount((key.startsWith('0x')?key:`0x${key}`) as Hex);
  if(nftSales&&account.address.toLowerCase()!==nftOwner.toLowerCase())throw new Error('NFT sale execution requires the deployed collection owner.');
  const roles=await Promise.all(['reporter','keeper'].map(functionName=>client.readContract({address:controller,abi:controllerAbi,functionName:functionName as 'reporter'|'keeper'})));
  if(roles.some(role=>role.toLowerCase()!==account.address.toLowerCase()))throw new Error('Signer does not hold the deployed keeper and reporter roles.');
  if(ownerBootstrap&&(await client.readContract({address:controller,abi:controllerAbi,functionName:'owner'})).toLowerCase()!==account.address.toLowerCase())throw new Error('Bootstrap requires the controller owner.');
  const wallet=createWalletClient({account,chain,transport:http(RPC,{retryCount:0,timeout:10000})});
  const journal=new Journal(stateDirectory,account.address,controller);
  const port:RecoveryPort={
    receipt:async hash=>{
      const receipt=await client.getTransactionReceipt({hash}).catch(e=>{if(e.name==='TransactionReceiptNotFoundError')return null;throw e;});
      if(!receipt)return null;
      if((await client.getBlockNumber({cacheTime:0}))<receipt.blockNumber+2n)return null;
      return {success:receipt.status==='success',block:receipt.blockNumber,blockHash:receipt.blockHash,cost:receipt.gasUsed*receipt.effectiveGasPrice};
    },
    transactionKnown:async hash=>Boolean(await client.getTransaction({hash}).catch(e=>{if(e.name==='TransactionNotFoundError')return null;throw e;})),
    nonce:()=>client.getTransactionCount({address:account.address,blockTag:'pending'}),
    broadcast:raw=>client.sendRawTransaction({serializedTransaction:raw}),
  };
  async function reconcile(){
    const latest=await client.getBlockNumber({cacheTime:0});
    const recent=new Map(journal.state.items.filter(i=>i.status!=='prepared'&&i.block&&BigInt(i.block)+64n>=latest).map(i=>[i.block!,i.blockHash]));
    for(const [number,hash] of recent)if((await client.getBlock({blockNumber:BigInt(number)})).hash!==hash)throw new Error('A keeper receipt was reorganized. Reconcile the journal before resuming.');
    const unresolved=journal.state.items.filter(i=>i.status==='prepared');
    for(const item of unresolved){
      const state=await recover(item,port,Date.now());journal.save();
      if(state==='reverted')throw new Error(`Keeper transaction reverted: ${item.hash}. Inspect before restarting.`);
    }
    return journal.state.items.some(i=>i.status==='prepared');
  }
  // A reverted call is deliberately sticky: do not pay to repeat a failing action
  // forever. The operator reviews it and starts a new budgeted journal if desired.
  if(journal.state.items.some(i=>i.status==='reverted'))throw new Error('The keeper journal contains a reverted transaction. Review it before resuming.');
  return {address:account.address,reconcile,bootstrap:bootstrap(account,stateDirectory,ownerBootstrap),async submit(calls:Call[]){
    if(await reconcile())return {submitted:0,pending:true};
    const gasPrice=(await client.getGasPrice())*2n;
    const skipped:{operation:string;member?:string;reason:string}[]=[];
    // Batch gas estimation avoids waiting for each receipt across 100 reporters.
    const prepared=await mapLimit(calls,4,async call=>{
      if(call.target==='nft'&&!nftSales)throw new Error('NFT sale execution is not enabled.');
      if(Date.now()>=call.expiresAt)return null;
      if(!ownerBootstrap&&['configureVenueKey','setEnabled','setEntriesOpen'].includes(call.name))throw new Error('Owner bootstrap is disabled.');
      const tx=transactionFor(call);
      try{const gas=(await client.estimateGas({account:account.address,...tx}))*120n/100n;return {call,tx,gas};}
      catch(error){
        skipped.push({operation:call.name,member:call.member===undefined?undefined:String(call.member),
          reason:((error as {shortMessage?:string}).shortMessage??'Transaction simulation failed.').slice(0,200)});
        return null;
      } // Simulation failure cannot become a broadcast.
    });
    const submitted=await submitPrepared(prepared,journal,{...port,
      balance:()=>client.getBalance({address:account.address}),
      sign:(p,nonce,price)=>wallet.signTransaction({...p.tx,gas:p.gas,gasPrice:price,nonce,type:'legacy'}),
    },gasPrice,maximumGasWei);
    return {...submitted,skipped};
  }};
}
