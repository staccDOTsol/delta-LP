import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createPublicClient, http, parseAbi, formatEther, getAddress, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const rpc = 'https://rpc.mainnet.chain.robinhood.com';
export const addresses = {
  base: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  quote: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  pool: '0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3',
  npm: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
  morpho: '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010',
  irm: '0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1',
  feedBase: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15',
  feedQuote: '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2',
};
export const client = createPublicClient({ transport: http(rpc, { timeout: 20_000 }) });
export function loadSigner() {
  const raw = readFileSync(process.env.DELTA_KEY_FILE ?? `${homedir()}/staccoverflow.eth`, 'utf8').trim();
  if (!/^(0x)?[a-fA-F0-9]{64}$/.test(raw)) throw new Error('Key file has an unsupported format.');
  return privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`);
}
export const stringify = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export async function preflight() {
  const signer = loadSigner();
  const [chainId, block, balance] = await Promise.all([client.getChainId(), client.getBlock(), client.getBalance({ address: signer.address })]);
  if (chainId !== 4663) throw new Error('Unexpected chain ID.');
  const code = Object.fromEntries(await Promise.all(Object.entries(addresses).map(async ([label, address]) => [label, (await client.getCode({ address }))?.length > 2])));
  const read = (address, signature, functionName, args = []) => client.readContract({ address, abi: parseAbi([signature]), functionName, args });
  const balances = await Promise.all(['base', 'quote'].map(async key => [key, await read(addresses[key], 'function balanceOf(address) view returns (uint256)', 'balanceOf', [signer.address])]));
  const markets = await Promise.all(['0x548196c5a7d2127ae69fbc69e2fed9686fdd7a10','0x2e72230da46b888bb71d419d4e194577e43bf881'].map(async oracle => {
    const params = { loanToken: addresses.base, collateralToken: addresses.quote, oracle: getAddress(oracle), irm: addresses.irm, lltv: 625000000000000000n };
    const id = keccak256(encodeAbiParameters(parseAbiParameters('address, address, address, address, uint256'), Object.values(params)));
    const state = await read(addresses.morpho, 'function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)', 'market', [id]);
    let price = null;
    try { price = await read(params.oracle, 'function price() view returns (uint256)', 'price'); } catch {}
    return { id, params, state, available: state[0] - state[2], oraclePrice: price };
  }));
  const pool = await read(addresses.pool, 'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'slot0');
  const observations = await read(addresses.pool, 'function observe(uint32[]) view returns (int56[],uint160[])', 'observe', [[600,0]]);
  const feeds = await Promise.all(['feedBase','feedQuote'].map(async key => ({ name: key, data: await read(addresses[key], 'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)', 'latestRoundData') })));
  return { checkedAt: new Date().toISOString(), chainId, block: block.number, blockTimestamp: block.timestamp, signer: signer.address, gasBalanceEth: formatEther(balance), code, balances: Object.fromEntries(balances), markets, pool, observations, feeds };
}
if (process.argv[1]?.endsWith('/preflight.mjs')) {
  try { console.log(stringify(await preflight())); }
  catch (e) { console.error(e.shortMessage ?? e.message); process.exitCode = 1; }
}
