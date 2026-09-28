import {mkdirSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {ChainIndex,verifyDeployment,client} from './rpc.js';
import {observe} from './observe.js';
import {executor} from './execute.js';
import {errorSummary,retryableTransport} from './errors.js';
import deployment from '../strategy/member-deployment.js';
import {nftSaleSchema} from '../nft/sale-policy.js';
import {verifyNftSale,observeNftSale} from './nft-sale.js';

const integer=z.string().regex(/^\d+$/).transform(BigInt);
const schema=z.object({maxMemberAssets:integer,maxOrderNotional:integer,maximumGasWei:integer,
  refreshSeconds:z.number().int().min(5).max(20),cancelAfterSeconds:z.number().int().min(2).max(60),
  pollSeconds:z.number().int().min(2).max(30),ownerBootstrap:z.boolean(),nftOnly:z.boolean().default(false),nftSale:nftSaleSchema.optional()}).strict();
const live=process.argv.includes('--execute'),once=process.argv.includes('--once');
const configFile=process.env.DELTA_KEEPER_CONFIG??new URL('./config.example.json',import.meta.url);
const config=schema.parse(JSON.parse(readFileSync(configFile,'utf8')));
const dir=resolve(process.env.DELTA_KEEPER_STATE??`artifacts/keeper-${deployment.version}`);
if(config.nftOnly&&!config.nftSale)throw new Error('NFT-only mode requires reviewed sale settings.');
if(live&&(!process.env.DELTA_KEEPER_KEY_FILE||!process.env.DELTA_KEEPER_CONFIG||!config.nftOnly&&(config.maxMemberAssets===0n||config.maxOrderNotional===0n)||config.maximumGasWei===0n))throw new Error('Execution requires an explicit key file, configuration and positive capital/order/gas limits.');
mkdirSync(dir,{recursive:true,mode:0o700});
const lock=join(dir,'worker.lock');
try{mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'pid'),String(process.pid),{mode:0o600});}
catch{throw new Error('Another keeper holds this state-directory lock. After a crash, inspect pending transactions before removing worker.lock.');}
let stopping=false;for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopping=true;});
let transportFailures=0;
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x,2);
try{
  await verifyDeployment();
  if(config.nftSale)await verifyNftSale(client);
  const writer=live?await executor(process.env.DELTA_KEEPER_KEY_FILE!,dir,config.maximumGasWei,config.ownerBootstrap,Boolean(config.nftSale)):undefined;
  const index=new ChainIndex();
  do{
    try{
      if(writer&&await writer.reconcile()){console.log('Waiting for recorded keeper transactions.');}
      else{
        // NFT quotes and strategy transactions always share this executor/journal.
        const nft=config.nftSale?await observeNftSale(client,config.nftSale).catch(error=>{
          if(config.nftOnly)throw error;
          console.error('NFT quotes were not refreshed; existing quotes will expire. Strategy reconciliation continues.');
          return undefined;
        }):undefined;
        if(config.nftOnly&&nft){
          const status={...nft.status,mode:live?'execution':'observation'};
          const temp=join(dir,'status.json.tmp');writeFileSync(temp,json(status)+'\n',{mode:0o600});renameSync(temp,join(dir,'status.json'));
          console.log(json({...status,plannedCalls:nft.calls.length}));
          if(writer)console.log(json(await writer.submit(nft.calls)));
        }else{
        const cycle=await observe(index,config);
        const publicStatus={mode:live?'execution':'observation',at:cycle.at,block:cycle.block,vault:cycle.vault,
          reason:cycle.reason,members:cycle.members.map(m=>({id:m.id,decision:m.decision})),plannedCalls:cycle.calls.length};
        const temp=join(dir,'status.json.tmp');writeFileSync(temp,json(publicStatus)+'\n',{mode:0o600});renameSync(temp,join(dir,'status.json'));
        const counts=cycle.members.reduce((r,m)=>{r[m.decision.state]=(r[m.decision.state]??0)+1;return r;},{} as Record<string,number>);
        console.log(json({mode:publicStatus.mode,block:cycle.block,members:counts,entriesOpen:cycle.vault.entriesOpen,plannedCalls:cycle.calls.length}));
        if(writer){
          const setup=await writer.bootstrap(cycle);
          for(const note of setup.notes)console.log(note);
          const calls=[...(nft?.calls??[]),...setup.calls,...cycle.calls.filter(call=>call.member===undefined||!setup.busy.has(call.member))];
          console.log(json(await writer.submit(calls)));
        }
        }
      }
      transportFailures=0;
    }catch(error){
      // Provider diagnostics can contain request material. Expose only a compact
      // top-level message; signed transaction journals remain private on disk.
      console.error(errorSummary(error));
      if(!once&&retryableTransport(error)){
        const backoff=Math.min(30_000,1_000*2**Math.min(++transportFailures,5));
        console.error(`Temporary provider failure; reconciling recorded transactions again after ${backoff/1000}s.`);
        if(!stopping)await delay(backoff);
        continue;
      }
      if(live||once)throw new Error('Keeper cycle stopped. Inspect status and the transaction journal.');
    }
    if(!once&&!stopping)await delay(config.pollSeconds*1000);
  }while(!once&&!stopping);
}finally{rmSync(lock,{recursive:true,force:true});}
