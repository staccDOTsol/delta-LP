import type {Address,Hash} from 'viem';
export type NftDeployment={adapter:Address;adapterRuntimeCodeHash:Hash;receipt:Address;collections:readonly {denomination:number;address:Address}[]};
export const nftDeployment:NftDeployment|null={
  "adapter": "0xE454667569852d99BeB0C19c7275fAbCc2874104",
  "adapterRuntimeCodeHash": "0xdb6440e7d08a16c4dd2a09194a5baf8bc95717a6d080e54ccc7d58c9829458c7",
  "receipt": "0x19Bc982b4387c21e0D146b365e033dF5F14f6C85",
  "collections": [
    {
      "denomination": 1,
      "address": "0x97E78A8aEEEb79076dBfbaBB23F016be7c354F41"
    },
    {
      "denomination": 2,
      "address": "0xd301a76601F27c682F64062b4A254fd7aed601Ea"
    },
    {
      "denomination": 5,
      "address": "0xa6D443b39fE77B8e1013482d300994cA84B5635C"
    },
    {
      "denomination": 10,
      "address": "0xcF07E0A91EDECCf9aA377BF8d451d50D8f998131"
    }
  ]
};
