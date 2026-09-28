import {keccak256, parseAbi, toHex, type Hex} from 'viem';
import {z} from 'zod';
import {accountSchema, assertNoOrders, assertTradingAccount, exactUnits} from './execution.js';
import {memberMarketSchema, memberReport, type MemberSnapshot, type Observation} from './member-reconciliation.js';

export const MEMBER_KEY_SLOT=42;
export const memberSetupAbi=parseAbi([
  'function configureVenueKey(uint256 id, bytes publicKey, uint16 marginBps)',
  'function abandonVenueMargin(uint256 id)',
  'function venueSetup(uint256 id) view returns (bytes32 publicKeyHash, uint16 initialMarginBps, uint64 generation, bool pending)',
]);
export type SetupIdentity={controller:string;custody:string;owner:string;member:bigint;accountIndex:number;generation:bigint};
export type SetupState={publicKeyHash:Hex;initialMarginBps:number;generation:bigint;pending:boolean};

export function venuePublicKey(input:string):Hex {
  const raw=input.replace(/^0x/i,'').toLowerCase();
  if(!/^[a-f0-9]{80}$/.test(raw))throw new Error('Invalid venue public key.');
  const bytes=Uint8Array.from(raw.match(/../g)!,b=>parseInt(b,16));
  if(bytes.every(b=>b===0))throw new Error('A zero key cannot revoke venue access.');
  for(let i=0;i<5;i++){
    let word=0n;for(let j=7;j>=0;j--)word=(word<<8n)+BigInt(bytes[i*8+j]);
    if(word>=0xffffffff00000001n)throw new Error('Noncanonical venue public key.');
  }
  return `0x${raw}`;
}

export function registeredMemberKey(raw:unknown,accountIndex:number):Hex|null {
  const rows=z.object({code:z.literal(200),api_keys:z.array(z.object({account_index:z.number().int(),api_key_index:z.number().int(),public_key:z.string()}))}).parse(raw).api_keys;
  if(rows.some(r=>r.account_index!==accountIndex))throw new Error('Venue key account mismatch.');
  if(new Set(rows.map(r=>r.api_key_index)).size!==rows.length)throw new Error('Duplicate venue key slot.');
  // An unrecognized live key can still operate the account after slot 42 rotates.
  if(rows.some(r=>r.api_key_index!==MEMBER_KEY_SLOT&&!/^(?:0x)?0{80}$/i.test(r.public_key)))throw new Error('Unexpected venue operator key. Review the account keys.');
  const key=rows.find(r=>r.api_key_index===MEMBER_KEY_SLOT)?.public_key;
  if(!key||/^(?:0x)?0{80}$/i.test(key))return null;
  return venuePublicKey(key);
}

export function setupKeyMessage(identity:SetupIdentity,origin:string){
  if(!/^https?:\/\//.test(origin)||identity.member<1n||identity.generation<1n||!Number.isSafeInteger(identity.accountIndex)||identity.accountIndex<=2)throw new Error('Invalid setup identity.');
  for(const address of [identity.controller,identity.custody,identity.owner])if(!/^0x[0-9a-f]{40}$/i.test(address))throw new Error('Invalid setup address.');
  return ['deltaLP contract-owned Lighter operator key',`Origin: ${origin}`, 'EVM chain: 4663','Lighter signing domain: 466324',
    `Controller: ${identity.controller.toLowerCase()}`,`Custody: ${identity.custody.toLowerCase()}`,`Owner: ${identity.owner.toLowerCase()}`,
    `Member: ${identity.member}`,`Account: ${identity.accountIndex}`,`Generation: ${identity.generation}`,`API key: ${MEMBER_KEY_SLOT}`,
    'This signature derives a privileged venue key. It is not a trade-only key. Never share this signature.','Version: 1'].join('\n');
}

/** Cross margin uses the series' dedicated account. No orders, deposits or transfers. */
export function memberMarginPlan(member:Pick<MemberSnapshot,'custody'|'accountIndex'|'market'>,setup:SetupState,rawAccount:unknown,rawMarket:unknown,rawKeys:unknown){
  if(!setup.pending||setup.initialMarginBps===0)throw new Error('No pending margin configuration.');
  const account=accountSchema.parse(rawAccount),market=memberMarketSchema.parse(rawMarket);
  if(account.index!==member.accountIndex||account.l1_address.toLowerCase()!==member.custody.toLowerCase()||market.market_id!==member.market)throw new Error('Setup identity mismatch.');
  assertTradingAccount(account);assertNoOrders(account);
  // Changing margin while a position is live needs a separate collateral review.
  if(account.positions.some(p=>exactUnits(p.position,18)!==0n))throw new Error('Close existing positions before changing member margin.');
  const key=registeredMemberKey(rawKeys,member.accountIndex);
  if(!key||keccak256(key)!==setup.publicKeyHash)throw new Error('Requested venue key is not registered.');
  if(market.status!=='active'||market.market_config.force_reduce_only)throw new Error('Market does not accept margin setup.');
  if(setup.initialMarginBps<market.min_initial_margin_fraction||setup.initialMarginBps>10000)throw new Error('Unsupported initial margin setting.');
  return {accountIndex:member.accountIndex,marketId:member.market,initialMarginBps:setup.initialMarginBps,marginMode:0 as const,transactionType:20 as const};
}

/** Unsigned reporter candidate: include key registry evidence in the report hash. */
export function memberSetupReport(member:MemberSnapshot,setup:SetupState,rawAccount:unknown,rawMarket:unknown,rawKeys:unknown,observation:Observation){
  if(!setup.pending)throw new Error('Setup is not pending.');
  const key=registeredMemberKey(rawKeys,member.accountIndex);
  if(!key||keccak256(key)!==setup.publicKeyHash)throw new Error('Requested venue key is not registered.');
  const account=accountSchema.parse(rawAccount);
  const report=memberReport(member,rawAccount,rawMarket,observation);
  const row=account.positions.find(p=>p.market_id===member.market);
  // A missing position row falls back to default margin in ordinary reports, but
  // cannot prove a requested configuration was installed, even if numbers match.
  if(setup.initialMarginBps!==0&&(!row||row.margin_mode!==0||report.initialMarginBps!==setup.initialMarginBps))throw new Error('Cross-margin configuration is not confirmed.');
  const evidenceHash=keccak256(toHex(JSON.stringify({report,setup,rawKeys},(_,v)=>typeof v==='bigint'?v.toString():v)));
  return {report:{...report,evidenceHash},observedKeyHash:keccak256(key)};
}
