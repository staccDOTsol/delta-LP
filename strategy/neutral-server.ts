import {createPublicClient,http} from 'viem';
import {serverRpcUrl} from './server-rpc.js';
import {neutralDeployments} from './neutral-deployment.js';
import {readNeutral,type NeutralState} from './neutral.js';

const rpc=createPublicClient({transport:http(serverRpcUrl,{timeout:10000})});
let cached:{at:number;value:NeutralState[]}|undefined,pending:Promise<NeutralState[]>|undefined;
export async function neutralState(){
  if(cached&&Date.now()-cached.at<10000)return cached.value;
  if(pending)return pending;
  pending=Promise.all(neutralDeployments.map(d=>readNeutral(d,rpc)));
  try{const value=await pending;cached={at:Date.now(),value};return value;}finally{pending=undefined;}
}
