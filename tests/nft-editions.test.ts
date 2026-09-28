import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NFT_DENOMINATIONS, NFT_TOTAL_SUPPLY, nftMintAllocation, nftEditionQuote} from '../strategy/nft-editions.js';

test('four denominations total 40,000 NFTs and $180,000 target gross', () => {
  assert.deepEqual(NFT_DENOMINATIONS, [1, 2, 5, 10]);
  assert.equal(NFT_TOTAL_SUPPLY, 40_000);
  assert.equal(NFT_DENOMINATIONS.reduce((sum, value) => sum + value * 10_000, 0), 180_000);
  for (const excluded of [20, 50, 100]) {
    assert.throws(() => nftEditionQuote(excluded as 1, 2500_000000n, 1000, 1000), /Unsupported edition/);
  }
});

test('updated mint split is 10% OpenSea, 1% Wizards, 89% routed into DN', () => {
  const p = nftMintAllocation(10n ** 18n, 1);
  assert.equal(p.openSea, 10n ** 17n);
  assert.equal(p.wizardsMint, 10n ** 16n);
  assert.equal(p.dnRoute, 89n * 10n ** 16n);
  assert.equal(p.accounts[0].backingBeforeSwapCosts, 8633n * 10n ** 14n);
  assert.equal(p.wizardsMint + p.accounts[0].entryFeeEstimate / 2n, 2335n * 10n ** 13n);
});

test('all prices and batches conserve funds with at most one wei difference between NFTs', () => {
  for (const price of [100n, 101n, 997n, 100000001n, (1n << 80n) - 1n]) {
    for (let count = 1; count <= 20; count++) {
      const p = nftMintAllocation(price, count);
      assert.equal(p.openSea + p.wizardsMint + p.dnRoute, p.gross);
      assert.equal(p.accounts.reduce((sum, a) => sum + a.routed, 0n), p.dnRoute);
      assert.ok(p.accounts[0].routed - p.accounts.at(-1)!.routed <= 1n);
    }
  }
});

test('USD denominations quote bounded native prices from a fresh ETH/USD observation', () => {
  const now = 1_000_000;
  assert.equal(nftEditionQuote(1, 2500_000000n, now, now).mintPriceWei, 400_000_000_000_000n);
  for (const denomination of NFT_DENOMINATIONS) {
    const price = 2657_840000n;
    const q = nftEditionQuote(denomination, price, now - 1000, now);
    const target = BigInt(denomination) * 1_000_000n * 10n ** 18n;
    assert.ok(q.mintPriceWei * price >= target);
    assert.ok((q.mintPriceWei - 1n) * price < target);
  }
  assert.throws(() => nftEditionQuote(1, 1n, 0, now), /stale/);
  assert.throws(() => nftEditionQuote(1, 1n, now + 1, now), /stale/);
  assert.throws(() => nftEditionQuote(1, 0n, now, now), /positive/);
  assert.throws(() => nftMintAllocation(100n, 21), /quantity/);
  assert.throws(() => nftMintAllocation(99n, 1), /price/);
});
