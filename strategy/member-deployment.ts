const deployment = {
  "chainId": 4663,
  "version": "v6",
  "registryFile": "4663-neutral-v6-registry.json",
  "genesisBlock": "74715624",
  "feePolicy": {
    "entryFeeBps": 300,
    "exitFeeBps": 600,
    "wizardsBps": 5000,
    "nftsBps": 5000
  },
  "status": "prototype",
  "contracts": {
    "MemberController": {
      "address": "0xA79017035c9Fe045c797581321b6F36f554c55b2",
      "runtimeCodeHash": "0xc778c528846e672b7b1f150ba3655991e2a083685b78d2e01db91133e9182157",
      "transactionHash": "0x19e44d94490a9438be329509928f29cf29a828a8a8f8f4033be1b8ed7dcf9cc4"
    },
    "HouseFeeRouter": {
      "address": "0x28E833384b720Ad0A428935cAe8d5b49fa62A1c0",
      "runtimeCodeHash": "0x15a2927574bf2f190a4a69c1f427327e3c6eec5009e971d0343610961e4c6e8f",
      "transactionHash": "0xefc04a4372f174a6df374bb7a16d5ab1ca119bb21d01a529705f2f23aed2610b"
    },
    "WeightedNftFeeFanout": {
      "address": "0x0D06A5981107629Fadf2e8104c9979afF78E9Dc6",
      "runtimeCodeHash": "0x32033799123487bd165178898a45ce0380ae907cda19a2a44c6047f67d26faa9",
      "transactionHash": "0xc443c523697ef60f98c8106aa6231b11c79fe5217aec048102250453b8d63021"
    },
    "MemberV4Hook": {
      "address": "0xcA196659d69DA75F7ccDEBe5A913be1ae5D8e540",
      "runtimeCodeHash": "0x645f35e1124b2c053b0fc128d3fc4c3359fb3d97c143e439a5b8cdd09387e244",
      "transactionHash": "0x449dbd8a7cc8c2820b6a05412d0962430dd12100f3a1d5023d111be830f76045"
    },
    "NeutralEscrowFactory": {
      "address": "0x6Cd0FCA62Cd246dce867424214cd1EbDcb851EB6",
      "runtimeCodeHash": "0xa836b4292e6d8c07cdc6b8d94962fff2b038d263db1ff24b15ba9382f8d97284",
      "transactionHash": "0x234dffa5c364dd749311393ea608ac8b0e5c2d8b38e16407859fc0321ad02fa1"
    },
    "NeutralVault": {
      "address": "0x19Bc982b4387c21e0D146b365e033dF5F14f6C85",
      "runtimeCodeHash": "0x032ba58f74a83fab080a73dd973a8fb0ae74c046b99d34ab3379585c26b0d91f",
      "transactionHash": "0xb3d731ec02b6239c85d4d6388e38e3eb3088f371870eee10e0126d573c89ea08"
    },
    "MemberFactory": {
      "address": "0x7cC2c4F5E3626D136D4Caa1476996F20E45E186b",
      "runtimeCodeHash": "0xc9a5f6e041ac12db45c69f7093277f0e6057a2c17c5d3fee00d744644b07b9f4"
    }
  },
  "fanout": "0x28E833384b720Ad0A428935cAe8d5b49fa62A1c0"
} as const;
export default deployment;
