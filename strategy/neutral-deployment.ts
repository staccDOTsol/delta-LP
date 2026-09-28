import type {Address,Hash} from 'viem';
export type NeutralDeployment={symbol:'ETH';address:Address;runtimeCodeHash:Hash;block:string;tiers:number};
export const neutralDeployments:readonly NeutralDeployment[]=[
  {
    "symbol": "ETH",
    "address": "0x3D4Ee6D147AF67371073e74206D6d49e64960f9c",
    "runtimeCodeHash": "0x30f048d9fc0e88a8b91523e2dafee18aa25f70bfbabaa8c9c5fd370f2a3b6366",
    "block": "74666915",
    "tiers": 50
  }
];
