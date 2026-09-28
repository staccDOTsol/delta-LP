// Read-only chain validation followed by local binding generation. No signer.
import {readFileSync,writeFileSync} from 'node:fs';
import {keccak256,getAddress} from 'viem';
import {client} from './preflight.mjs';

const version=process.argv.find(x=>x.startsWith('--version='))?.slice(10);
if(!version||!/^v[4-9][0-9]*$|^v[1-9][0-9]+$/.test(version))throw new Error('Use a replacement --version=v4 or later.');
const root=new URL('../../',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL(`evm/deployments/4663-tokenized-${version}.json`,root),'utf8'));
const registryFile=`4663-neutral-${version}-registry.json`;
const registry=JSON.parse(readFileSync(new URL(`evm/deployments/${registryFile}`,root),'utf8'));
const nft=JSON.parse(readFileSync(new URL(`evm/deployments/4663-nft-${version}.json`,root),'utf8'));
if(manifest.controllerName!=='SplitFeeMemberController'||manifest.chainId!==4663||await client.getChainId()!==4663)throw new Error('Wrong replacement deployment.');
const art=name=>JSON.parse(readFileSync(new URL(`evm/out/${name==='NeutralEscrowFactory'?'NeutralEscrows':name}.sol/${name}.json`,root),'utf8'));
const names={MemberController:'SplitFeeMemberController',HouseFeeRouter:'SplitHouseFeeRouter',WeightedNftFeeFanout:'WeightedNftFeeFanout',MemberV4Hook:'MemberV4Hook',NeutralEscrowFactory:'NeutralEscrowFactory',NeutralVault:'NeutralVault'};
// A load-balanced RPC may report a tip another backend has not indexed yet.
// Read one confirmed snapshot, after every recorded configuration transaction.
const tip=await client.getBlockNumber({cacheTime:0});
const blockNumber=tip>32n?tip-32n:tip;
const lastNftBlock=nft.calls.reduce((last,call)=>BigInt(call.block)>last?BigInt(call.block):last,0n);
if(blockNumber<lastNftBlock)throw new Error('Wait for NFT configuration confirmations before publishing bindings.');
const contracts={};
for(const [label,name] of Object.entries(names)){
  const step=manifest.steps[name];
  if(!step||step.status!=='deployed')throw new Error(`Missing deployed ${name}`);
  const code=await client.getCode({address:step.address,blockNumber});
  if(!code||keccak256(code)!==step.runtimeCodeHash)throw new Error(`${name} runtime mismatch`);
  contracts[label]={address:getAddress(step.address),runtimeCodeHash:step.runtimeCodeHash,transactionHash:step.transactionHash};
}
const read=(label,functionName,args=[])=>client.readContract({address:contracts[label].address,abi:art(names[label]).abi,functionName,args,blockNumber});
const controller=contracts.MemberController.address,vault=contracts.NeutralVault.address,router=contracts.HouseFeeRouter.address;
if(registry.controller.toLowerCase()!==controller.toLowerCase()||registry.vault.toLowerCase()!==vault.toLowerCase()||registry.members.length!==100||new Set(registry.members.map(m=>m.id)).size!==100)throw new Error('Replacement registry mismatch.');
if(await read('MemberController','ENTRY_FEE_BPS')!==300n||await read('MemberController','EXIT_FEE_BPS')!==600n||(await read('MemberController','feeRouter')).toLowerCase()!==router.toLowerCase())throw new Error('Replacement fee policy mismatch.');
if(!await read('WeightedNftFeeFanout','configured')||await read('WeightedNftFeeFanout','tokenCount')!==40000n||await read('WeightedNftFeeFanout','totalWeight')!==180000n)throw new Error('Four NFT collections must be permanently configured before publishing bindings.');
if(nft.status!=='deployed-paused'||nft.collections.length!==4||nft.dependencies.receipt.address.toLowerCase()!==vault.toLowerCase())throw new Error('Pending NFT deployment mismatch.');
const pendingAdapter=nft.deployments.find(d=>d.contract==='DnPendingAdapter');
const pendingCode=pendingAdapter&&await client.getCode({address:pendingAdapter.address,blockNumber});
if(!pendingCode||keccak256(pendingCode)!==pendingAdapter.runtimeCodeHash)throw new Error('NFT adapter runtime mismatch.');
const nftPins=[...nft.deployments,...Object.values(nft.dependencies)].map(({address,runtimeCodeHash})=>({address,runtimeCodeHash}));
nftPins.push({address:'0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',runtimeCodeHash:'0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6'});
for(const pin of nftPins){
  const code=await client.getCode({address:pin.address,blockNumber});
  if(!code||keccak256(code)!==pin.runtimeCodeHash)throw new Error('NFT dependency runtime mismatch.');
}
for(let i=0;i<4;i++)if((await read('WeightedNftFeeFanout','collections',[BigInt(i)])).toLowerCase()!==nft.collections[i].address.toLowerCase())throw new Error('NFT collection registry mismatch.');
if((await read('HouseFeeRouter','nftFanout')).toLowerCase()!==contracts.WeightedNftFeeFanout.address.toLowerCase())throw new Error('NFT router wiring mismatch.');
if(!await read('NeutralVault','configured')||await read('NeutralVault','entriesOpen')||await read('NeutralVault','totalSupply')!==0n||await read('NeutralVault','pendingAssets')!==0n)throw new Error('Replacement must be configured, closed and empty before initial promotion.');
if((await read('NeutralVault','controller')).toLowerCase()!==controller.toLowerCase()||await read('NeutralVault','tiers')!==50)throw new Error('Replacement vault identity mismatch.');
for(const member of registry.members){
  const state=await read('MemberController','memberState',[BigInt(member.id)]);
  if(state.token.toLowerCase()!==member.token.toLowerCase()||state.custody.toLowerCase()!==member.custody.toLowerCase()||state.leverage!==member.tier||state.short!==member.short)throw new Error('Member registry identity mismatch.');
}
const factory=await read('MemberController','factory'),factoryCode=await client.getCode({address:factory,blockNumber});
if(!factoryCode||factory.toLowerCase()!==manifest.factory.address.toLowerCase()||keccak256(factoryCode)!==manifest.factory.runtimeCodeHash)throw new Error('Factory runtime mismatch.');
contracts.MemberFactory={address:getAddress(factory),runtimeCodeHash:keccak256(factoryCode)};
const genesisBlock=String(Object.values(manifest.steps).map(s=>BigInt(s.blockNumber)).reduce((a,b)=>a<b?a:b));
const deployment={chainId:4663,version,registryFile,genesisBlock,feePolicy:{entryFeeBps:300,exitFeeBps:600,wizardsBps:5000,nftsBps:5000},status:'prototype',contracts,fanout:router};
writeFileSync(new URL('strategy/member-deployment.ts',root),`const deployment = ${JSON.stringify(deployment,null,2)} as const;\nexport default deployment;\n`);
const neutral=[{symbol:'ETH',address:vault,runtimeCodeHash:contracts.NeutralVault.runtimeCodeHash,block:manifest.steps.NeutralVault.blockNumber,tiers:50}];
writeFileSync(new URL('strategy/neutral-deployment.ts',root),`import type {Address,Hash} from 'viem';\nexport type NeutralDeployment={symbol:'ETH';address:Address;runtimeCodeHash:Hash;block:string;tiers:number};\nexport const neutralDeployments:readonly NeutralDeployment[]=${JSON.stringify(neutral,null,2)};\n`);
const nftBinding={adapter:pendingAdapter.address,adapterRuntimeCodeHash:pendingAdapter.runtimeCodeHash,receipt:vault,
  collections:nft.collections.map(({denomination,address})=>({denomination,address}))};
writeFileSync(new URL('strategy/nft-deployment.ts',root),`import type {Address,Hash} from 'viem';\nexport type NftDeployment={adapter:Address;adapterRuntimeCodeHash:Hash;receipt:Address;collections:readonly {denomination:number;address:Address}[]};\nexport const nftDeployment:NftDeployment|null=${JSON.stringify(nftBinding,null,2)};\n`);
writeFileSync(new URL('strategy/nft-pins.ts',root),`// Confirmed deployment fingerprints; no signing material.\nexport const nftOwner='${nft.owner}' as const;\nexport const nftPins=${JSON.stringify(nftPins,null,2)} as const;\n`);
console.log(JSON.stringify({version,block:String(blockNumber),controller,vault,router,status:'Local bindings written; rebuild site and worker before activation.'}));
