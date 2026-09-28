// Produces only unsigned, zero-value contract deployment/configuration calls.
// This never reads a key, broadcasts, seeds inventory, swaps or opens mints.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createPublicClient,http,encodeDeployData,encodeFunctionData,getCreate2Address,keccak256,toHex,concat,parseAbi} from 'viem';
const owner='0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
const factory='0x4e59b44847b379578588920cA78FbF26c0B4956C';
const houseFees='0xBfac70063f04e116F5a509cC746BEeb2F053467D';
const targetPath=process.argv.find(x=>x.startsWith('--target='))?.slice(9);
const version=process.argv.find(x=>x.startsWith('--version='))?.slice(10);
if(!targetPath&&!version)throw Error('Supply --target=path or --version=v4 for the verified replacement stack. Legacy v3 cannot satisfy the new 3%/6% policy.');
if(targetPath&&version)throw Error('Use only one target source');
if(version&&!/^v[4-9][0-9]*$/.test(version))throw Error('Replacement version must be v4 or later');
const source=JSON.parse(readFileSync(targetPath||`evm/deployments/4663-tokenized-${version}.json`,'utf8'));
if(version&&source.controllerName!=='SplitFeeMemberController')throw Error('Manifest must identify SplitFeeMemberController');
const target=targetPath?source:{chainId:source.chainId,receipt:source.steps.NeutralVault,weightedFanout:source.steps.WeightedNftFeeFanout};
if(target.chainId!==4663||!target.receipt?.address||!target.receipt?.runtimeCodeHash||!target.weightedFanout?.address||!target.weightedFanout?.runtimeCodeHash)throw Error('Target requires chainId, receipt and weightedFanout addresses/code hashes');
const receipt=target.receipt.address;
const client=createPublicClient({transport:http(process.env.ROBINHOOD_RPC_URL||'https://rpc.mainnet.chain.robinhood.com')});
const art=name=>JSON.parse(readFileSync(`evm/out/${name}.sol/${name}.json`,'utf8'));
const assets=JSON.parse(readFileSync('artifacts/nft-publication/editions.json','utf8'));
if(assets.length!==7||[1,2,5,10,20,50,100].some(d=>assets.filter(a=>a.denomination===d&&a.count===10000&&a.verifiedAt).length!==1))throw Error('All seven published and verified editions are required.');
if(await client.getChainId()!==4663)throw Error('Wrong chain');
const block=await client.getBlock();
const dependencies={create2:factory,receipt,weightedFanout:target.weightedFanout.address,houseFees,seaDrop:'0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',registry:'0x000000006551c19487814612e58FE06813775758',accountImplementation:'0x41C8f39463A868d3A88af00cd0fe7102F30E44eC',poolManager:'0x8366a39CC670B4001A1121B8F6A443A643e40951',swapHook:'0xC74E7983718DAEEfE5dA80690Afbd65d7eF74088',usdg:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'};
const pinned={};
for(const [name,address] of Object.entries(dependencies)){
 const code=await client.getCode({address,blockNumber:block.number});if(!code||code==='0x')throw Error(`Missing ${name}`);
 pinned[name]={address,runtimeCodeHash:keccak256(code)};
}
const expectedReceiptHash=target.receipt.runtimeCodeHash;
if(pinned.receipt.runtimeCodeHash!==expectedReceiptHash)throw Error('Canonical receipt hash mismatch');
if(pinned.weightedFanout.runtimeCodeHash!==target.weightedFanout.runtimeCodeHash)throw Error('Fanout hash mismatch');
const abi=parseAbi(['function totalSupply() view returns(uint256)','function entriesOpen() view returns(bool)','function controller() view returns(address)','function ENTRY_FEE_BPS() view returns(uint256)','function EXIT_FEE_BPS() view returns(uint256)','function FEE_FANOUT() view returns(address)','function nftFanout() view returns(address)','function configured() view returns(bool)','function initializer() view returns(address)']);
const read=(address,functionName)=>client.readContract({address,abi,functionName,blockNumber:block.number});
const controller=await read(receipt,'controller');
if(await read(controller,'ENTRY_FEE_BPS')!==300n||await read(controller,'EXIT_FEE_BPS')!==600n)throw Error('Replacement controller must charge 3%/6%');
const splitRouter=await read(controller,'FEE_FANOUT');
if((await read(splitRouter,'nftFanout')).toLowerCase()!==target.weightedFanout.address.toLowerCase())throw Error('Controller points to a different NFT fanout');
if(await read(target.weightedFanout.address,'configured')||(await read(target.weightedFanout.address,'initializer')).toLowerCase()!==owner.toLowerCase())throw Error('Expected unconfigured fanout initialized by the collection operator');
const supply=await client.readContract({address:receipt,abi,functionName:'totalSupply',blockNumber:block.number});
const open=await client.readContract({address:receipt,abi,functionName:'entriesOpen',blockNumber:block.number});
const calls=[];
const deployments=[];
function deploy(name,args,label){
 const artifact=art(name),init=encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode.object,args});
 if((artifact.deployedBytecode.object.length-2)/2>24576||(init.length-2)/2>49152)throw Error('Contract size limit');
 const salt=keccak256(toHex(`deltaLP:nft:v1:${label}`));
 const address=getCreate2Address({from:factory,salt,bytecodeHash:keccak256(init)});
 const data=concat([salt,init]);
 calls.push({label:`Deploy ${label}`,to:factory,data,value:'0'});
 deployments.push({label,contract:name,address,constructorArgs:args,creationCodeHash:keccak256(init)});
 return address;
}
function configure(contract,address,fn,args=[]){calls.push({label:`${address}: ${fn}`,to:address,data:encodeFunctionData({abi:art(contract).abi,functionName:fn,args}),value:'0'});}
const adapter=deploy('DnInventoryAdapter',[owner,receipt,expectedReceiptHash],'inventory-adapter');
const collections=[];
for(const edition of assets){
 // Read back the public collection and boundary tokens before encoding immutable URIs.
 for(const url of [edition.contractURI,`${edition.baseURI}1`,`${edition.baseURI}10000`]){
  const r=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(`Unavailable public metadata for $${edition.denomination}`);
  const m=await r.json();if(!m.image||m.image.includes('REPLACE_WITH_CID'))throw Error('Invalid public image URL');
 }
 const address=deploy('DnSeaDropEdition',[`Money Doubler $${edition.denomination}`,`DLP${edition.denomination}`,BigInt(edition.denomination),owner,adapter,houseFees],`edition-${edition.denomination}`);
 configure('DnSeaDropEdition',address,'configure');
 configure('DnSeaDropEdition',address,'setBaseURI',[edition.baseURI]);
 configure('DnSeaDropEdition',address,'setContractURI',[edition.contractURI]);
 configure('DnSeaDropEdition',address,'setProvenanceHash',[edition.provenanceHash]);
 configure('DnSeaDropEdition',address,'updateDropURI',[dependencies.seaDrop,edition.contractURI]);
 configure('DnInventoryAdapter',adapter,'setEdition',[address,true]);
 collections.push({...edition,address});
}
configure('WeightedNftFeeFanout',target.weightedFanout.address,'configure',[collections.map(x=>x.address)]);
const bundle={version:1,status:'unsigned-paused-deployment',chainId:4663,owner,observedAt:new Date(Number(block.timestamp)*1000).toISOString(),block:String(block.number),receiptSupply:String(supply),entriesOpen:open,adapter,collections,dependencies:pinned,deployments,calls,
 openingRequirements:['Activated canonical receipts donated to the protocol inventory by their owner.','Fresh bounded swap/NAV quotes and exact ETH prices, sale schedule, and per-wallet mint limit.','Canonical single-writer transaction submission; do not compete with the keeper EOA.','Verified deployed source/configuration and OpenSea indexing/compatibility check.'],
 explicitlyExcluded:['No USDG/ETH capital funding, swap, trade, approval, deposit, mint or unpause transaction is included.']};
mkdirSync('artifacts/nft-deployment',{recursive:true});
writeFileSync('artifacts/nft-deployment/unsigned.json',JSON.stringify(bundle,(_,v)=>typeof v==='bigint'?String(v):v,2));
console.log(JSON.stringify({adapter,collections:collections.map(x=>({denomination:x.denomination,address:x.address})),calls:calls.length,receiptSupply:String(supply),status:bundle.status}));
