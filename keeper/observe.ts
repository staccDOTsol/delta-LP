import {accountSchema} from '../strategy/execution.js';
import deployment from '../strategy/member-deployment.js';
import {memberMarketSchema} from '../strategy/member-reconciliation.js';
import {actionEvidence,emptyAccountReport,hasOpenOrders,nextMemberAction,observedReport,type Call,type Decision,type Policy,type Report,type Snapshot} from './model.js';
import {ChainIndex,client,controller,lighter,lighterAbi,mapLimit,marketData,readMember,readVault,venue} from './rpc.js';
import {controllerAbi} from './abi.js';

export type MemberResult={id:bigint;snapshot?:Snapshot;decision:Decision;report?:Report};
export type Cycle={block:bigint;at:string;members:MemberResult[];calls:Call[];vault:Awaited<ReturnType<typeof readVault>>;reason:string};
export async function observeMember(m:Snapshot,data:Awaited<ReturnType<typeof marketData>>,policy:Policy,blockTimestamp:bigint):Promise<MemberResult>{
  const now=Date.now(),call=(name:string,args:readonly unknown[],reason:string):Decision=>({state:'ready',call:{target:'controller',name,args,member:m.id,reason,
    expiresAt:name==='reconcile'||name==='reconcileVenueSetup'?Math.min(now+30000,Number(blockTimestamp)*1000+40000):Math.min(now+5000,Number(blockTimestamp)*1000+12000)}});
  if(now-Number(blockTimestamp)*1000>12000||now-data.fetchedAt>8000)throw new Error('Keeper observation expired.');
  if(m.executedPriorityCount<m.priorityEnd)return {id:m.id,snapshot:m,decision:{state:'waiting',reason:'Waiting for the Lighter priority queue.'}};
  let candidate:{report:Report;observedKeyHash?:`0x${string}`};
  if(m.mappedIndex===0&&m.requestedAction===0n){
    candidate={report:emptyAccountReport(m,data.market,blockTimestamp)};
  }else{
    if(m.mappedIndex<=2)return {id:m.id,snapshot:m,decision:{state:'waiting',reason:'Waiting for the custody account to be created.'}};
    const raw=await venue(`account?by=index&value=${m.mappedIndex}`);
    if(!Array.isArray(raw.accounts)||raw.accounts.length!==1)throw new Error('Expected one custody account.');
    const account=accountSchema.parse(raw.accounts[0]);
    if(account.index!==m.mappedIndex||account.l1_address.toLowerCase()!==m.custody.toLowerCase())throw new Error('Venue custody identity mismatch.');
    if(!m.bound)return {id:m.id,snapshot:m,decision:call('bindAccount',[m.id,BigInt(m.mappedIndex)],'Bind the confirmed contract-owned Lighter account.')};
    if(m.accountIndex!==m.mappedIndex)throw new Error('Bound account differs from the venue registry.');
    const anchor=m.actions.find(a=>a.nonce===m.confirmedAction);
    const previous=anchor?.kind===2?[...m.actions].reverse().find(a=>a.nonce<anchor.nonce&&a.kind!==2):undefined;
    const required=m.actions.filter(a=>a.nonce>=m.confirmedAction||a===previous);
    const responses=new Map(await Promise.all(required.filter(a=>a.kind!==2).map(async a=>[a.hash,await venue(`txFromL1TxHash?hash=${a.hash}`)] as const)));
    actionEvidence(m,responses);
    if(hasOpenOrders(account)){
      const latest=m.actions.at(-1);
      if(!latest||latest.kind===4||m.setup.pending)return {id:m.id,snapshot:m,decision:{state:'waiting',reason:'Open venue orders remain; waiting for cancellation or operator recovery.'}};
      if(now<Number(m.lastActionAt)*1000+policy.cancelAfterSeconds*1000)return {id:m.id,snapshot:m,decision:{state:'waiting',reason:'Order is still inside its execution window.'}};
      return {id:m.id,snapshot:m,decision:call('cancelVenueOrders',[m.id],'Cancel unfilled order remainders before reporting the actual position.')};
    }
    const keys=m.setup.pending?await venue(`apikeys?account_index=${m.accountIndex}&api_key_index=255`):undefined;
    candidate=observedReport(m,raw.accounts[0],data.market,keys,responses,data.fetchedAt,Date.now(),blockTimestamp);
  }
  const r=candidate.report;
  const oldEquity=m.nav>m.cash?m.nav-m.cash:0n;
  const equityDifference=r.venueEquity>oldEquity?r.venueEquity-oldEquity:oldEquity-r.venueEquity;
  const needsReport=m.setup.pending||m.requestedAction!==m.confirmedAction||m.reportSequence===0n||
    now-Number(m.observedAt)*1000>=policy.refreshSeconds*1000||m.position!==r.position||m.initialMarginBps!==r.initialMarginBps||
    equityDifference*10000n>(m.nav||1n)*10n||r.available<m.venueAvailable;
  if(needsReport)return {id:m.id,snapshot:m,report:r,decision:candidate.observedKeyHash?
    call('reconcileVenueSetup',[m.id,r,candidate.observedKeyHash],'Confirm venue key, margin configuration and actual account state.'):
    call('reconcile',[m.id,r],'Publish the reconciled account state.')};
  // The controller trades against its last accepted report; do not size an order
  // using an unsubmitted report that differs from the actual contract target.
  const accepted={...r,sequence:m.reportSequence,observedAt:m.observedAt,venueEquity:oldEquity,position:m.position,mark:m.mark,
    available:m.venueAvailable,initialMarginBps:m.initialMarginBps};
  return {id:m.id,snapshot:m,report:r,decision:nextMemberAction(m,accepted,data.market,data.book,policy,now)};
}

export async function observe(index:ChainIndex,policy:Policy):Promise<Cycle>{
  let block=await client.getBlock();
  await index.update(block.number);
  // Log indexing can take longer than a report's permitted observation age.
  block=await client.getBlock();await index.update(block.number);
  const [executed,requests,vaultState,data]=await Promise.all([
    client.readContract({address:lighter,abi:lighterAbi,functionName:'executedPriorityRequestCount',blockNumber:block.number}),
    index.pendingRequests(block.number),readVault(block.number),marketData(),
  ]);
  const members=await mapLimit(Array.from({length:100},(_,i)=>BigInt(i+1)),12,async id=>{
    let m:Snapshot|undefined;
    try{m=await readMember(id,block.number,executed,index,requests);return await observeMember(m,data,policy,block.timestamp);}
    catch(error){return {id,snapshot:m,decision:{state:'blocked' as const,reason:(error as Error).message}};}
  });
  // Older accepted reports go first so a busy family cannot starve high IDs.
  const calls=[...members].sort((a,b)=>Number((a.snapshot?.observedAt??0n)-(b.snapshot?.observedAt??0n))).flatMap(m=>m.decision.state==='ready'?[m.decision.call]:[]);
  let reason='Member operations are independently reconciled.';
  const allIdle=members.every(m=>m.decision.state==='idle');
  const now=Date.now(),expiresAt=now+4000;
  const exits=await index.pendingExits(block.number);
  for(const exit of exits){
    if(exit.ready)calls.push({target:'exit',address:exit.address,name:'finish',args:[],reason:'Pay the exit receiver only when its recorded minimum is satisfied.',expiresAt});
    else if(exit.started&&exit.queued<exit.count&&exit.deadline>block.timestamp)calls.push({target:'exit',address:exit.address,name:'queue',args:[20n],reason:'Queue the next ten matched long/short exit pairs.',expiresAt});
  }
  if(allIdle){
    if(vaultState.entriesOpen&&vaultState.phase===0&&vaultState.pendingAssets>=vaultState.minimumBatchAssets){
      const perLeg=vaultState.pendingAssets/100n,net=perLeg-perLeg*BigInt(deployment.feePolicy.entryFeeBps)/10000n;
      if(members.every(m=>m.snapshot!.enabled&&m.snapshot!.nav+net<=policy.maxMemberAssets)){
        const minima=members.map(m=>{const s=m.snapshot!;const expected=s.supply===0n?net*10n**12n:s.nav===0n?0n:net*s.supply/s.nav;return expected*9990n/10000n;});
        if(minima.every(m=>m>0n))calls.push({target:'vault',name:'startAllocation',args:[minima,BigInt(Math.floor(now/1000)+86400)],reason:'Start the eligible all-tier allocation with NAV-based claim minimums.',expiresAt});
      }else reason='Allocation waits for enabled members and capital limits.';
    }else if(vaultState.phase===1&&!vaultState.settled){
      const batch=requests.filter(r=>r.batch===vaultState.first);
      if(batch.length===100&&batch.every(r=>r.deadline>=block.timestamp&&members.find(m=>m.id===r.member)!.snapshot!.nav+r.amount<=policy.maxMemberAssets)){
        calls.push({target:'controller',name:'settleBatch',args:[vaultState.first],reason:'Atomically issue the matched member claims.',expiresAt});
      }else reason='Allocation batch is incomplete, expired, or exceeds capital limits.';
    }else if(vaultState.phase===1&&vaultState.settled){
      calls.push({target:'vault',name:'activate',args:[],reason:'Activate only if the contract confirms all positions, pool prices, and delta bounds.',expiresAt});
    }else{
      const group=await client.readContract({address:controller,abi:controllerAbi,functionName:'memberState',args:[1n],blockNumber:block.number});
      const [requested,checked]=await Promise.all([
        client.readContract({address:controller,abi:controllerAbi,functionName:'groupRequested',args:[group.group],blockNumber:block.number}),
        client.readContract({address:controller,abi:controllerAbi,functionName:'groupChecked',args:[group.group],blockNumber:block.number}),
      ]);
      if(requested!==checked)calls.push({target:'controller',name:'markGroupChecked',args:[group.group,requested],reason:'Acknowledge the latest family transfer sequence after every target checks out.',expiresAt});
    }
  }
  return {block:block.number,at:new Date().toISOString(),members,calls,vault:vaultState,reason};
}
