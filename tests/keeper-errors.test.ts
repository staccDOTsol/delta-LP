import test from 'node:test';
import assert from 'node:assert/strict';
import {errorSummary,retryableTransport} from '../keeper/errors.js';

test('only recognized transport failures retry; nonce, expiry, revert and auth failures stop',()=>{
  for(const error of [{name:'TimeoutError'},{name:'HttpRequestError',status:429},{name:'HttpRequestError',status:503},{name:'LimitExceededRpcError'},
    {name:'TransactionExecutionError',cause:{name:'HttpRequestError',cause:{code:'ECONNRESET'}}}])assert.equal(retryableTransport(error),true);
  for(const error of [new Error('Signer nonce changed'),new Error('Unresolved transaction expired'),{name:'ContractFunctionRevertedError'},
    {name:'HttpRequestError',status:401},{name:'HttpRequestError',status:403},{name:'RpcRequestError',code:-32602},null])assert.equal(retryableTransport(error),false);
  const cycle:{cause?:unknown}={};cycle.cause=cycle;assert.equal(retryableTransport(cycle),false);
});
test('keeper diagnostics omit credential URLs and verbose request bodies',()=>{
  assert.equal(errorSummary(new Error('Failed https://example.com/secret-key\nBody: hidden')),'Failed [endpoint redacted]');
  assert.equal(errorSummary({shortMessage:'RPC unavailable.',message:'Full https://example.com/secret'}),'RPC unavailable.');
  assert.equal(errorSummary(undefined),'Keeper operation failed.');
});
