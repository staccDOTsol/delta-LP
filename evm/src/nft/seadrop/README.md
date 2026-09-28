# SeaDrop ABI sources

Vendored from ProjectOpenSea/seadrop, commit `757590f11babfd81f4608f736e79e388469377f2` (MIT; see LICENSE).

Only the Solidity pragma, import paths and trailing whitespace are adapted for this repository's Solidity 0.8.28 / OpenZeppelin installation. These are ABI definitions, not a replacement deployment of SeaDrop. Keeping the complete interfaces avoids falsely claiming an ERC-165 interface for only a partial ABI.

Original files: `src/interfaces/INonFungibleSeaDropToken.sol`, `src/interfaces/ISeaDropTokenContractMetadata.sol`, `src/lib/SeaDropStructs.sol`.
