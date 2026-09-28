import {useCallback,useEffect,useRef,useState} from 'react';
import {formatEther,type Address} from 'viem';
import {connectWallet} from './client.js';
import {NftMintClient,nftRpc} from './nft-client.js';
import {readNftSale,mintUnavailable,type NftSaleState} from '../../strategy/nft-sale.js';

export function NftMintPanel({collection}:{collection:Address}){
  const [wallet,setWallet]=useState<NftMintClient|null>(null),[state,setState]=useState<NftSaleState|null>(null);
  const [quantity,setQuantity]=useState(1),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [recoveryHash,setRecoveryHash]=useState(''),[hash,setHash]=useState(''),[pending,setPending]=useState(false);
  const [now,setNow]=useState(Math.floor(Date.now()/1000));
  const working=useRef(false),generation=useRef(0);
  const refresh=useCallback(async()=>{
    const request=++generation.current;
    try{
      const next=await readNftSale(nftRpc,collection,wallet?.address);
      if(generation.current===request){setState(next);setError('');setNow(Math.floor(Date.now()/1000));}
    }catch{if(generation.current===request){setState(null);setError('Could not load the on-chain mint status. Refresh to retry.');}}
  },[collection,wallet]);
  useEffect(()=>{
    setState(null);void refresh();const timer=setInterval(()=>void refresh(),15000);
    return()=>{clearInterval(timer);generation.current++;};
  },[refresh]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Math.floor(Date.now()/1000)),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    if(!wallet)return;
    const provider=wallet.provider as typeof wallet.provider&{on?:(name:string,fn:()=>void)=>void;removeListener?:(name:string,fn:()=>void)=>void};
    const changed=()=>{setWallet(null);setState(null);setPending(false);setNotice('Wallet changed. Reconnect to mint.');};
    provider.on?.('accountsChanged',changed);provider.on?.('chainChanged',changed);
    return()=>{provider.removeListener?.('accountsChanged',changed);provider.removeListener?.('chainChanged',changed);};
  },[wallet]);
  async function run(action:()=>Promise<void>){
    if(working.current)return;working.current=true;setBusy(true);setError('');
    try{await action();}catch(e){setError(e instanceof Error?e.message:'Mint action failed.');}
    finally{working.current=false;setBusy(false);if(wallet)try{setPending(Boolean(wallet.pending()));}catch{setPending(true);setError('The saved mint record could not be read. Preserve it and inspect wallet history before another mint.');}}
  }
  const reason=state?mintUnavailable(state,quantity,now):'Loading mint status…';
  return <div className="nft-wallet-panel" aria-label="Mint selected edition">
    <div className="nft-sale-live" role="status"><strong>{state?(reason??'Mint open'):'Checking on-chain sale…'}</strong>
      {state&&<span>{String(state.totalMinted)} / 10,000 minted · Robinhood Chain</span>}</div>
    <div className="nft-mint-inputs"><label>Quantity<input type="number" min="1" max="20" step="1" value={quantity} disabled={busy} onChange={e=>setQuantity(Number(e.target.value))}/></label>
      <div><span>Total mint price</span><strong>{state&&state.drop.mintPrice>0n&&Number.isInteger(quantity)&&quantity>0?`${formatEther(state.drop.mintPrice*BigInt(quantity))} ETH`:'Not set'}</strong><small>Network gas is extra. Review the total in your wallet.</small></div></div>
    {!wallet?<button className="nft-mint-button" disabled={busy} onClick={()=>void run(async()=>{
      const connected=await connectWallet();const next=new NftMintClient(connected.provider,connected.address);setWallet(next);setPending(Boolean(next.pending()));setNotice('Wallet connected. Review the mint price before minting.');
    })}>Connect wallet</button>:<>
      <p className="nft-wallet-address">{wallet.address.slice(0,6)}…{wallet.address.slice(-4)}</p>
      <button className="nft-mint-button" disabled={busy||Boolean(reason)||pending} onClick={()=>void run(async()=>{
        if(!state)throw new Error('Refresh sale status first.');setNotice('Confirm the mint in your wallet.');
        const tx=await wallet.mint(collection,quantity,state.drop.mintPrice);setHash(tx);setNotice('Mint confirmed. Your NFT controls its pending USDG contribution.');await refresh();
      })}>{busy?'Waiting for wallet / confirmation…':`Mint ${quantity} NFT${quantity===1?'':'s'}`}</button>
    </>}
    {wallet&&pending&&<div className="nft-mint-recovery"><p>A mint needs reconciliation before another can be sent.</p><label>Transaction hash (if your wallet did not return one)<input value={recoveryHash} onChange={e=>setRecoveryHash(e.target.value)} placeholder="0x…"/></label><button disabled={busy} onClick={()=>void run(async()=>{setNotice(await wallet.reconcile(recoveryHash));await refresh();})}>Check saved mint</button></div>}
    <button className="nft-mint-refresh" disabled={busy} onClick={()=>void refresh()}>Refresh sale status</button>
    {error&&<p role="alert" className="nft-mint-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {hash&&<a className="inline-link" href={`https://robin.etherscan.io/tx/${hash}`} target="_blank" rel="noreferrer">View confirmed mint</a>}
    <p className="nft-mint-disclosure">Minting pays in ETH and creates a pending USDG claim. Trading starts after the pool reaches 2,000 USDG and allocation completes. Mint fees are non-refundable; pending USDG earns no strategy fees.</p>
  </div>;
}
