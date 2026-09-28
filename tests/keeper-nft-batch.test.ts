import test from 'node:test';
import assert from 'node:assert/strict';
import {zeroAddress, type Address} from 'viem';
import {contributionQueueCall, type BatchObservation} from '../keeper/nft-batch.js';
import type {NftDeployment} from '../strategy/nft-deployment.js';
import {transactionFor} from '../keeper/execute.js';

const address = (id: number) => `0x${id.toString(16).padStart(40, '0')}` as Address;
const binding: NftDeployment = {adapter: address(1), receipt: address(2), adapterRuntimeCodeHash: `0x${'ab'.repeat(32)}`, collections: []};
const batch: BatchObservation = {address: address(3), adapter: binding.adapter, vault: binding.receipt, state: 0, totalContributions: 500_000_000n};
const vault = {entriesOpen: true, phase: 0, pendingAssets: 1_500_000_000n, minimumBatchAssets: 2_000_000_000n};

test('NFT proceeds join public deposits at the pooled threshold without existing receipts', () => {
  const call = contributionQueueCall(binding, batch, binding.receipt, vault, 1000)!;
  assert.equal(call.target, 'contribution'); assert.equal(call.address, batch.address);
  assert.equal(call.name, 'queue'); assert.equal(call.expiresAt, 5000);
  const tx = transactionFor(call); assert.equal(tx.to, batch.address); assert.equal(tx.data.length, 10);
});
test('underfunded, closed, allocating, empty or already queued contributions do not move', () => {
  for (const state of [{...vault, pendingAssets: vault.pendingAssets - 1n}, {...vault, entriesOpen: false}, {...vault, phase: 1}])
    assert.equal(contributionQueueCall(binding, batch, binding.receipt, state, 0), undefined);
  for (const observation of [{...batch, totalContributions: 0n}, {...batch, state: 1}, {...batch, state: 2}, {...batch, address: zeroAddress}])
    assert.equal(contributionQueueCall(binding, observation, binding.receipt, vault, 0), undefined);
});
test('NFT batch identity cannot substitute another vault or adapter', () => {
  for (const observation of [{...batch, vault: address(4)}, {...batch, adapter: address(5)}])
    assert.throws(() => contributionQueueCall(binding, observation, binding.receipt, vault, 0), /identity/);
  assert.throws(() => contributionQueueCall(binding, batch, address(4), vault, 0), /identity/);
});
test('keeper contribution writer permits only the argument-free queue operation', () => {
  const call = contributionQueueCall(binding, batch, binding.receipt, vault, 0)!;
  for (const patch of [{name: 'withdraw'}, {name: 'credit'}, {args: [address(6)]}, {address: undefined}])
    assert.throws(() => transactionFor({...call, ...patch}), /Unrecognized contribution/);
});
