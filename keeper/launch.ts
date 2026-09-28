import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,chmodSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {formatUnits} from 'viem';
import {parseOperatorAmount,UNLIMITED_MEMBER_ASSETS} from './launch-input.js';
import deployment from '../strategy/member-deployment.js';

// Interactive owner entry point. Never invoked by an observe/check/build command.
if(!stdin.isTTY)throw new Error('Run keeper:launch in your own interactive terminal.');
const io=createInterface({input:stdin,output:stdout});
const directory=resolve(`artifacts/keeper-${deployment.version}`),configPath=join(directory,'config.json');
const fly=process.argv.includes('--fly'),app='delta-lp-keeper';
const askAmount=async(label:string,decimals:number,allowUnlimited=false):Promise<bigint>=>{
  for(;;){
    const answer=await io.question(label);
    try{return parseOperatorAmount(answer,decimals,allowUnlimited);}
    catch(error){console.error((error as Error).message);}
  }
};
let keyFile:string;
try{
  console.log(`deltaLP operator — ${deployment.version}, ${fly?'Fly.io':'local'}, Robinhood mainnet, ETH 1–50x, 100 members.`);
  console.log(`Controller: ${deployment.contracts.MemberController.address}. State: ${fly?`/data/keeper-${deployment.version}`:directory}.`);
  console.log('This starts real account setup, collateral transfers and trading. It does not deposit USDG from your wallet.');
  console.log('The DN pool activates at 2,000 USDG total; your capital limits must accommodate all 100 members.');
  if(existsSync(configPath)){
    console.log('Existing operator settings:',readFileSync(configPath,'utf8'));
    if((await io.question('Use these saved limits? Type YES: ')).trim()!=='YES')throw new Error('Stopped; edit the saved config before restarting.');
  }else{
    console.log('A member is one long or short account at one leverage; there are 100. This cap limits equity, not order exposure.');
    console.log('Amounts accept decimals, commas or scientific notation. The equity cap also accepts unlimited (no practical capital ceiling).');
    const member=await askAmount('Maximum equity per strategy account, in USDG (or unlimited): ',6,true);
    console.log(`Per-account equity cap: ${member===UNLIMITED_MEMBER_ASSETS?'unlimited':`${formatUnits(member,6)} USDG`}. Order and gas limits are separate.`);
    const order=await askAmount('Maximum single order notional, in USDG: ',6);
    const gas=await askAmount('Lifetime gas budget for this operator journal, in ETH: ',18);
    mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
    writeFileSync(configPath,JSON.stringify({maxMemberAssets:String(member),maxOrderNotional:String(order),maximumGasWei:String(gas),
      refreshSeconds:15,cancelAfterSeconds:5,pollSeconds:3,ownerBootstrap:true},null,2)+'\n',{mode:0o600});
  }
  const provided=(await io.question('Key-file path [~/staccoverflow.eth] — enter a path, never the key: ')).trim();
  if(/^(0x)?[a-fA-F0-9]{64}$/.test(provided))throw new Error('Enter the existing key-file path, not private key material.');
  keyFile=provided?resolve(provided.startsWith('~/')?join(homedir(),provided.slice(2)):provided):join(homedir(),'staccoverflow.eth');
  if(!existsSync(keyFile)||!statSync(keyFile).isFile())throw new Error('Key path is not a file.');
  if(fly){
    if(existsSync(join(directory,'worker.lock')))throw new Error('Stop the local keeper before enabling the Fly worker.');
    for(const name of ['transactions.json','margin-transactions.json']){
      const path=join(directory,name);if(!existsSync(path))continue;
      const prior=JSON.parse(readFileSync(path,'utf8'));
      if(name==='transactions.json'?prior.items?.length:Object.keys(prior).length)throw new Error('Existing local transaction history must be migrated to the Fly volume before cloud activation.');
    }
    const listing=spawnSync('flyctl',['machine','list','--app',app,'--json'],{encoding:'utf8'});
    if(listing.status!==0||JSON.parse(listing.stdout).filter((m:{state:string})=>m.state!=='destroyed').length!==1)throw new Error('Expected exactly one deployed Fly keeper Machine before activation.');
    console.log(`This uploads the selected private key and limits to Fly.io encrypted secrets for ${app}, then starts its real signing worker.`);
  }
  const settings=JSON.parse(readFileSync(configPath,'utf8'));
  for(const field of ['maxMemberAssets','maxOrderNotional'])if(!/^\d+$/.test(settings[field])||BigInt(settings[field])===0n)
    settings[field]=String(await askAmount(field==='maxMemberAssets'?'Maximum member equity, USDG (or unlimited): ':'Maximum order notional, USDG: ',6,field==='maxMemberAssets'));
  // Retain NFT quote operation while explicitly enabling the shared trading loop.
  settings.nftOnly=false;settings.ownerBootstrap=true;
  console.log('Settings for this launch:',JSON.stringify(settings,null,2));
  if((await io.question('Type START to enable owner bootstrap and run real transactions: ')).trim()!=='START')throw new Error('Stopped without starting the operator.');
  writeFileSync(configPath,JSON.stringify(settings,null,2)+'\n',{mode:0o600});
  chmodSync(keyFile,0o600);
}finally{io.close();}
let child;
if(fly){
  const key=readFileSync(keyFile,'utf8').trim();
  if(!/^(0x)?[a-fA-F0-9]{64}$/.test(key))throw new Error('Invalid keeper key-file format.');
  const config=JSON.parse(readFileSync(configPath,'utf8'));
  for(const field of ['maxMemberAssets','maxOrderNotional','maximumGasWei'])if(typeof config[field]!=='string'||!/^\d+$/.test(config[field])||BigInt(config[field])===0n)throw new Error('Set positive capital, order and gas limits before Fly activation.');
  // No secret in process arguments, shell history, image layers or printed output.
  const imported=spawnSync('flyctl',['secrets','import','--app',app,'--stage'],{encoding:'utf8',input:
    `DELTA_KEEPER_PRIVATE_KEY=${key}\nDELTA_KEEPER_CONFIG_JSON=${JSON.stringify(config)}\nDELTA_KEEPER_MODE=execute\nDELTA_KEEPER_STATE=/data/keeper-${deployment.version}\n`});
  if(imported.status!==0)throw new Error('Fly secret import failed; secret command output was withheld.');
  console.log('Operator secrets staged. Deploying the single Fly worker.');
  child=spawn('flyctl',['deploy','--app',app,'--config','fly.toml','--ha=false','--no-public-ips','--yes'],{stdio:'inherit'});
}else child=spawn(process.execPath,['--import','tsx','keeper/run.ts','--execute'],{stdio:'inherit',env:{...process.env,
  DELTA_KEEPER_CONFIG:configPath,DELTA_KEEPER_STATE:directory,DELTA_KEEPER_KEY_FILE:keyFile}});
child.on('exit',code=>{process.exitCode=code??1;});
