const deployment = {
  "chainId": 4663,
  "version": "v2",
  "status": "prototype",
  "contracts": {
    "MemberController": {
      "address": "0x934ceF5C005529a90F45Bd59BA78c7D697672a28",
      "runtimeCodeHash": "0x1e298ae51dc053955006ad8b566aa21af43d13c5af8e94948d188b6d38dc1dc2",
      "transactionHash": "0x66833cc6445603fd90b511064ff0e6f24d209402c0c52d0aac5347843c5ec631"
    },
    "HouseFeeRouter": {
      "address": "0x83B7a36d9BB5bB20D23b26b8A57E1571B6587224",
      "runtimeCodeHash": "0x264c0c86568e4a21b566578647bf6fa0f5c43d7831e7b28e408459c69abe6df2",
      "transactionHash": "0xc976911106abec5c0f70dbccb23bba78f7005f626111e3de432fb911b6551cbf"
    },
    "MemberV4Hook": {
      "address": "0xc5fAA1076716a01Cad3D885AE9850492D7076540",
      "runtimeCodeHash": "0x90bcb6415d986f2f025f56c89baa0b9aadeabbea22e9a1813612b9aa5fcfb157",
      "transactionHash": "0xe6780330093dfdbb7b6f60416925e6e3ddfe15006c01bbf03ca4946568138849"
    },
    "MemberFactory": {
      "address": "0xb8BD90e3538d5a1f7147e05C067B4745592a40F1",
      "runtimeCodeHash": "0xadb162bd877a82de25a50a52659975ea594d5c98c365cbdc2a9eed7c56321646"
    }
  },
  "fanout": "0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8"
} as const;
export default deployment;
