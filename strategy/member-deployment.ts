const deployment = {
  "chainId": 4663,
  "version": "v5",
  "registryFile": "4663-neutral-v5-registry.json",
  "genesisBlock": "74655399",
  "feePolicy": {
    "entryFeeBps": 300,
    "exitFeeBps": 600,
    "wizardsBps": 5000,
    "nftsBps": 5000
  },
  "status": "prototype",
  "contracts": {
    "MemberController": {
      "address": "0xae3600b13a2F894f81F6565DD207492601B2Ce3E",
      "runtimeCodeHash": "0x3be4509eeaf2d11acd30bc31b51f8ff717640dc748202131618de9e939328bb4",
      "transactionHash": "0x79668288d8e9199e0261042b156d886079082f651f061f3ebf53e6e27ca1499b"
    },
    "HouseFeeRouter": {
      "address": "0x0264C6739483f80285B4e6ebd342B22b3785A9F0",
      "runtimeCodeHash": "0x8282dcd9c44e5f90b2b56cdab4785a54394e59fa651346c152a073a4aaf5b328",
      "transactionHash": "0x6d92f34ecd8ccf76e582c7781e3715b1b32cecc030b7e36cfd92b8d0290e7737"
    },
    "WeightedNftFeeFanout": {
      "address": "0x5D38705D0c40c814CF2Eeb67d9ECD885cd9708FC",
      "runtimeCodeHash": "0x32033799123487bd165178898a45ce0380ae907cda19a2a44c6047f67d26faa9",
      "transactionHash": "0x554fea39512ccfde3389345c2614d5506ff0b64fc3f8439117578584bcb4b4f0"
    },
    "MemberV4Hook": {
      "address": "0xAC6faA03b0dB4bB8b4dB9989653A68fd5112e540",
      "runtimeCodeHash": "0x377bc1b180cf4272d487aba89d84e34ffeeb90064464e20a868dcbf92bb59351",
      "transactionHash": "0xfd1e2b72162d08a402507850d0e509dc7e5e6c8e843b69695464f03358a20a28"
    },
    "NeutralEscrowFactory": {
      "address": "0x1C194B26fE68A4b4801a21E4a36a89A5803aDb71",
      "runtimeCodeHash": "0x9bd7a862fdccc54b1b4836156d4a5c15490d86ea60d7c687d01aada5963be225",
      "transactionHash": "0x6e1ea187c95ef8f1bb8a70ef2f776ac217ee7fc734094c120f2ffc71e44738bd"
    },
    "NeutralVault": {
      "address": "0x3D4Ee6D147AF67371073e74206D6d49e64960f9c",
      "runtimeCodeHash": "0x30f048d9fc0e88a8b91523e2dafee18aa25f70bfbabaa8c9c5fd370f2a3b6366",
      "transactionHash": "0x45bc3ff850c17e9a80ff7b2a6eade054668275732dc923c260f8fdff0fcf690f"
    },
    "MemberFactory": {
      "address": "0x4E7782e66dD5e0F5D820676F6FAe1bfC2509fa54",
      "runtimeCodeHash": "0xcfd6ad6842a1d665d770629899c84ed1edc2242e58b4b73a0ee1094415a47f29"
    }
  },
  "fanout": "0x0264C6739483f80285B4e6ebd342B22b3785A9F0"
} as const;
export default deployment;
