import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,statSync,chmodSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {formatEther,formatUnits} from 'viem';
import {client} from '../keeper/rpc.js';
import {verifyNftSale,executableNftQuote,observeNftSale} from '../keeper/nft-sale.js';
import {parseOperatorAmount} from '../keeper/launch-input.js';
import {nftSaleSchema,priceForDollars} from './sale-policy.js';
import deployment from '../strategy/member-deployment.js';
import {errorSummary} from '../keeper/errors.js';

// User-run only: paid sale activation is never part of build/check/deploy.
if(!stdin.isTTY)throw new Error('Run npm run nft:launch in your own interactive terminal.');
const fly=process.argv.includes('--fly'),app='delta-lp-keeper';
const directory=resolve(`artifacts/keeper-${deployment.version}`),configPath=join(directory,'config.json');
const io=createInterface({input:stdin,output:stdout});
let keyFile='',settings:Record<string,unknown>={},flyctl='flyctl';
const json=(x:unknown)=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v,2);
try{
  await verifyNftSale(client);
  const existing=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
  const sample=await executableNftQuote(client,10n**15n),rate=sample.usdg*10n**18n/sample.native;
  const now=Math.floor(Date.now()/1000);
  const proposed=nftSaleSchema.parse(existing.nftSale??{
    prices:[1,2,5,10].map(n=>String(priceForDollars(n,rate))),startTime:now,endTime:now+30*86400,
    walletLimit:10000,slippageBps:100,referenceRate:String(rate),maxRateDeviationBps:1000,
  });
  if(proposed.endTime<=now+600)throw new Error('Saved sale has ended or is ending. Review config.json before relaunching.');
  const preview=await observeNftSale(client,proposed);
  console.log(`deltaLP four-edition sale — Robinhood mainnet — ${fly?'single Fly worker':'local worker'}.`);
  console.log(`Executable reference: ${formatUnits(rate,6)} USDG per ETH.`);
  [1,2,5,10].forEach((n,i)=>console.log(`$${n} target: ${formatEther(proposed.prices[i])} ETH per NFT; 10,000 supply.`));
  console.log(`Sale: ${new Date(proposed.startTime*1000).toISOString()} to ${new Date(proposed.endTime*1000).toISOString()}. Wallet cap ${proposed.walletLimit}; 20 per transaction.`);
  console.log(`Swap tolerance ${proposed.slippageBps/100}%; quotes stop refreshing outside ±${proposed.maxRateDeviationBps/100}% of the reviewed rate. Prices stay fixed in ETH.`);
  console.log('10% OpenSea + 1% Wizards; 89% swaps into pending USDG. Minting funds the 2,000 USDG pool; no creator seed deposit.');
  console.log('This starts paid minting and recurring gas-paid quote updates. It does not buy NFTs or start funded Lighter trading.');
  console.log('Quote capacity is bounded by remaining NFT inventory; quotes expire after 10 minutes without updates.');
  console.log(`${preview.calls.length} calls in the next setup stage. The same journal also serves the strategy operator; never run a second signer.`);
  let gas:bigint;
  for(;;){try{gas=parseOperatorAmount(await io.question(`Lifetime gas budget for the shared ${deployment.version} journal, in ETH: `),18);break;}catch(e){console.error((e as Error).message);}}
  settings={...existing,maxMemberAssets:existing.maxMemberAssets??'0',maxOrderNotional:existing.maxOrderNotional??'0',maximumGasWei:String(gas!),
    refreshSeconds:15,cancelAfterSeconds:5,pollSeconds:10,ownerBootstrap:false,nftOnly:true,nftSale:proposed};
  const provided=(await io.question('Key-file path [~/staccoverflow.eth] — path only: ')).trim();
  if(/^(0x)?[a-fA-F0-9]{64}$/.test(provided))throw new Error('Enter a key-file path, never the key.');
  keyFile=provided?resolve(provided.startsWith('~/')?join(homedir(),provided.slice(2)):provided):join(homedir(),'staccoverflow.eth');
  if(!existsSync(keyFile)||!statSync(keyFile).isFile()||statSync(keyFile).mode&0o077)throw new Error('Key file must exist and be private (chmod 600).');
  if(existsSync(join(directory,'worker.lock')))throw new Error('Stop the local worker before launching.');
  if(fly){
    const bundled=join(homedir(),'.fly/bin/flyctl');if(existsSync(bundled))flyctl=bundled;
    const listing=spawnSync(flyctl,['machine','list','--app',app,'--json'],{encoding:'utf8'});
    if(listing.status!==0||JSON.parse(listing.stdout).filter((m:{state:string})=>m.state!=='destroyed').length!==1)throw new Error('Exactly one Fly worker is required.');
    const local=join(directory,'transactions.json');
    if(existsSync(local)&&JSON.parse(readFileSync(local,'utf8')).items?.length)throw new Error('Migrate local transaction history to Fly before switching hosts.');
    console.log('The selected key and sale settings will be stored in encrypted Fly secrets. The existing Fly volume/journal is preserved.');
  }else console.log('Stop any Fly signing worker before proceeding. The local and Fly workers must never both sign.');
  mkdirSync(directory,{recursive:true,mode:0o700});
  writeFileSync(join(directory,'nft-launch-review.json'),json(settings)+'\n',{mode:0o600});
  console.log(`Review saved: ${join(directory,'nft-launch-review.json')}. Change values there and copy it to config.json before relaunching if needed.`);
  if((await io.question('Type OPEN MINT to accept these terms and activate the paid sale: ')).trim()!=='OPEN MINT')throw new Error('Stopped without activating.');
  writeFileSync(configPath,json(settings)+'\n',{mode:0o600});chmodSync(configPath,0o600);
}catch(error){throw new Error(errorSummary(error));}finally{io.close();}
let child;
if(fly){
  const key=readFileSync(keyFile,'utf8').trim();
  if(!/^(0x)?[a-fA-F0-9]{64}$/.test(key))throw new Error('Invalid key-file format.');
  const imported=spawnSync(flyctl,['secrets','import','--app',app,'--stage'],{encoding:'utf8',input:
    `DELTA_KEEPER_PRIVATE_KEY=${key}\nDELTA_KEEPER_CONFIG_JSON=${JSON.stringify(JSON.parse(json(settings)))}\nDELTA_KEEPER_MODE=execute\nDELTA_KEEPER_STATE=/data/keeper-${deployment.version}\n`});
  if(imported.status!==0)throw new Error('Fly secret import failed; output withheld.');
  child=spawn(flyctl,['deploy','--app',app,'--config','fly.toml','--ha=false','--no-public-ips','--yes'],{stdio:'inherit'});
}else child=spawn(process.execPath,['--import','tsx','keeper/run.ts','--execute'],{stdio:'inherit',env:{...process.env,
  DELTA_KEEPER_CONFIG:configPath,DELTA_KEEPER_STATE:directory,DELTA_KEEPER_KEY_FILE:keyFile}});
child.on('exit',code=>{process.exitCode=code??1;});
