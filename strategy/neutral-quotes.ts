import {parseUnits} from 'viem';

export function usdgAmount(text:string){
  if(!/^\d{1,12}(\.\d{1,6})?$/.test(text))throw new Error('Enter a USDG amount with at most six decimal places.');
  const amount=parseUnits(text,6);
  if(amount<10000n)throw new Error('The minimum pending deposit is 0.01 USDG.');
  return amount;
}
export function receiptMinimum(assets:bigint,supply:bigint,nav:bigint|null){
  if(assets<=0n||supply<0n)throw new Error('Invalid quote.');
  const minimumBacking=assets*9700n/10000n; // 2% entry, up to 1% execution movement
  if(supply===0n)return minimumBacking*10n**12n;
  if(nav===null||nav<=0n)throw new Error('A current basket valuation is required. Refresh before depositing.');
  const shares=minimumBacking*supply/nav;
  if(shares===0n)throw new Error('Amount is too small for a receipt.');
  return shares;
}
export function exitMinimum(shares:bigint,supply:bigint,nav:bigint|null){
  if(shares<=0n||shares>supply||nav===null||nav<=0n)throw new Error('A current exit valuation is required.');
  // 4% redemption fee and 1% further movement tolerance; user may later lower it.
  return shares*nav/supply*9500n/10000n;
}
