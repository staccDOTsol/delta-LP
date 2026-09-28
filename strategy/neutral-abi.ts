import {parseAbi} from 'viem';

export const neutralAbi=parseAbi([
  'function controller() view returns(address)',
  'function asset() view returns(address)',
  'function configured() view returns(bool)',
  'function entriesOpen() view returns(bool)',
  'function tiers() view returns(uint8)',
  'function group() view returns(bytes32)',
  'function epoch() view returns(uint256)',
  'function phase() view returns(uint8)',
  'function pendingAssets() view returns(uint256)',
  'function minimumBatchAssets() view returns(uint256)',
  'function totalSupply() view returns(uint256)',
  'function portfolio() view returns(uint256 value,int256 delta,uint256 gross)',
  'function balanceOf(address) view returns(uint256)',
  'function deposits(address) view returns(uint256 assets,uint256 minimumShares,address receiver,bool listed)',
  'function allocation() view returns(address)',
  'function exitCount(address) view returns(uint256)',
  'function exitAt(address,uint256) view returns(address)',
  'function enter(uint256 assets,uint256 minimumShares,address receiver,uint64 deadline)',
  'function lowerMinimum(uint256 minimum)',
  'function refund(address account)',
  'function cancelAllocation()',
  'function recoverPending(bool asUSDG,uint256 minimumAssets,uint64 deadline) returns(address)',
  'function requestExit(uint256 shares,uint256 minimumAssets,address receiver,uint64 deadline) returns(address)',
  'function activate()',
]);
export const allocationAbi=parseAbi(['function settled() view returns(bool)']);
export const exitAbi=parseAbi([
  'function controller() view returns(address)','function vault() view returns(address)',
  'function owner() view returns(address)','function receiver() view returns(address)',
  'function ready() view returns(bool)','function completed() view returns(bool)',
  'function minimumAssets() view returns(uint256)',
  'function queuedMembers() view returns(uint256)','function memberCount() view returns(uint256)',
  'function deadline() view returns(uint64)','function queue(uint256 maximumMembers)','function extendDeadline(uint64 next)',
  'function finish()','function recoverInKind()','function lowerMinimum(uint256 minimum)',
]);
