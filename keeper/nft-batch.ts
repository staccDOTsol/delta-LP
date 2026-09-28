import {keccak256, parseAbi, zeroAddress, type Address, type PublicClient} from 'viem';
import {nftDeployment, type NftDeployment} from '../strategy/nft-deployment.js';
import type {Call} from './model.js';

const adapterAbi = parseAbi(['function currentBatch() view returns (address)', 'function VAULT() view returns (address)']);
export const contributionBatchAbi = parseAbi([
  'function vault() view returns (address)', 'function adapter() view returns (address)',
  'function state() view returns (uint8)', 'function totalContributions() view returns (uint256)',
  'function queue()',
]);
type VaultState = {entriesOpen: boolean; phase: number; pendingAssets: bigint; minimumBatchAssets: bigint};
export type BatchObservation = {address: Address; vault: Address; adapter: Address; state: number; totalContributions: bigint};

/** No signing or transfers here. Execution uses the existing single-writer journal. */
export function contributionQueueCall(binding: NftDeployment, observation: BatchObservation, vault: Address, state: VaultState, now: number): Call | undefined {
  const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
  if (!same(binding.receipt, vault) || !same(observation.vault, vault) || !same(observation.adapter, binding.adapter))
    throw new Error('NFT contribution batch identity mismatch.');
  if (observation.address === zeroAddress || observation.state !== 0 || !state.entriesOpen || state.phase !== 0
    || observation.totalContributions === 0n || observation.totalContributions + state.pendingAssets < state.minimumBatchAssets) return;
  return {target: 'contribution', address: observation.address, name: 'queue', args: [], expiresAt: now + 4000,
    reason: 'Queue mint-funded USDG into the eligible pooled allocation; this does not issue receipts.'};
}

export async function observeContributionBatch(client: PublicClient, vault: Address, state: VaultState, blockNumber: bigint): Promise<Call | undefined> {
  const binding = nftDeployment;
  if (!binding || !state.entriesOpen || state.phase !== 0) return;
  const code = await client.getCode({address: binding.adapter, blockNumber});
  if (!code || keccak256(code) !== binding.adapterRuntimeCodeHash) throw new Error('NFT adapter runtime mismatch.');
  const [address, receipt] = await Promise.all([
    client.readContract({address: binding.adapter, abi: adapterAbi, functionName: 'currentBatch', blockNumber}),
    client.readContract({address: binding.adapter, abi: adapterAbi, functionName: 'VAULT', blockNumber}),
  ]);
  if (receipt.toLowerCase() !== vault.toLowerCase()) throw new Error('NFT adapter vault mismatch.');
  if (address === zeroAddress) return;
  const [batchVault, adapter, batchState, totalContributions] = await Promise.all([
    client.readContract({address, abi: contributionBatchAbi, functionName: 'vault', blockNumber}),
    client.readContract({address, abi: contributionBatchAbi, functionName: 'adapter', blockNumber}),
    client.readContract({address, abi: contributionBatchAbi, functionName: 'state', blockNumber}),
    client.readContract({address, abi: contributionBatchAbi, functionName: 'totalContributions', blockNumber}),
  ]);
  return contributionQueueCall(binding, {address, vault: batchVault, adapter, state: batchState, totalContributions}, vault, state, Date.now());
}
