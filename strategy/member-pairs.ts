/** Integer accounting for a paired-token LP. Values are USDG micro-units; member
 * token balances/shares use the same units. Exposure comes from CONFIRMED positions,
 * not from the label on a 3x/5x/10x token. No network calls or trading side effects. */
export type MemberSnapshot={group:string;marketId:number;leverage:number;short:boolean;nav:bigint;supply:bigint;positionTicks:bigint;sizeDecimals:number;observedAt:number;settled:boolean};
const abs=(n:bigint)=>n<0n?-n:n;
function check(member:MemberSnapshot,now:number){
  if(!member.settled||now<member.observedAt||now-member.observedAt>60_000)throw new Error('Member state is pending or stale.');
  if(!Number.isInteger(member.leverage)||member.leverage<1||member.leverage>50||!Number.isInteger(member.sizeDecimals)||member.sizeDecimals<0||member.sizeDecimals>12||member.nav<0n||member.supply<=0n)throw new Error('Invalid member accounting.');
  if(member.short?member.positionTicks>0n:member.positionTicks<0n)throw new Error('Member position has the wrong direction.');
}
export function pairedExposure(long:MemberSnapshot,short:MemberSnapshot,longTokens:bigint,shortTokens:bigint,mark:bigint,now=Date.now()){
  check(long,now);check(short,now);
  if(long.short||!short.short||long.group!==short.group||long.marketId!==short.marketId||long.leverage!==short.leverage||long.sizeDecimals!==short.sizeDecimals)throw new Error('Pair must match underlying and leverage with opposite directions.');
  if(mark<=0n||longTokens<0n||shortTokens<0n||longTokens>long.supply||shortTokens>short.supply)throw new Error('Invalid pool inventory.');
  const scale=10n**BigInt(long.sizeDecimals);
  const longValue=long.nav*longTokens/long.supply,shortValue=short.nav*shortTokens/short.supply;
  const longExposure=long.positionTicks*mark*longTokens/(scale*long.supply);
  const shortExposure=short.positionTicks*mark*shortTokens/(scale*short.supply);
  const delta=longExposure+shortExposure,gross=abs(longExposure)+abs(shortExposure);
  return {longValue,shortValue,value:longValue+shortValue,longExposure,shortExposure,delta,gross,
    residualBps:gross?abs(delta)*10_000n/gross:null,
    longLeverageBps:long.nav?abs(long.positionTicks)*mark*10_000n/(scale*long.nav):null,
    shortLeverageBps:short.nav?abs(short.positionTicks)*mark*10_000n/(scale*short.nav):null};
}
export function allocateNeutral(gross:bigint,tiers:readonly number[]){
  if(!tiers.length||tiers.length>50||new Set(tiers).size!==tiers.length||tiers.some(n=>!Number.isInteger(n)||n<1||n>50)||gross<=0n)throw new Error('Invalid leverage family.');
  const perLeg=gross/(2n*BigInt(tiers.length));
  if(perLeg<1_000_000n)throw new Error('Not enough USDG to allocate every tier.');
  const fee=perLeg*200n/10_000n,net=perLeg-fee;
  const legs=tiers.flatMap(leverage=>(['long','short'] as const).map(side=>({leverage,side,gross:perLeg,fee,backing:net})));
  return {legs,allocated:perLeg*BigInt(legs.length),remainder:gross-perLeg*BigInt(legs.length)};
}
export function redemption(shares:bigint,supply:bigint,nav:bigint){
  if(shares<=0n||shares>supply||nav<0n)throw new Error('Invalid redemption.');
  const gross=shares*nav/supply,fee=gross*400n/10_000n;
  return {gross,fee,proceeds:gross-fee};
}

/** One price move BEFORE leverage resets, funding or costs. Equal starting USD
 * backing on each side; a full-range constant-product AMM reprices to those NAVs.
 * This is an illustration of amplification and inventory loss, not an APY model
 * or a simulation of a concentrated V4 position. Both member NAVs must stay positive. */
export function pairedLeverageIllustration(leverage:number,underlyingMovePct:number){
  if(!Number.isInteger(leverage)||leverage<1||leverage>50||!Number.isFinite(underlyingMovePct))throw new Error('Invalid leverage illustration.');
  const legReturn=leverage*underlyingMovePct/100;
  if(Math.abs(legReturn)>=1)throw new Error('Illustration requires positive backing on both legs.');
  const relativePrice=(1+legReturn)/(1-legReturn);
  return {relativePriceChangePct:(relativePrice-1)*100,
    localRelativeVarianceMultiplier:4*leverage*leverage,
    feeFreePoolLossPct:(1-Math.sqrt(1-legReturn*legReturn))*100};
}
