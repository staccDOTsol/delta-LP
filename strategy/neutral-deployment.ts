import type {Address,Hash} from 'viem';

export type NeutralDeployment={symbol:'ETH';address:Address;runtimeCodeHash:Hash;block:string;tiers:number};
// Verified against evm/deployments/4663-tokenized-v3.json.
export const neutralDeployments:readonly NeutralDeployment[]=[
  {
    "symbol": "ETH",
    "address": "0xe9AE3aEb63680960995978ee6c33E68B57c00688",
    "runtimeCodeHash": "0xd0d6433e5c15da98889004c7ffa9d721077404567a5740e14523faaeaa646ab1",
    "block": "74589594",
    "tiers": 50
  }
];
