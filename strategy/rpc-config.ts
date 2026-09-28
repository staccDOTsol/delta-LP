export const defaultRobinhoodRpc='https://rpc.mainnet.chain.robinhood.com';

export function rpcEndpoint(value?:string):string{
  if(!value?.trim())return defaultRobinhoodRpc;
  try{
    const url=new URL(value.trim());
    if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error();
    return url.href;
  }catch{throw new Error('Invalid Robinhood HTTPS RPC configuration.');}
}
