import {useState} from 'react';
import {connectWallet} from './trading/client.js';
import {MemberSetupClient} from './trading/member-setup.js';
import deployment from '../strategy/member-deployment.js';

export function MemberOperator(){
  const [member,setMember]=useState('1'),[margin,setMargin]=useState('200');
  const [client,setClient]=useState<MemberSetupClient>(),[busy,setBusy]=useState(false),[message,setMessage]=useState('Connect the controller owner to inspect a registered member.');
  const [details,setDetails]=useState('');
  async function run(work:()=>Promise<string>){setBusy(true);try{setMessage(await work());}catch(error){setMessage(error instanceof Error?error.message:'Setup failed. Refresh status before retrying.');}finally{setBusy(false);}}
  async function inspect(c:MemberSetupClient){const s=await c.snapshot();setDetails(`Member ${c.member} · account ${s.accountIndex} · ${s.leverage}× · key generation ${s.setup.generation} · ${s.setup.pending?'setup pending':'no setup pending'}`);return s;}
  return <div className="waitlist-page"><main className="wrap" style={{maxWidth:760,paddingTop:48,paddingBottom:64}}>
    <a className="inline-link" href="/">← deltaLP</a><p className="wl-kicker">OWNER ACCOUNT SETUP</p><h1>Configure a member’s venue account.</h1>
    <p>This registers or rotates the custody account’s Lighter operator key, then configures cross margin. New entries pause during setup. Funding, orders, and reporter settlement are separate actions.</p>
    <p><strong>The derived key has privileged venue access. It is not a trade-only key.</strong> Keep its wallet signature private. This page never stores the signature or key seed.</p>
    <p style={{overflowWrap:'anywhere'}}>Controller: {deployment.contracts.MemberController.address}</p>
    <div style={{display:'grid',gap:16,margin:'24px 0'}}>
      <label>Member ID <input type="number" min="1" step="1" value={member} disabled={busy} onChange={e=>{setMember(e.target.value);setClient(undefined);setDetails('');}} style={{display:'block',width:'100%',padding:12}}/></label>
      <button className="wl-button" disabled={busy} onClick={()=>void run(async()=>{setClient(undefined);setDetails('');if(!/^[1-9]\d*$/.test(member))throw new Error('Enter a positive member ID.');const wallet=await connectWallet();const c=new MemberSetupClient(wallet.provider,wallet.address,BigInt(member));await inspect(c);setClient(c);return 'Owner and custody verified. Refresh any pending transaction before continuing.';})}>Connect & inspect</button>
      {details&&<p>{details}</p>}
      <label>Initial margin in basis points <input type="number" min="1" max="10000" step="1" value={margin} disabled={busy} onChange={e=>setMargin(e.target.value)} style={{display:'block',width:'100%',padding:12}}/></label>
      <p>100 basis points = 1%. The venue’s allowed minimum and the controller’s collateral headroom still apply. This setting does not change the member’s target leverage.</p>
      <button className="wl-button" disabled={busy||!client} onClick={()=>void run(()=>client!.register(Number(margin)))}>Register / rotate key</button>
      <button className="wl-button" disabled={busy||!client} onClick={()=>void run(()=>client!.configureMargin())}>Configure margin</button>
      <button className="wl-button" disabled={busy||!client} onClick={()=>void run(async()=>{const status=await client!.reconcile();await inspect(client!);return status;})}>Refresh transaction status</button>
    </div>
    <p role="status" aria-live="polite" style={{overflowWrap:'anywhere'}}>{busy?'Checking account setup…':message}</p>
    <details><summary>Recover a rejected margin configuration</summary><p>If Lighter refuses the requested margin, abandon that requirement and let the reporter reconcile the actual setting. This keeps entries closed and still requires the installed key to match.</p><button className="wl-button" disabled={busy||!client} onClick={()=>void run(()=>client!.abandonMargin())}>Abandon margin requirement</button></details>
  </main></div>;
}
