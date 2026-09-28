// Server-only: never import this module from web/. The browser has a separately
// scoped VITE_ROBINHOOD_RPC_URL and must not receive this credential.
import {rpcEndpoint} from './rpc-config.js';
export const serverRpcUrl=rpcEndpoint(process.env.ROBINHOOD_RPC_URL);
