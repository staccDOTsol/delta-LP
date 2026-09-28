// Operator input is separate from strict venue/API decimals. Never use floating
// point or round monetary input, including scientific notation.
export const UNLIMITED_MEMBER_ASSETS=(1n<<256n)-1n;

export function parseOperatorAmount(input:string,decimals:number,allowUnlimited=false):bigint{
  if(!Number.isInteger(decimals)||decimals<0||decimals>18)throw new Error('Unsupported amount precision.');
  const value=input.trim();
  if(/^(unlimited|inf|infinity|∞)$/i.test(value)){
    if(allowUnlimited)return UNLIMITED_MEMBER_ASSETS;
    throw new Error('Enter a finite amount; unlimited applies only to the per-member equity cap.');
  }
  if(value.length>256)throw new Error('Amount is too large.');
  const match=value.match(/^\+?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:e([+-]?\d{1,4}))?$/i);
  if(!match)throw new Error(`Enter a positive number such as 1000000, 1,000,000 or 1e6${allowUnlimited?', or unlimited':''}.`);
  const [whole,fraction='']=match[1].replaceAll(',','').split('.');
  const digits=((whole||'0')+fraction).replace(/^0+/,'');
  if(!digits)throw new Error('Amount must be greater than zero.');
  const shift=decimals+Number(match[2]??0)-fraction.length;
  let amount=BigInt(digits);
  if(shift<0){
    if(-shift>=digits.length)throw new Error(`Amount must be exact to ${decimals} decimal places; it will not be rounded.`);
    const scale=10n**BigInt(-shift);
    if(amount%scale!==0n)throw new Error(`Amount must be exact to ${decimals} decimal places; it will not be rounded.`);
    amount/=scale;
  }else{
    if(digits.length+shift>78)throw new Error(`Amount exceeds the uint256 range${allowUnlimited?'; use unlimited for the equity cap':''}.`);
    amount*=10n**BigInt(shift);
  }
  if(amount>UNLIMITED_MEMBER_ASSETS)throw new Error(`Amount exceeds the uint256 range${allowUnlimited?'; use unlimited for the equity cap':''}.`);
  return amount;
}
