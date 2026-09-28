import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync} from 'node:fs';
import {createWalletClient,defineChain,http,keccak256,encodeFunctionData,encodeAbiParameters,toHex,formatEther} from 'viem';
import {client,rpc,loadSigner,stringify} from './preflight.mjs';

// Deploys empty member ERC-20s and custody contracts, then freezes vault membership.
// Does not enable entries, approve collateral, fund accounts, or submit trading orders.
const version=process.argv.find(s=>s.startsWith('--version='))?.slice(10);
if(!version||!/^v[1-9][0-9]*$/.test(version))throw new Error('An explicit --version=vN is required.');
const broadcast=process.argv.includes('--broadcast');
const manifest=JSON.parse(readFileSync(new URL(`../deployments/4663-tokenized-${version}.json`,import.meta.url),'utf8'));
const controllerName=manifest.controllerName??'MemberController';
const controller=manifest.steps[controllerName].address,vault=manifest.steps.NeutralVault.address;
const path=new URL(`../deployments/4663-neutral-${version}-registry.json`,import.meta.url);
const privateDir=new URL(`../../artifacts/neutral-registry-${version}/`,import.meta.url);
const signer=loadSigner();
const record=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{chainId:4663,controller,vault,symbol:'ETH',tiers:50,calls:{},members:[]};
if(record.controller!==controller||record.vault!==vault||manifest.authority.toLowerCase()!==signer.address.toLowerCase()||await client.getChainId()!==4663)throw new Error('Registry identity mismatch.');
const chain=defineChain({id:4663,name:'Robinhood Chain',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}});
const wallet=createWalletClient({account:signer,chain,transport:http(rpc)});
const artifacts=Object.fromEntries(['MemberController','NeutralVault'].map(name=>{const artifactName=name==='MemberController'?controllerName:name;return [name,JSON.parse(readFileSync(new URL(`../out/${artifactName}.sol/${artifactName}.json`,import.meta.url),'utf8'))];}));
for(const name of ['MemberController','NeutralVault']){
  const entry=manifest.steps[name==='MemberController'?controllerName:name],code=await client.getCode({address:entry.address});
  if(!code||keccak256(code)!==entry.runtimeCodeHash)throw new Error(`${name} runtime mismatch.`);
}
const read=(name,functionName,args=[])=>client.readContract({address:name==='MemberController'?controller:vault,abi:artifacts[name].abi,functionName,args});
if((await read('MemberController','owner')).toLowerCase()!==signer.address.toLowerCase())throw new Error('Not the registry owner.');
const response=await fetch('https://api.rh.lighter.xyz/api/v1/orderBookDetails?market_id=0',{signal:AbortSignal.timeout(10000)});
const body=await response.json(),market=body.order_book_details?.find(m=>m.market_id===0&&m.symbol==='ETH');
if(!response.ok||body.code!==200||!market||market.status!=='active'||market.market_config.force_reduce_only||Math.floor(10000/market.min_initial_margin_fraction)!==50||market.supported_size_decimals!==4||market.supported_price_decimals!==2)throw new Error('Venue family configuration changed.');
const group=keccak256(toHex('ETH'));
function save(){const tmp=new URL(`${path.pathname}.tmp`,'file:');writeFileSync(tmp,stringify(record)+'\n');renameSync(tmp,path);}
function spent(){return Object.values(record.calls).reduce((n,c)=>n+BigInt(c.gasCost??0),0n);}
async function send(key,name,functionName,args){
  const to=name==='MemberController'?controller:vault;
  const data=encodeFunctionData({abi:artifacts[name].abi,functionName,args});
  let item=record.calls[key];
  if(item&&item.dataHash!==keccak256(data))throw new Error('Registry call changed after preparation.');
  if(item?.status==='success')return;
  if(!item){
    const gas=(await client.estimateGas({account:signer.address,to,data}))*120n/100n;
    const gasPrice=(await client.getGasPrice())*2n;
    if(spent()+gas*gasPrice>6_000_000_000_000_000n)throw new Error('Registry would exceed its 0.006 ETH gas cap.');
    if(await client.getBalance({address:signer.address})<gas*gasPrice)throw new Error('Insufficient deployment gas.');
    if(!broadcast){console.log(stringify({mode:'simulation',key,maximumGasETH:formatEther(gas*gasPrice)}));return;}
    const nonce=await client.getTransactionCount({address:signer.address,blockTag:'pending'});
    const raw=await wallet.signTransaction({to,data,gas,gasPrice,nonce,type:'legacy'});
    mkdirSync(privateDir,{recursive:true});writeFileSync(new URL(`${key}.signed`,privateDir),raw,{mode:0o600});
    item={status:'prepared',hash:keccak256(raw),nonce,dataHash:keccak256(data)};record.calls[key]=item;save();
  }
  let receipt=await client.getTransactionReceipt({hash:item.hash}).catch(e=>{if(e.name==='TransactionReceiptNotFoundError')return null;throw e;});
  if(!receipt){
    const known=await client.getTransaction({hash:item.hash}).catch(e=>{if(e.name==='TransactionNotFoundError')return null;throw e;});
    if(!known){
      if(await client.getTransactionCount({address:signer.address,blockTag:'pending'})!==item.nonce)throw new Error('Nonce moved; reconcile saved creation before retrying.');
      const raw=readFileSync(new URL(`${key}.signed`,privateDir),'utf8');if(keccak256(raw)!==item.hash)throw new Error('Signed registry journal mismatch.');
      await client.sendRawTransaction({serializedTransaction:raw});
    }
    receipt=await client.waitForTransactionReceipt({hash:item.hash,confirmations:2,timeout:60000});
  }
  if(receipt.status!=='success')throw new Error(`Registry ${key} reverted.`);
  item.status='success';item.block=String(receipt.blockNumber);item.gasCost=String(receipt.gasUsed*receipt.effectiveGasPrice);save();
}
for(let tier=1;tier<=50;tier++)for(const short of [false,true]){
  const key=`ETH-${tier}-${short?'S':'L'}`;
  const series=keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint8'},{type:'bool'}],[group,tier,short]));
  let id=await read('MemberController','registeredSeries',[series]);
  if(id===0n){
    await send(key,'MemberController','createMember',[group,0,tier,short,4,2,`deltaLP ETH ${tier}x ${short?'Short':'Long'}`,`dlpETH${tier}${short?'S':'L'}`]);
    if(!broadcast){console.log('Simulation complete; no registry changes sent.');process.exit(0);}
    id=await read('MemberController','registeredSeries',[series]);
  }
  const member=await read('MemberController','memberState',[id]);
  if(member.group!==group||member.market!==0||member.leverage!==tier||member.short!==short)throw new Error('Member identity mismatch.');
  if(!record.members.some(m=>m.id===String(id))){
    const [tokenCode,custodyCode]=await Promise.all([client.getCode({address:member.token}),client.getCode({address:member.custody})]);
    if(!tokenCode||!custodyCode)throw new Error('Missing child bytecode.');
    record.members.push({id:String(id),tier,short,token:member.token,custody:member.custody,tokenCodeHash:keccak256(tokenCode),custodyCodeHash:keccak256(custodyCode)});save();
  }
  if(!short&&tier%10===0)console.log(`Registered through ETH ${tier}x; ${record.members.length}/100 members.`);
}
if((await read('MemberController','family',[group])).length!==100)throw new Error('Incomplete ETH family.');
if(!await read('NeutralVault','configured'))await send('configure','NeutralVault','configure',[]);
record.configured=await read('NeutralVault','configured');record.entriesOpen=await read('NeutralVault','entriesOpen');record.gasCostETH=formatEther(spent());save();
console.log(stringify({members:record.members.length,configured:record.configured,entriesOpen:record.entriesOpen,gasCostETH:record.gasCostETH}));
