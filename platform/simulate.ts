import { simulate } from './domain.ts';
const cases = [ ['Base case', {}], ['Fuel doubles', { priceShockBps: 10000 }], ['Colder winter', { usageShockBps: 3000 }], ['Missed collections', { missedPaymentsBps: 2000 }], ['Combined shock', { priceShockBps: 10000, usageShockBps: 3000, missedPaymentsBps: 2000 }], ['Supplier price lock', { priceShockBps: 10000, supplierLockBps: 10000 }] ] as const;
console.log(JSON.stringify(cases.map(([name, settings]) => ({ name, ...simulate(settings) })), null, 2));
