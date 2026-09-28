import {useEffect,useState} from 'react';
import {formatUnits} from 'viem';
import type {NeutralState} from '../strategy/neutral.js';

const usd2=(n:string|bigint)=>Number(formatUnits(BigInt(n),6)).toLocaleString('en',{maximumFractionDigits:2});

/** Hero chip: the one live number that matters while the pool collects. Reads the same cached endpoint as the terminal. */
export function PoolPulse(){
  const [state,setState]=useState<NeutralState|null>(null),[failed,setFailed]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    fetch('/api/strategies/neutral',{signal:controller.signal}).then(r=>r.ok?r.json():Promise.reject(new Error(String(r.status))))
      .then((body:{vaults:NeutralState[]})=>setState(body.vaults[0]??null)).catch(e=>{if(e?.name!=='AbortError')setFailed(true);});
    return()=>controller.abort();
  },[]);
  if(failed)return null;
  if(!state)return <a className="pool-pulse is-loading" href="#strategy" aria-busy="true"><span className="pool-pulse-dot"/>Reading the pool…</a>;
  const collected=BigInt(state.pendingAssets)+BigInt(state.nftContributions),minimum=BigInt(state.minimumBatchAssets);
  const pct=minimum>0n?Number(collected*10_000n/minimum)/100:0;
  const label=!state.configured?'Configuring':!state.entriesOpen?'Entries closed':state.phase===0?'Collecting':state.phase===1?'Building positions':'Refunds open';
  return <a className="pool-pulse" href="#strategy" title={`${usd2(collected)} of ${usd2(minimum)} USDG collected · ${label}`}>
    <span className="pool-pulse-dot"/><strong>{usd2(collected)}</strong><span>/ {usd2(minimum)} USDG</span><em>{label}</em>
    <i className="pool-pulse-bar" aria-hidden><i style={{width:`${Math.min(100,Math.max(pct>0?1.5:0,pct))}%`}}/></i>
  </a>;
}
