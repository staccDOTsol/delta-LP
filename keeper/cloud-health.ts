import {z} from 'zod';

export function cloudHealth(raw:unknown,mode:'observation'|'execution',startedAt:number,now=Date.now()){
  const parsed=z.object({mode:z.enum(['observation','execution']),at:z.string().datetime(),block:z.string().regex(/^\d+$/),
    members:z.array(z.object({id:z.string(),decision:z.object({state:z.enum(['ready','idle','blocked','waiting'])})})).length(100),
    vault:z.object({entriesOpen:z.boolean()})}).safeParse(raw);
  if(!parsed.success)return {ok:false,mode,reason:'Waiting for a complete 100-member observation.'};
  const status=parsed.data,time=Date.parse(status.at);
  if(status.mode!==mode||time<startedAt||time>now+5000||now-time>90_000)return {ok:false,mode,reason:'The worker has no fresh observation for this process.'};
  const unique=new Set(status.members.map(m=>m.id));
  if(unique.size!==100||status.members.some(m=>!/^\d+$/.test(m.id)||BigInt(m.id)<1n||BigInt(m.id)>100n))return {ok:false,mode,reason:'Member observation identity mismatch.'};
  const counts=status.members.reduce((out,m)=>{out[m.decision.state]=(out[m.decision.state]??0)+1;return out;},{} as Record<string,number>);
  return {ok:counts.blocked!==100,mode,observedAt:status.at,block:status.block,members:counts,entriesOpen:status.vault.entriesOpen,
    ...(counts.blocked===100?{reason:'Every member is blocked; inspect the operator status.'}:{})};
}
