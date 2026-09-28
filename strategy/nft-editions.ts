/** SeaDrop prices are fixed wei per stage, not permanently fixed dollar prices. */
export const NFT_DENOMINATIONS = [1, 2, 5, 10] as const;
export type NftDenomination = typeof NFT_DENOMINATIONS[number];
export const NFT_EDITION_SIZE = 10_000;
export const NFT_TOTAL_SUPPLY = NFT_EDITION_SIZE * NFT_DENOMINATIONS.length;
export const NFT_MAX_BATCH = 20;

const BPS = 10_000n;
const WEI = 10n ** 18n;
const MAX_UINT80 = (1n << 80n) - 1n;

/** Match on-chain SeaDrop rounding, then split the creator payout per NFT. */
export function nftMintAllocation(mintPriceWei: bigint, quantity: number) {
  if (mintPriceWei < 100n || mintPriceWei > MAX_UINT80) throw new Error('Invalid SeaDrop price');
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > NFT_MAX_BATCH) throw new Error('Invalid mint quantity');
  const count = BigInt(quantity);
  const gross = mintPriceWei * count;
  const openSea = gross * 1_000n / BPS;
  const wizardsMint = gross * 100n / BPS;
  const dnRoute = gross - openSea - wizardsMint;
  const accounts = Array.from({length: quantity}, (_, i) => {
    const routed = dnRoute / count + (BigInt(i) < dnRoute % count ? 1n : 0n);
    // Estimate in native units only. Production entry fees are assessed by the
    // DN route after ETH conversion, whose price, units and rounding can differ.
    const entryFeeEstimate = routed * 300n / BPS;
    return {routed, entryFeeEstimate, backingBeforeSwapCosts: routed - entryFeeEstimate};
  });
  return {gross, openSea, wizardsMint, dnRoute, accounts};
}

export function nftEditionQuote(denomination: NftDenomination, ethUsdE6: bigint, observedAt: number, now: number) {
  if (!NFT_DENOMINATIONS.includes(denomination)) throw new Error('Unsupported edition');
  if (ethUsdE6 <= 0n) throw new Error('ETH quote must be positive');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(observedAt) || observedAt > now || now - observedAt > 300_000)
    throw new Error('ETH quote is stale or invalid');
  const numerator = BigInt(denomination) * 1_000_000n * WEI;
  const mintPriceWei = (numerator + ethUsdE6 - 1n) / ethUsdE6;
  return {denomination, mintPriceWei, observedAt, allocation: nftMintAllocation(mintPriceWei, 1)};
}
