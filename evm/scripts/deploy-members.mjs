import {readFileSync, writeFileSync, existsSync, mkdirSync, renameSync} from 'node:fs';
import {createWalletClient,defineChain,http,encodeDeployData,keccak256,getContractAddress,getCreate2Address,toHex,concat,formatEther,parseAbi} from 'viem';
import {client,rpc,loadSigner,stringify} from './preflight.mjs';

// Deploys empty software only. Does not enable members, fund accounts, approve USDG,
// place orders or seed pools. Reruns reconcile saved transaction hashes before proceeding.
const broadcast=process.argv.includes('--broadcast');
const version=process.argv.find(arg=>arg.startsWith('--version='))?.slice(10)??'v1';
if(!/^v[1-9][0-9]*$/.test(version))throw new Error('Use --version=vN for an immutable deployment version.');
const path=new URL(`../deployments/4663-tokenized-${version}.json`,import.meta.url);
const journalDir=new URL(version==='v1'?'../../artifacts/member-deployment/':`../../artifacts/member-deployment-${version}/`,import.meta.url);
const account=loadSigner();
const chain=defineChain({id:4663,name:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}});
const wallet=createWalletClient({account,chain,transport:http(rpc)});
const dependencies={usdg:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',lighter:'0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d',
  poolManager:'0x8366a39CC670B4001A1121B8F6A443A643e40951',fanout:'0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8',
  create2:'0x4e59b44847b379578588920cA78FbF26c0B4956C'};
const maxTotalFee=1_000_000_000_000_000n; // 0.001 ETH maximum across this deployment journal
const manifest=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{chainId:4663,authority:account.address,
  version,status:'preparing-empty-contracts',dependencies,steps:{},depositsEnabled:false,liveTrading:false};
if(manifest.chainId!==4663||manifest.authority.toLowerCase()!==account.address.toLowerCase())throw new Error('Deployment journal identity mismatch.');
if(await client.getChainId()!==4663)throw new Error('Unexpected chain.');
for(const [name,address] of Object.entries(dependencies))if(!(await client.getCode({address})))throw new Error(`Missing dependency: ${name}`);
const art=name=>JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`,import.meta.url),'utf8'));
function save(){mkdirSync(new URL('../deployments/',import.meta.url),{recursive:true});const temp=new URL(`${path.pathname}.tmp`,'file:');writeFileSync(temp,stringify(manifest)+'\n');renameSync(temp,path);}
const read=(address,name,fn,args=[])=>client.readContract({address,abi:art(name).abi,functionName:fn,args});
function spent(){return Object.values(manifest.steps).reduce((sum,step)=>sum+BigInt(step.actualGasCostWei??0),0n);}

async function deploy(name,args,create2=false){
  const artifact=art(name),init=encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode.object,args});
  if((artifact.deployedBytecode.object.length-2)/2>24576||(init.length-2)/2>49152)throw new Error(`${name} exceeds EVM size limits.`);
  const initHash=keccak256(init);
  let step=manifest.steps[name];
  if(step&&step.creationCodeHash!==initHash)throw new Error(`${name} source changed after journal creation. Use a new versioned manifest.`);
  if(step?.status==='deployed'){
    const code=await client.getCode({address:step.address});
    if(!code||keccak256(code)!==step.runtimeCodeHash)throw new Error(`${name} deployed bytecode changed.`);
    console.log(`${name}: existing ${step.address}`);
    return step.address;
  }
  if(!step){
    const nonce=await client.getTransactionCount({address:account.address,blockTag:'pending'});
    let address=getContractAddress({from:account.address,nonce:BigInt(nonce)}),data=init,to;
    let salt;
    if(create2){
      to=dependencies.create2;
      for(let i=0;i<1_000_000;i++){
        salt=toHex(i,{size:32});address=getCreate2Address({from:to,salt,bytecodeHash:initHash});
        if((BigInt(address)&0x3fffn)===0x2540n)break;
      }
      if((BigInt(address)&0x3fffn)!==0x2540n)throw new Error('Hook salt search exhausted.');
      if(await client.getCode({address}))throw new Error('CREATE2 address already occupied.');
      data=concat([salt,init]);
    }
    const estimate=await client.estimateGas({account:account.address,data,to}),gas=estimate*120n/100n;
    const gasPrice=(await client.getGasPrice())*2n,maximum=gas*gasPrice;
    if(spent()+maximum>maxTotalFee)throw new Error('Deployment journal would exceed 0.001 ETH gas cap.');
    if(await client.getBalance({address:account.address})<maximum)throw new Error('Insufficient gas balance.');
    console.log(stringify({name,mode:broadcast?'broadcast':'simulation',address,maximumGasFeeETH:formatEther(maximum)}));
    if(!broadcast)return address;
    const raw=await wallet.signTransaction({account,chain,data,to,gas,gasPrice,nonce,type:'legacy'});
    const hash=keccak256(raw);
    // The signed creation transaction contains no private key. Persist privately before
    // sending so an interrupted call can safely rebroadcast the identical transaction.
    mkdirSync(journalDir,{recursive:true});
    writeFileSync(new URL(`${name}.signed`,journalDir),raw,{mode:0o600});
    step={status:'prepared',address,nonce,transactionHash:hash,creationCodeHash:initHash,constructorArgs:args,
      salt,gasLimit:String(gas),maxGasCostWei:String(maximum)};
    manifest.steps[name]=step;save();
  }
  let receipt;
  try{receipt=await client.getTransactionReceipt({hash:step.transactionHash});}catch(error){if(error.name!=='TransactionReceiptNotFoundError')throw error;}
  if(!receipt){
    const raw=readFileSync(new URL(`${name}.signed`,journalDir),'utf8').trim();
    if(keccak256(raw)!==step.transactionHash)throw new Error('Signed journal transaction mismatch.');
    let known;
    try{known=await client.getTransaction({hash:step.transactionHash});}catch(error){if(error.name!=='TransactionNotFoundError')throw error;}
    if(!known){
      const pendingNonce=await client.getTransactionCount({address:account.address,blockTag:'pending'});
      if(pendingNonce!==step.nonce)throw new Error('Account nonce moved; reconcile the prepared deployment before retrying.');
      await client.sendRawTransaction({serializedTransaction:raw});
    }
    receipt=await client.waitForTransactionReceipt({hash:step.transactionHash,confirmations:2,timeout:60_000});
  }
  if(receipt.status!=='success')throw new Error(`${name} deployment reverted; inspect the saved receipt.`);
  if(!create2&&receipt.contractAddress?.toLowerCase()!==step.address.toLowerCase())throw new Error('Creation address mismatch.');
  const code=await client.getCode({address:step.address});
  if(!code)throw new Error('Deployment has no runtime code.');
  Object.assign(step,{status:'deployed',blockNumber:String(receipt.blockNumber),runtimeCodeHash:keccak256(code),
    actualGasCostWei:String(receipt.gasUsed*receipt.effectiveGasPrice),gasUsed:String(receipt.gasUsed)});
  save();console.log(`${name}: deployed ${step.address}`);return step.address;
}

const controller=await deploy('MemberController',[dependencies.usdg,dependencies.lighter,account.address,account.address,account.address]);
if(!broadcast){console.log('Simulation complete. Subsequent dependencies are estimated after controller deployment; no transactions sent.');process.exit(0);}
if(await read(controller,'MemberController','memberCount')!==0n)throw new Error('Expected an empty controller.');
for(const role of ['owner','reporter','keeper'])if((await read(controller,'MemberController',role)).toLowerCase()!==account.address.toLowerCase())throw new Error(`${role} mismatch.`);
const factory=await read(controller,'MemberController','factory');
if((await read(factory,'MemberFactory','controller')).toLowerCase()!==controller.toLowerCase())throw new Error('Factory controller mismatch.');
manifest.factory={address:factory,runtimeCodeHash:keccak256(await client.getCode({address:factory}))};save();
const router=await deploy('HouseFeeRouter',[]);
if((await read(router,'HouseFeeRouter','FANOUT')).toLowerCase()!==dependencies.fanout.toLowerCase())throw new Error('Fanout mismatch.');
const hook=await deploy('MemberV4Hook',[dependencies.poolManager,controller],true);
if((await read(hook,'MemberV4Hook','controller')).toLowerCase()!==controller.toLowerCase()||(await read(hook,'MemberV4Hook','manager')).toLowerCase()!==dependencies.poolManager.toLowerCase())throw new Error('Hook wiring mismatch.');
manifest.status='deployed-empty';manifest.verifiedAt=new Date().toISOString();manifest.totalGasCostETH=formatEther(spent());save();
console.log(stringify({status:manifest.status,controller,factory,router,hook,totalGasCostETH:manifest.totalGasCostETH}));
