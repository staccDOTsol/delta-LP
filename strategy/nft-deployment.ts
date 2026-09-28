import type {Address,Hash} from 'viem';
export type NftDeployment={adapter:Address;adapterRuntimeCodeHash:Hash;receipt:Address;collections:readonly {denomination:number;address:Address}[]};
export const nftDeployment:NftDeployment|null={
  "adapter": "0x7518E5121A2841568dDE5A81eec8C962EcfCc0C5",
  "adapterRuntimeCodeHash": "0xc38340e0d5d17037ca8178e5c1d1526feb4ee366ae619244a4e6813108c7cc54",
  "receipt": "0x3D4Ee6D147AF67371073e74206D6d49e64960f9c",
  "collections": [
    {
      "denomination": 1,
      "address": "0xa8dC97388FD0919A654bc05E21034afaafd1FF43"
    },
    {
      "denomination": 2,
      "address": "0x95fc6306d95F8264Ad6cc5336FB8df7e58BCbb7A"
    },
    {
      "denomination": 5,
      "address": "0xA09255F0D9cF94475369A962B3Df6Fd7ac926761"
    },
    {
      "denomination": 10,
      "address": "0xDa66c3e243D15813E6810c0370823A67b1497672"
    }
  ]
};
