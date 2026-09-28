// Deploy only a reviewed, locally simulated, zero-value NFT software bundle.
// No mint, unpause, inventory funding, asset approval, deposit or trade is allowed.
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync} from 'node:fs';
import {createWalletClient,defineChain,http,keccak256,toHex,encodeDeployData,encodeFunctionData,getCreate2Address,concat,formatEther} from 'viem';
import {client,rpc,loadSigner,stringify} from './preflight.mjs';

const version=process.argv.find(x=>x.startsWith('--version='))?.slice(10);
if(!version||!/^v[1-9][0-9]*$/.test(version)||Number(version.slice(1))<4)throw Error('Replacement version required.');
const planDir=process.argv.find(x=>x.startsWith('--plan-dir='))?.slice(11)||'artifacts/nft-deployment';
const broadcast=process.argv.includes('--broadcast');
const planText=readFileSync(`${planDir}/unsigned.json`,'utf8');
const plan=JSON.parse(planText),planHash=keccak256(toHex(planText));
const simulation=JSON.parse(readFileSync(`${planDir}/fork-simulation.json`,'utf8'));
const stack=JSON.parse(readFileSync(`evm/deployments/4663-tokenized-${version}.json`,'utf8'));
const path=`evm/deployments/4663-nft-${version}.json`,privateDir=`artifacts/nft-deployment-${version}`;
const art=name=>JSON.parse(readFileSync(`evm/out/${name}.sol/${name}.json`,'utf8'));
const equal=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const editionContract=plan.version===3?'DnPendingSeaDropEditionV2':'DnPendingSeaDropEdition';
if(plan.editionContract&&plan.editionContract!==editionContract)throw Error('Edition ABI version mismatch.');
const denominations=[1,2,5,10];
const factory='0x4e59b44847b379578588920cA78FbF26c0B4956C';
if(await client.getChainId()!==4663||plan.chainId!==4663||plan.status!=='unsigned-paused-deployment'
  ||![2,3].includes(plan.version)||plan.launchMode!=='pending-contribution'
  ||stack.status!=='deployed-empty'||!equal(plan.owner,stack.authority)
  ||plan.collections.length!==4||plan.deployments.length!==5||plan.calls.length!==30
  ||simulation.status!=='local-fork-simulation-only'||simulation.planHash!==planHash||simulation.receipts.length!==30
  ||!equal(plan.dependencies.receipt.address,stack.steps.NeutralVault.address)
  ||!equal(plan.dependencies.weightedFanout.address,stack.steps.WeightedNftFeeFanout.address))throw Error('Bundle identity or simulation mismatch.');
for(const [name,dependency] of Object.entries(plan.dependencies)){
  const code=await client.getCode({address:dependency.address});
  if(!code||keccak256(code)!==dependency.runtimeCodeHash)throw Error(`Dependency changed: ${name}`);
}
const expected=[];
function deployment(label,name,args){
  const item=plan.deployments.find(x=>x.label===label),artifact=art(name);
  const init=encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode.object,args});
  const salt=keccak256(toHex(`deltaLP:nft:pending:v1:${label}`)),address=getCreate2Address({from:factory,salt,bytecodeHash:keccak256(init)});
  if(!item||item.contract!==name||!equal(item.address,address)||item.creationCodeHash!==keccak256(init)
    ||!simulation.runtimeHashes[address.toLowerCase()])throw Error(`Deployment source changed: ${label}`);
  expected.push({to:factory,data:concat([salt,init]),address,name});return address;
}
function call(name,to,functionName,args=[]){expected.push({to,data:encodeFunctionData({abi:art(name).abi,functionName,args})});}
const adapter=deployment('pending-adapter','DnPendingAdapter',[plan.owner,plan.dependencies.receipt.address,plan.dependencies.receipt.runtimeCodeHash]);
if(!equal(adapter,plan.adapter))throw Error('Adapter mismatch.');
for(let i=0;i<4;i++){
  const edition=plan.collections[i],d=denominations[i];
  if(edition.denomination!==d||edition.count!==10000||!edition.verifiedAt)throw Error('Wrong launch editions.');
  const address=deployment(`edition-${d}`,editionContract,[`Money Doubler $${d}`,`DLP${d}`,BigInt(d),plan.owner,adapter,plan.dependencies.houseFees.address]);
  if(!equal(address,edition.address))throw Error('Collection mismatch.');
  call(editionContract,address,'configure');
  call(editionContract,address,'setBaseURI',[edition.baseURI]);
  call(editionContract,address,'setContractURI',[edition.contractURI]);
  call(editionContract,address,'setProvenanceHash',[edition.provenanceHash]);
  call(editionContract,address,'updateDropURI',[plan.dependencies.seaDrop.address,edition.contractURI]);
  call('DnPendingAdapter',adapter,'setEdition',[address,true]);
}
call('WeightedNftFeeFanout',plan.dependencies.weightedFanout.address,'configure',[plan.collections.map(x=>x.address)]);
for(let i=0;i<expected.length;i++)if(plan.calls[i].value!=='0'||!equal(plan.calls[i].to,expected[i].to)||plan.calls[i].data!==expected[i].data)throw Error(`Unexpected software call ${i}.`);
if(!broadcast){console.log(stringify({status:'validated-empty-software-bundle',planHash,calls:expected.length}));process.exit(0);}

// Budget the full remaining bundle before reading a key or starting a partial
// deployment. Exact resumed calls are reconciled against their journal below.
const prior=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined;
if(prior&&(prior.planHash!==planHash||!equal(prior.owner,plan.owner)))throw Error('Deployment journal changed.');
const remainingGas=simulation.receipts.reduce((sum,receipt,index)=>
  sum+(prior?.calls[index]?.status==='success'?0n:BigInt(receipt.gasUsed)),0n);
const remainingBudget=remainingGas*await client.getGasPrice()*150n/100n;
if(await client.getBalance({address:plan.owner})<remainingBudget)
  throw Error(`Remaining deployment needs ${formatEther(remainingBudget)} ETH including gas cushion; no new calls sent.`);

const account=loadSigner();
if(!equal(account.address,plan.owner))throw Error('Wrong deployment signer.');
const chain=defineChain({id:4663,name:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}});
const wallet=createWalletClient({account,chain,transport:http(rpc)});
const record=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{version,chainId:4663,planHash,owner:account.address,status:'deploying-paused-software',adapter,editionContract,collections:plan.collections,dependencies:plan.dependencies,deployments:plan.deployments,calls:[]};
if(record.planHash!==planHash||record.owner!==account.address)throw Error('Deployment journal changed.');
function save(){writeFileSync(`${path}.tmp`,stringify(record)+'\n');renameSync(`${path}.tmp`,path);}
const cap=1_000_000_000_000_000n;
for(let i=0;i<expected.length;i++){
  const tx=expected[i];let item=record.calls[i];
  if(item&&(item.dataHash!==keccak256(tx.data)||!equal(item.to,tx.to)))throw Error('Saved call mismatch.');
  if(!item){
    if(tx.address&&await client.getCode({address:tx.address}))throw Error('Unjournaled CREATE2 deployment already exists.');
    const gas=await client.estimateGas({account:account.address,to:tx.to,data:tx.data,value:0n})*120n/100n;
    // Keep a 25% price cushion without paying double the current RPC quote.
    const gasPrice=await client.getGasPrice()*125n/100n,maximum=gas*gasPrice;
    const spent=record.calls.reduce((n,x)=>n+BigInt(x.actualGasCostWei??x.maxGasCostWei),0n);
    if(spent+maximum>cap||await client.getBalance({address:account.address})<maximum)throw Error('NFT deployment gas limit or balance reached.');
    const floor=record.calls.reduce((n,x)=>Math.max(n,x.nonce+1),0);
    let nonce=await client.getTransactionCount({address:account.address,blockTag:'pending'});
    for(let retry=0;nonce<floor&&retry<8;retry++){await new Promise(resolve=>setTimeout(resolve,500));nonce=await client.getTransactionCount({address:account.address,blockTag:'pending'});}
    if(nonce<floor)throw Error('RPC nonce trails the deployment journal; wait and retry.');
    const raw=await wallet.signTransaction({to:tx.to,data:tx.data,value:0n,gas,gasPrice,nonce,type:'legacy'});
    mkdirSync(privateDir,{recursive:true,mode:0o700});writeFileSync(`${privateDir}/${i}.signed`,raw,{mode:0o600});
    item={index:i,label:plan.calls[i].label,to:tx.to,dataHash:keccak256(tx.data),nonce,hash:keccak256(raw),maxGasCostWei:String(maximum),status:'prepared'};
    record.calls.push(item);save();
  }
  let receipt=await client.getTransactionReceipt({hash:item.hash}).catch(e=>{if(e.name==='TransactionReceiptNotFoundError')return null;throw e;});
  if(!receipt){
    const known=await client.getTransaction({hash:item.hash}).catch(e=>{if(e.name==='TransactionNotFoundError')return null;throw e;});
    if(!known){
      if(await client.getTransactionCount({address:account.address,blockTag:'pending'})!==item.nonce)throw Error('Nonce moved without the saved transaction; reconcile before retrying.');
      const raw=readFileSync(`${privateDir}/${i}.signed`,'utf8');if(keccak256(raw)!==item.hash)throw Error('Signed journal integrity failure.');
      await client.sendRawTransaction({serializedTransaction:raw});
    }
    receipt=await client.waitForTransactionReceipt({hash:item.hash,confirmations:2,pollingInterval:1000,timeout:60000});
  }
  if(receipt.status!=='success')throw Error(`NFT software call ${i} reverted.`);
  if(tx.address){
    const code=await client.getCode({address:tx.address});
    if(!code||keccak256(code)!==simulation.runtimeHashes[tx.address.toLowerCase()])throw Error('Deployed runtime differs from the tested fork.');
    const deployed=record.deployments.find(x=>equal(x.address,tx.address));
    Object.assign(deployed,{transactionHash:item.hash,runtimeCodeHash:keccak256(code)});
  }
  Object.assign(item,{status:'success',block:String(receipt.blockNumber),actualGasCostWei:String(receipt.gasUsed*receipt.effectiveGasPrice)});save();
  console.log(`Confirmed ${i+1}/${expected.length}: ${plan.calls[i].label}`);
}
const read=(name,address,functionName,args=[])=>client.readContract({address,abi:art(name).abi,functionName,args});
if(!await read('DnPendingAdapter',adapter,'paused'))throw Error('Expected paused adapter.');
for(const edition of plan.collections)if(!await read(editionContract,edition.address,'paused')||await read(editionContract,edition.address,'totalMinted')!==0n)throw Error('Expected paused empty edition.');
const fanout=plan.dependencies.weightedFanout.address;
if(!await read('WeightedNftFeeFanout',fanout,'configured')||!equal(await read('WeightedNftFeeFanout',fanout,'initializer'),'0x0000000000000000000000000000000000000000'))throw Error('Fee registry not finalized.');
for(let i=0;i<4;i++)if(!equal(await read('WeightedNftFeeFanout',fanout,'collections',[BigInt(i)]),plan.collections[i].address))throw Error('Fee registry mismatch.');
record.status='deployed-paused';record.verifiedAt=new Date().toISOString();record.gasCostETH=formatEther(record.calls.reduce((n,x)=>n+BigInt(x.actualGasCostWei),0n));save();
console.log(stringify({status:record.status,adapter,editionContract,collections:plan.collections.map(x=>({denomination:x.denomination,address:x.address})),gasCostETH:record.gasCostETH}));
