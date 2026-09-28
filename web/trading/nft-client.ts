import {createPublicClient,createWalletClient,custom,http,keccak256,encodeFunctionData,type Address,type EIP1193Provider,type Hash,type Hex} from 'viem';
import {z} from 'zod';
import {chain} from './client.js';
import {SEA_DROP,NFT_FEE_RECIPIENT,seaDropAbi,readNftSale,mintUnavailable} from '../../strategy/nft-sale.js';
import {nftDeployment} from '../../strategy/nft-deployment.js';
import {nftPins} from '../../strategy/nft-pins.js';

export const nftRpc=createPublicClient({chain,transport:http(undefined,{timeout:10000,retryCount:0})});
const savedSchema=z.object({to:z.literal(SEA_DROP),data:z.string().regex(/^0x[0-9a-f]+$/i),value:z.string().regex(/^\d+$/),
  nonce:z.number().int().nonnegative(),hash:z.string().regex(/^0x[0-9a-f]{64}$/i).optional()});
type Saved=z.infer<typeof savedSchema>;
function rejected(error:unknown){for(let i=0;error&&typeof error==='object'&&i<8;i++,error=(error as {cause?:unknown}).cause)if((error as {code?:number}).code===4001)return true;return false;}

/** Only explicit user clicks invoke mint. Ambiguous submissions are never retried. */
export class NftMintClient {
  constructor(readonly provider:EIP1193Provider,readonly address:Address){}
  private get key(){return `dlp.nft.mint.v1.${this.address.toLowerCase()}`;}
  pending(){const raw=localStorage.getItem(this.key);return raw?savedSchema.parse(JSON.parse(raw)):null;}
  private async identity(){
    const [accounts,id]=await Promise.all([this.provider.request({method:'eth_accounts'}),this.provider.request({method:'eth_chainId'})]);
    if(accounts[0]?.toLowerCase()!==this.address.toLowerCase()||Number(id)!==4663)throw new Error('Wallet changed. Reconnect before continuing.');
  }
  async mint(collection:Address,quantity:number,displayedPrice:bigint){
    if(!navigator.locks)throw new Error('Use a browser with Web Locks to prevent duplicate mints.');
    return navigator.locks.request(this.key,{mode:'exclusive'},async()=>{
      await this.identity();if(this.pending())throw new Error('Reconcile your saved mint before submitting another.');
      if(!nftDeployment?.collections.some(c=>c.address===collection))throw new Error('Unknown NFT collection.');
      for(const address of [collection,SEA_DROP,nftDeployment.adapter]){
        const expected=nftPins.find(p=>p.address.toLowerCase()===address.toLowerCase());
        const code=await nftRpc.getCode({address});
        if(!expected||!code||keccak256(code)!==expected.runtimeCodeHash)throw new Error('NFT deployment identity check failed.');
      }
      const state=await readNftSale(nftRpc,collection,this.address),reason=mintUnavailable(state,quantity,Math.floor(Date.now()/1000));
      if(reason)throw new Error(reason);
      if(state.drop.mintPrice!==displayedPrice)throw new Error('Mint price changed. Refresh and review the new price.');
      const value=displayedPrice*BigInt(quantity),data=encodeFunctionData({abi:seaDropAbi,functionName:'mintPublic',args:[collection,NFT_FEE_RECIPIENT,this.address,BigInt(quantity)]});
      await nftRpc.call({account:this.address,to:SEA_DROP,data,value});
      const nonce=await nftRpc.getTransactionCount({address:this.address,blockTag:'pending'});
      await this.identity();
      const saved:Saved={to:SEA_DROP,data,value:String(value),nonce};
      localStorage.setItem(this.key,JSON.stringify(saved));
      try{
        const wallet=createWalletClient({account:this.address,chain,transport:custom(this.provider,{retryCount:0})});
        saved.hash=await wallet.sendTransaction({to:SEA_DROP,data,value,nonce});
        localStorage.setItem(this.key,JSON.stringify(saved));
      }catch(error){
        if(rejected(error)){localStorage.removeItem(this.key);throw new Error('Mint canceled in your wallet.');}
        throw new Error('Submission is unconfirmed. Reconcile the saved transaction before trying again.');
      }
      const receipt=await nftRpc.waitForTransactionReceipt({hash:saved.hash as Hash,confirmations:2,timeout:60000});
      localStorage.removeItem(this.key);
      if(receipt.status!=='success')throw new Error('Mint reverted; no NFT or contribution was created.');
      return receipt.transactionHash;
    });
  }
  async reconcile(candidate?:string){
    if(!navigator.locks)throw new Error('This browser must support Web Locks.');
    return navigator.locks.request(this.key,{mode:'exclusive'},async()=>{
      await this.identity();const pending=this.pending();if(!pending)return 'No mint is pending.';
      const hash=candidate?.trim()||pending.hash;
      if(!hash||!/^0x[0-9a-f]{64}$/i.test(hash))throw new Error('Paste the mint transaction hash from your wallet. Nothing will be resent.');
      const tx=await nftRpc.getTransaction({hash:hash as Hash});
      if(tx.from.toLowerCase()!==this.address.toLowerCase()||tx.to?.toLowerCase()!==pending.to.toLowerCase()||tx.input!==pending.data||tx.value!==BigInt(pending.value)||tx.nonce!==pending.nonce)throw new Error('This transaction does not match your saved mint.');
      pending.hash=hash;localStorage.setItem(this.key,JSON.stringify(pending));
      const receipt=await nftRpc.getTransactionReceipt({hash:hash as Hex}).catch(()=>null);
      if(!receipt||(await nftRpc.getBlockNumber({cacheTime:0}))<receipt.blockNumber+1n)return 'Mint is still awaiting confirmation. No duplicate was sent.';
      localStorage.removeItem(this.key);
      return receipt.status==='success'?'Mint confirmed. Your NFT controls its pending contribution.':'Mint reverted. No NFT or contribution was created.';
    });
  }
}
