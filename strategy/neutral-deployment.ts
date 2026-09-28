import type {Address,Hash} from 'viem';
export type NeutralDeployment={symbol:'ETH';address:Address;runtimeCodeHash:Hash;block:string;tiers:number};
export const neutralDeployments:readonly NeutralDeployment[]=[
  {
    "symbol": "ETH",
    "address": "0x19Bc982b4387c21e0D146b365e033dF5F14f6C85",
    "runtimeCodeHash": "0x032ba58f74a83fab080a73dd973a8fb0ae74c046b99d34ab3379585c26b0d91f",
    "block": "74715737",
    "tiers": 50
  }
];
