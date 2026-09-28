import {parseUnits} from 'viem';

export function usdgAmount(text:string){
  if(!/^\d{1,12}(\.\d{1,6})?$/.test(text))throw new Error('Enter a USDG amount with at most six decimal places.');
  const amount=parseUnits(text,6);
  if(amount<10000n)throw new Error('The minimum pending deposit is 0.01 USDG.');
  return amount;
}
function fee(value:number){
  if(!Number.isSafeInteger(value)||value<0||value>=9900)throw new Error('Invalid fee quote.');
  return BigInt(value);
}
export function receiptMinimum(assets:bigint,supply:bigint,nav:bigint|null,entryFeeBps=200){
  if(assets<=0n||supply<0n)throw new Error('Invalid quote.');
  const minimumBacking=assets*(9900n-fee(entryFeeBps))/10000n; // chain fee plus 1% execution movement
  if(supply===0n)return minimumBacking*10n**12n;
  if(nav===null||nav<=0n)throw new Error('A current basket valuation is required. Refresh before depositing.');
  const shares=minimumBacking*supply/nav;
  if(shares===0n)throw new Error('Amount is too small for a receipt.');
  return shares;
}
export function exitMinimum(shares:bigint,supply:bigint,nav:bigint|null,exitFeeBps=400){
  if(shares<=0n||shares>supply||nav===null||nav<=0n)throw new Error('A current exit valuation is required.');
  // Chain redemption fee and 1% further movement tolerance.
  return shares*nav/supply*(9900n-fee(exitFeeBps))/10000n;
}
