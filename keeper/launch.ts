import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,chmodSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {exactUnits} from '../strategy/execution.js';

// Interactive owner entry point. Never invoked by an observe/check/build command.
if(!stdin.isTTY)throw new Error('Run keeper:launch in your own interactive terminal.');
const io=createInterface({input:stdin,output:stdout});
const directory=resolve('artifacts/keeper-v3'),configPath=join(directory,'config.json');
let keyFile:string;
try{
  console.log('deltaLP operator — Robinhood mainnet, ETH 1–50x, 100 members.');
  console.log('This starts real account setup, collateral transfers and trading. It does not deposit USDG from your wallet.');
  console.log('The DN pool activates at 2,000 USDG total; your capital limits must accommodate all 100 members.');
  if(existsSync(configPath)){
    console.log('Existing operator settings:',readFileSync(configPath,'utf8'));
    if((await io.question('Use these saved limits? Type YES: ')).trim()!=='YES')throw new Error('Stopped; edit the saved config before restarting.');
  }else{
    const member=exactUnits((await io.question('Maximum NAV per member, in USDG: ')).trim(),6);
    const order=exactUnits((await io.question('Maximum single order notional, in USDG: ')).trim(),6);
    const gas=exactUnits((await io.question('Lifetime gas budget for this operator journal, in ETH: ')).trim(),18);
    if(member===0n||order===0n||gas===0n)throw new Error('All limits must be positive.');
    mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
    writeFileSync(configPath,JSON.stringify({maxMemberAssets:String(member),maxOrderNotional:String(order),maximumGasWei:String(gas),
      refreshSeconds:15,cancelAfterSeconds:5,pollSeconds:3,ownerBootstrap:true},null,2)+'\n',{mode:0o600});
  }
  const provided=(await io.question('Key-file path [~/staccoverflow.eth] — enter a path, never the key: ')).trim();
  if(/^(0x)?[a-fA-F0-9]{64}$/.test(provided))throw new Error('Enter the existing key-file path, not private key material.');
  keyFile=provided?resolve(provided.startsWith('~/')?join(homedir(),provided.slice(2)):provided):join(homedir(),'staccoverflow.eth');
  if(!existsSync(keyFile)||!statSync(keyFile).isFile())throw new Error('Key path is not a file.');
  if((await io.question('Type START to enable owner bootstrap and run real transactions: ')).trim()!=='START')throw new Error('Stopped without starting the operator.');
  chmodSync(keyFile,0o600);
}finally{io.close();}
const child=spawn(process.execPath,['--import','tsx','keeper/run.ts','--execute'],{stdio:'inherit',env:{...process.env,
  DELTA_KEEPER_CONFIG:configPath,DELTA_KEEPER_STATE:directory,DELTA_KEEPER_KEY_FILE:keyFile}});
child.on('exit',code=>{process.exitCode=code??1;});
