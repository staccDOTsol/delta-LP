import {mkdirSync,openSync,closeSync,writeFileSync,readFileSync,renameSync,fsyncSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {keccak256,type Hex} from 'viem';

const hex=z.string().regex(/^0x[0-9a-f]+$/i),uint=z.string().regex(/^\d+$/);
const itemSchema=z.object({hash:hex,raw:hex,nonce:z.number().int().safe().nonnegative(),expiresAt:z.number().int().safe(),
  maxCost:uint,callId:hex,status:z.enum(['prepared','success','reverted']),block:uint.optional(),blockHash:hex.optional(),cost:uint.optional()});
export type JournalItem=z.infer<typeof itemSchema>;
const schema=z.object({version:z.literal(1),chainId:z.literal(4663),signer:hex,controller:hex,items:z.array(itemSchema)}).strict();
export class Journal {
  readonly path:string;
  state:z.infer<typeof schema>;
  constructor(directory:string,signer:Hex,controller:Hex){
    mkdirSync(directory,{recursive:true,mode:0o700});
    if(statSync(directory).mode&0o077)throw new Error('Keeper state directory must be private (mode 700).');
    this.path=join(directory,'transactions.json');
    this.state=existsSync(this.path)?schema.parse(JSON.parse(readFileSync(this.path,'utf8'))):{version:1,chainId:4663,signer,controller,items:[]};
    if(this.state.signer.toLowerCase()!==signer.toLowerCase()||this.state.controller.toLowerCase()!==controller.toLowerCase())throw new Error('Keeper journal identity mismatch.');
    const nonces=new Set<number>();
    for(const item of this.state.items){
      if(nonces.has(item.nonce)||keccak256(item.raw as Hex)!==item.hash)throw new Error('Keeper journal integrity mismatch.');
      nonces.add(item.nonce);
    }
  }
  save(){
    const temp=this.path+'.tmp';const fd=openSync(temp,'w',0o600);
    try{writeFileSync(fd,JSON.stringify(this.state,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temp,this.path);
    const dir=openSync(join(this.path,'..'),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
  }
  reserve(item:JournalItem,budget:bigint){
    if(this.state.items.some(i=>i.nonce===item.nonce||i.callId===item.callId))throw new Error('A transaction with this nonce or call is already journaled.');
    if(this.spent()+BigInt(item.maxCost)>budget)throw new Error('Keeper lifetime gas budget exhausted.');
    this.state.items.push(itemSchema.parse(item));this.save();
  }
  spent(){return this.state.items.reduce((sum,i)=>sum+BigInt(i.cost??i.maxCost),0n);}
}

export type RecoveryPort={receipt:(hash:Hex)=>Promise<{success:boolean;block:bigint;blockHash:Hex;cost:bigint}|null>;
  transactionKnown:(hash:Hex)=>Promise<boolean>;nonce:()=>Promise<number>;broadcast:(raw:Hex)=>Promise<Hex>};
/** Never manufactures a replacement transaction after an ambiguous submission. */
export async function recover(item:JournalItem,port:RecoveryPort,now:number){
  const receipt=await port.receipt(item.hash as Hex);
  if(receipt){
    item.status=receipt.success?'success':'reverted';item.block=String(receipt.block);item.blockHash=receipt.blockHash;item.cost=String(receipt.cost);
    return item.status;
  }
  if(item.status!=='prepared')throw new Error('Confirmed keeper receipt disappeared; inspect chain reorganization.');
  if(await port.transactionKnown(item.hash as Hex))return 'pending';
  if(await port.nonce()!==item.nonce)throw new Error('Signer nonce changed without the recorded transaction.');
  if(now>=item.expiresAt)throw new Error('Unresolved signed transaction expired; reconcile its nonce before restarting.');
  const hash=await port.broadcast(item.raw as Hex);
  if(hash.toLowerCase()!==item.hash.toLowerCase())throw new Error('Broadcast returned a different transaction hash.');
  return 'pending';
}
