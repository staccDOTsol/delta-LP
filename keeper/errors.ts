export function errorSummary(error:unknown):string{
  const e=error as {shortMessage?:unknown;message?:unknown}|null;
  const message=typeof e?.shortMessage==='string'?e.shortMessage:typeof e?.message==='string'?e.message:'Keeper operation failed.';
  // Endpoint paths can contain provider credentials. Never log full RPC errors,
  // request bodies, or the credential-bearing URL from a provider diagnostic.
  return message.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi,'[endpoint redacted]').split('\n')[0].slice(0,400);
}

export function retryableTransport(error:unknown):boolean{
  const seen=new Set<unknown>();let current=error;
  for(let depth=0;current&&typeof current==='object'&&depth<8&&!seen.has(current);depth++){
    seen.add(current);
    const e=current as {name?:string;status?:number;code?:string|number;cause?:unknown};
    if(e.name==='TimeoutError'||e.name==='LimitExceededRpcError')return true;
    if(e.name==='HttpRequestError'&&(e.status===undefined||e.status===408||e.status===429||e.status===502||e.status===503||e.status===504))return true;
    if(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN'].includes(String(e.code)))return true;
    current=e.cause;
  }
  return false;
}
