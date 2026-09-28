import {useEffect,useState,useRef} from 'react';
import {formatUnits} from 'viem';
import {Wallet,ArrowRight,RefreshCw} from 'lucide-react';
import {connectWallet} from './client.js';
import {NeutralClient} from './neutral-client.js';
import {neutralDeployments} from '../../strategy/neutral-deployment.js';
import {legacyNeutralDeployment} from '../../strategy/legacy-neutral-deployment.js';
import {readNeutral} from '../../strategy/neutral.js';
import type {NeutralState} from '../../strategy/neutral.js';
import {exitMinimum} from '../../strategy/neutral-quotes.js';

type Snapshot=Awaited<ReturnType<NeutralClient['snapshot']>>;
type Exit=Awaited<ReturnType<NeutralClient['exitDetails']>>;
const usd=(n:string|bigint)=>Number(formatUnits(BigInt(n),6)).toLocaleString('en',{maximumFractionDigits:6});
const shares=(n:bigint)=>formatUnits(n,18);
export function NeutralPanel({legacy=false}:{legacy?:boolean}){
  const deployed=legacy?legacyNeutralDeployment:neutralDeployments[0];
  const [state,setState]=useState<NeutralState>(),[client,setClient]=useState<NeutralClient>(),[snapshot,setSnapshot]=useState<Snapshot>();
  const [amount,setAmount]=useState('10'),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [txHash,setTxHash]=useState(''),[minimum,setMinimum]=useState(''),[cashMinimum,setCashMinimum]=useState('');
  const [exits,setExits]=useState<Exit[]>([]),[exitLimit,setExitLimit]=useState(10);
  const [walletCash,setWalletCash]=useState<{address:string;balance?:bigint;error?:string}>(),[balanceRetry,setBalanceRetry]=useState(0);
  const [coordinator,setCoordinator]=useState('');
  const running=useRef(false);
  const refreshSequence=useRef(0);
  async function refresh(c=client){
    const sequence=++refreshSequence.current;
    if(c){
      const s=await c.snapshot();
      if(sequence===refreshSequence.current){setSnapshot(s);setState(s.state);}
      const indices=Array.from({length:Math.min(Number(s.exitCount),exitLimit)},(_,i)=>s.exitCount-1n-BigInt(i));
      const items=await Promise.all(indices.map(i=>c.exitDetails(i)));
      if(sequence===refreshSequence.current)setExits(items);
    }else{
      if(legacy){const prior=await readNeutral(deployed);if(sequence===refreshSequence.current)setState(prior);return;}
      const response=await fetch('/api/strategies/neutral');if(!response.ok)throw new Error('Pool status is unavailable.');
      const body=await response.json() as {vaults:NeutralState[]};if(sequence===refreshSequence.current)setState(body.vaults[0]);
    }
  }
  useEffect(()=>{
    let active=true;setCoordinator('');
    if(client)void client.coordinator().then(address=>{if(active)setCoordinator(address.toLowerCase());}).catch(()=>{});
    return()=>{active=false;};
  },[client]);
  useEffect(()=>{
    if(!client)return;
    let active=true,pending=false;
    const update=async()=>{
      if(pending)return;pending=true;
      try{const balance=await client.walletBalance();if(active)setWalletCash({address:client.address,balance});}
      catch{if(active)setWalletCash({address:client.address,error:'USDG balance unavailable.'});}
      finally{pending=false;}
    };
    setWalletCash({address:client.address});void update();
    const timer=setInterval(()=>void update(),15000);
    return()=>{active=false;clearInterval(timer);};
  },[client,balanceRetry]);
  useEffect(()=>{
    let active=true;
    const update=async()=>{if(!active||running.current)return;try{await refresh();}catch{if(active)setError('Refresh failed. Transaction controls require a fresh chain check.');}};
    void update();const timer=setInterval(()=>void update(),15000);
    const provider=client?.provider as (NeutralClient['provider']&{on?:(event:string,fn:()=>void)=>void;removeListener?:(event:string,fn:()=>void)=>void})|undefined;
    const changed=()=>{++refreshSequence.current;setClient(undefined);setSnapshot(undefined);setExits([]);setNotice('Wallet changed. Reconnect to view this account.');};
    provider?.on?.('accountsChanged',changed);provider?.on?.('chainChanged',changed);
    return()=>{active=false;++refreshSequence.current;clearInterval(timer);provider?.removeListener?.('accountsChanged',changed);provider?.removeListener?.('chainChanged',changed);};
    // refresh captures the current client and requested exit page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[client,exitLimit]);
  async function run(label:string,work:()=>Promise<string>){
    if(running.current)return;running.current=true;setBusy(label);setError('');
    try{setNotice(await work());await refresh();}catch(e){setError(e instanceof Error?e.message:'The action could not be confirmed.');}
    finally{running.current=false;setBusy('');}
  }
  async function connect(){
    if(running.current)return;running.current=true;setBusy('Connecting wallet…');setError('');
    try{
      const w=await connectWallet();
      setSnapshot(undefined);setExits([]);setWalletCash(undefined);
      setClient(new NeutralClient(w.provider,w.address,deployed));
      setNotice('Wallet connected. Review the amount and pool status.');
    }catch(e){setError(e instanceof Error?e.message:'Wallet connection failed.');}
    finally{running.current=false;setBusy('');}
  }
  let saved:ReturnType<NeutralClient['pending']>=null,journalError='';
  try{saved=client?.pending()??null;}catch{journalError='The saved transaction record could not be read. Preserve it and inspect the wallet history before recovery.';}
  const pending=client?.hasPending();
  let exitFloor:string|null=null;
  if(snapshot&&snapshot.balance>0n)try{exitFloor=usd(exitMinimum(snapshot.balance,BigInt(snapshot.state.totalSupply),snapshot.state.nav===null?null:BigInt(snapshot.state.nav),snapshot.state.exitFeeBps));}catch{/* stale valuation: offer in-kind recovery */}
  return <div className="neutral-entry">
    <span className="track-label">ONE RECEIPT · MATCHED LONG / SHORT POOLS</span><h2>{legacy?'Recover an earlier deposit.':'Enter delta neutral.'}</h2>
    {legacy?<p>Your earlier deposit remains in the previous vault. Connect its wallet to refund pending USDG or recover existing positions.</p>:<p>Your USDG is split across matching long and short tiers. The receipt is issued after the venue positions are reconciled and liquidity is added to every paired V4 pool.</p>}
    <div className="neutral-facts"><span>{state?`ETH · 1–${state.tiers}× targets`:'ETH · all supported tiers'}</span><span>{state?`Current contract: ${state.entryFeeBps/100}% entry · ${state.exitFeeBps/100}% exit`:'Reading contract fees…'}</span><span>0% transfer tax</span></div>
    <p className="trade-notice">Targets retain collateral headroom; actual leverage varies. This is a managed, leveraged LP strategy. Fees and losses affect your balance, and liquidation remains possible.</p>
    {!legacy&&<label className="neutral-amount">Deposit <span>USDG</span><input aria-label="Neutral deposit amount" inputMode="decimal" value={amount} maxLength={19} onChange={e=>setAmount(e.target.value)} disabled={!!busy}/></label>}
    {state?<div className="account-summary"><dl><div><dt>Pending batch</dt><dd>{usd(BigInt(state.pendingAssets)+BigInt(state.nftContributions))} / {usd(state.minimumBatchAssets)} USDG{BigInt(state.nftContributions)>0n?<small> · {usd(state.pendingAssets)} deposits + {usd(state.nftContributions)} from NFT mints</small>:null}</dd></div><div><dt>Receipt supply</dt><dd>{shares(BigInt(state.totalSupply))}</dd></div><div><dt>Pool state</dt><dd>{!state.configured?'Configuring all tiers':!state.entriesOpen?'Entries closed':state.phase===0?'Collecting':state.phase===1?'Building positions':'Refunds available'}</dd></div></dl></div>:<p role="status">{deployed?'Reading pool state…':'Preparing the receipt deployment.'}</p>}
    {!client?<button type="button" className="wl-button" disabled={!!busy||!deployed} onClick={()=>void connect()}><Wallet size={18}/>Connect wallet<ArrowRight size={17}/></button>:<>
      <p className="trade-notice" role="status">{client.address.slice(0,6)}…{client.address.slice(-4)} · {walletCash?.address===client.address&&walletCash.balance!==undefined?`${usd(walletCash.balance)} USDG in wallet`:walletCash?.address===client.address&&walletCash.error?<>{walletCash.error} <button className="inline-link" onClick={()=>setBalanceRetry(n=>n+1)}>Retry balance</button></>:'Loading USDG balance…'}</p>
      {!legacy&&state?.configured&&!state.entriesOpen&&coordinator===client.address.toLowerCase()?<section className="neutral-position"><h3>Coordinator controls</h3><p>Enable refundable USDG deposits while the pool builds toward 2,000 USDG. This action does not start allocation or trading.</p><button className="secondary-button" disabled={!!busy||!!pending} onClick={()=>void run('Confirm enabling deposits in your wallet…',()=>client.openEntries())}>Enable deposits</button></section>:null}
      {!legacy&&<button type="button" className="wl-button" disabled={!!busy||!!pending||!state?.entriesOpen||state.phase!==0} onClick={()=>void run('Confirm entry in your wallet…',()=>client.enter(amount))}>Enter delta neutral<ArrowRight size={17}/></button>}
      {!legacy&&<p className="trade-notice">One application action; your wallet may ask for USDG approval and deposit separately. Pending deposits earn no pool fees. Pooling must reach the batch minimum before allocation starts.</p>}
      {snapshot&&snapshot.pendingAssets>0n?<section className="neutral-position"><h3>Your pending deposit</h3><strong>{usd(snapshot.pendingAssets)} USDG</strong><p>Minimum receipt: {shares(snapshot.minimumShares)} dlpDN. {snapshot.issued?'Member claims issued; paired exposure and LP activation remain pending.':'Cash remains refundable before claims are issued.'}</p>
        <div className="funding-actions">{!snapshot.issued?<button className="secondary-button" disabled={!!busy||!!pending} onClick={()=>void run('Returning pending USDG…',()=>client.cancel())}>Cancel & refund</button>:<button className="secondary-button" disabled={!!busy||!!pending} onClick={()=>void run('Recovering member claims…',()=>client.recover(false))}>Recover member tokens</button>}
        {state?.readyToActivate?<button className="secondary-button" disabled={!!busy||!!pending} onClick={()=>void run('Activating confirmed pools…',()=>client.activate())}>Activate receipts</button>:null}</div>
        {state?.activationIssue?<p>{state.activationIssue}</p>:null}
        <details><summary>Pending deposit recovery options</summary><label>Lower receipt minimum<input inputMode="decimal" value={minimum} onChange={e=>setMinimum(e.target.value)}/></label><button className="secondary-button" disabled={!!busy||!!pending} onClick={()=>void run('Updating your receipt minimum…',()=>client.lowerDepositMinimum(minimum))}>Set lower minimum</button>
        {snapshot.issued?<><label>Minimum USDG payout<input inputMode="decimal" value={cashMinimum} onChange={e=>setCashMinimum(e.target.value)}/></label><p>Converts your issued member claims back to USDG after settlement, with the {snapshot.state.exitFeeBps/100}% redemption fee.</p><button className="secondary-button" disabled={!!busy||!!pending} onClick={()=>void run('Requesting cash recovery…',()=>client.recover(true,cashMinimum))}>Request USDG recovery</button></>:null}</details>
      </section>:null}
      {snapshot&&snapshot.balance>0n?<section className="neutral-position"><h3>Your pool receipt</h3><strong>{shares(snapshot.balance)} dlpDN</strong><p>{exitFloor?`Exit minimum: ${exitFloor} USDG, including the ${snapshot.state.exitFeeBps/100}% fee and a 1% movement allowance.`:'Valuation is stale. Member-token recovery remains available.'}</p><button className="secondary-button" disabled={!!busy||!!pending||!exitFloor} onClick={()=>void run('Requesting your USDG exit…',()=>client.exit())}>Exit to USDG</button><details><summary>Exit without a current valuation</summary><p>Remove your proportional liquidity and create an exit escrow with no USDG minimum. You can recover its unsettled member tokens immediately below. This does not guarantee their cash value.</p><button className="secondary-button" disabled={!!busy||!!pending} onClick={()=>void run('Removing liquidity into recovery…',()=>client.exit(true))}>Remove liquidity for recovery</button></details></section>:null}
      {exits.map(exit=><ExitCard key={exit.address} exit={exit} disabled={!!busy||!!pending} finish={(kind)=>void run(kind?'Recovering exit claims…':'Claiming USDG…',()=>client.finishExit(exit.address,kind))} lower={(value)=>void run('Updating exit minimum…',()=>client.lowerExitMinimum(exit.address,value))} progress={(extend)=>void run('Advancing exit settlement…',()=>client.progressExit(exit.address,extend))}/>)}
      {snapshot&&snapshot.exitCount>BigInt(exitLimit)?<button className="inline-link" onClick={()=>setExitLimit(n=>n+10)}>Load earlier exits</button>:null}
      {saved?<section className="neutral-position"><h3>Confirm saved transaction</h3><p>{saved.label} has not been confirmed. No automatic retry will be sent.</p><label>Wallet transaction hash<input value={txHash} placeholder={saved.hash??'0x…'} onChange={e=>setTxHash(e.target.value)}/></label><button className="secondary-button" disabled={!!busy} onClick={()=>void run('Checking the saved transaction…',()=>client.reconcile(txHash||undefined))}>Check confirmation</button></section>:null}
      {journalError?<p className="wl-error" role="alert">{journalError}</p>:null}
    </>}
    {!legacy&&state&&!state.entriesOpen?<p className="trade-notice">The coordinator must enable deposits on-chain. The 2,000 USDG minimum starts allocation; it is not a minimum individual deposit.</p>:null}
    <button className="inline-link" disabled={!!busy} onClick={()=>void run('Refreshing on-chain state…',async()=>{await refresh();return 'On-chain state refreshed.';})}>Refresh <RefreshCw size={13}/></button>
    {busy?<p role="status">{busy}</p>:null}{notice?<p className="execution-status" role="status">{notice}</p>:null}{error?<p className="wl-error" role="alert">{error}</p>:null}
  </div>;
}
function ExitCard({exit,disabled,finish,lower,progress}:{exit:Exit;disabled:boolean;finish:(inKind:boolean)=>void;lower:(text:string)=>void;progress:(extend:boolean)=>void}){
  const [minimum,setMinimum]=useState('');
  if(exit.completed)return <p className="trade-notice">Exit {exit.address.slice(0,8)}… settled or recovered.</p>;
  const expired=exit.deadline<=BigInt(Math.floor(Date.now()/1000));
  return <section className="neutral-position"><h3>USDG exit</h3><p>{exit.ready?'Member redemptions settled':'Waiting for member redemptions'} · {usd(exit.balance)} USDG available · minimum {usd(exit.minimum)} USDG</p><p>{String(exit.queued)} / {String(exit.total)} member redemptions queued.</p><div className="funding-actions"><button className="secondary-button" disabled={disabled||!exit.ready||exit.balance<exit.minimum} onClick={()=>finish(false)}>Claim USDG</button><button className="secondary-button" disabled={disabled} onClick={()=>finish(true)}>Recover unsettled tokens</button></div>{exit.queued<exit.total?<button className="secondary-button" disabled={disabled} onClick={()=>progress(expired)}>{expired?'Extend exit deadline':'Advance next redemption batch'}</button>:null}<details><summary>Lower payout minimum</summary><label>Minimum USDG<input inputMode="decimal" value={minimum} onChange={e=>setMinimum(e.target.value)}/></label><button className="secondary-button" disabled={disabled} onClick={()=>lower(minimum)}>Set lower minimum</button></details><a className="inline-link" href={`https://robin.etherscan.io/address/${exit.address}`} target="_blank" rel="noreferrer">View exit escrow</a></section>;
}
