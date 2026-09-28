import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createWalletClient, defineChain, http, encodeDeployData, formatEther, keccak256, getContractAddress } from 'viem';
import { addresses, client, rpc, loadSigner, preflight, stringify } from './preflight.mjs';

const path = new URL('../deployments/4663.json', import.meta.url);
if (existsSync(path)) throw new Error('Deployment record exists; inspect it before making another deployment.');
const artifact = JSON.parse(readFileSync(new URL('../out/DlpVault.sol/DlpVault.json', import.meta.url), 'utf8'));
const account = loadSigner();
const checks = await preflight();
if (Object.values(checks.code).some(present => !present)) throw new Error('A required dependency has no bytecode.');
const market = checks.markets[1];
if (market.state[4] === 0n || !market.oraclePrice) throw new Error('Market/oracle preflight failed.');
const params = { epsBps: 500, minHealthX100: 150, maxPriceDevBps: 100, maxSwapBps: 5000, maxMintBpsPerEpoch: 0, maxBurnBpsPerEpoch: 0, chainlinkMaxAge: 3600, twapWindow: 600 };
const args = ['deltaLP NVDA / USDG', 'dlpNVDA', addresses.pool, addresses.npm, addresses.morpho, market.params, addresses.feedBase, addresses.feedQuote, account.address, account.address, params];
const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
const [estimate, gasPrice, nonce] = await Promise.all([client.estimateGas({ account: account.address, data }), client.getGasPrice(), client.getTransactionCount({ address: account.address, blockTag: 'pending' })]);
const gas = estimate * 120n / 100n;
const gasPriceCap = gasPrice * 2n;
const maximumFee = gas * gasPriceCap;
if (maximumFee > 1000000000000000n) throw new Error('Deployment exceeds the 0.001 ETH gas budget.');
if (await client.getBalance({ address: account.address }) < maximumFee) throw new Error('Insufficient gas balance.');
const predicted = getContractAddress({ from: account.address, nonce: BigInt(nonce) });
const baseRecord = { chainId: 4663, rpc, explorer: 'https://robinhoodchain.blockscout.com', vault: predicted, authority: account.address, crank: account.address, depositsEnabled: false, name: args[0], symbol: args[1], dependencies: addresses, market: market.params, marketId: market.id, params, constructorArgs: args, creationCodeHash: keccak256(data), gasEstimate: estimate, gasLimit: gas, maxGasCostEth: formatEther(maximumFee), preflightBlock: checks.block };
console.log(stringify({ mode: process.argv.includes('--broadcast') ? 'broadcast' : 'simulation', ...baseRecord }));
if (!process.argv.includes('--broadcast')) process.exit(0);
const chain = defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
// Save the expected address before broadcasting, so interruption cannot silently deploy twice.
mkdirSync(new URL('../deployments/', import.meta.url), { recursive: true });
writeFileSync(path, stringify({ ...baseRecord, status: 'prepared', nonce }));
try {
  const hash = await wallet.sendTransaction({ data, gas, gasPrice: gasPriceCap, nonce });
  writeFileSync(path, stringify({ ...baseRecord, status: 'pending', nonce, transactionHash: hash }));
  console.log(`Deployment transaction: ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 120_000 });
  if (receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== predicted.toLowerCase()) throw new Error('Deployment receipt did not match the expected successful creation.');
  const read = functionName => client.readContract({ address: predicted, abi: artifact.abi, functionName });
  const [enabled, authority, crank, supply, code] = await Promise.all([read('depositsEnabled'), read('authority'), read('crank'), read('totalSupply'), client.getCode({ address: predicted })]);
  if (enabled !== false || authority !== account.address || crank !== account.address || supply !== 0n || !code) throw new Error('Post-deployment verification failed.');
  const record = { ...baseRecord, status: 'deployed-closed', nonce, transactionHash: hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, actualGasCostEth: formatEther(receipt.gasUsed * receipt.effectiveGasPrice), deployedCodeHash: keccak256(code), verifiedAt: new Date().toISOString() };
  writeFileSync(path, stringify(record));
  console.log(stringify({ status: record.status, vault: predicted, transactionHash: hash, gasCostEth: record.actualGasCostEth }));
} catch (error) {
  console.error(error.shortMessage ?? 'Deployment interrupted. Inspect the saved manifest and transaction before retrying.');
  process.exitCode = 1;
}
