import { z } from 'zod';

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export function requireThat(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
export const money = (cents: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(cents / 100);
export function multiply(a: number, b: number): number {
  const result = a * b;
  if (!Number.isSafeInteger(result)) throw new DomainError('AMOUNT_OVERFLOW', 'Amount exceeds safe accounting limits.', 400);
  return result;
}
export const householdInput = z.object({
  name: z.string().trim().min(2).max(100), email: z.string().trim().email().max(150),
  postalCode: z.string().trim().toUpperCase().regex(/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTVWXYZ] ?\d[ABCEGHJ-NPRSTVWXYZ]\d$/, 'Enter a Canadian postal code.'),
  annualLitres: z.number().int().min(300).max(15000),
  tankLitres: z.number().int().min(200).max(2500),
}).strict();
export const quoteInput = z.object({ householdId: z.string().uuid(), unitPriceCents: z.number().int().min(50).max(500), annualServiceCents: z.number().int().min(0).max(120000) }).strict();
export const orderInput = z.object({ subscriptionId: z.string().uuid(), litres: z.number().int().min(50).max(2500) }).strict();
export const paymentInput = z.object({ period: z.number().int().min(1).max(12) }).strict();
export function buildQuote(annualLitres: number, unitPriceCents: number, annualServiceCents: number) {
  const fuelCents = multiply(annualLitres, unitPriceCents);
  const totalCents = fuelCents + annualServiceCents;
  const monthlyCents = Math.floor(totalCents / 12);
  return { annualLitres, unitPriceCents, annualServiceCents, fuelCents, totalCents, monthlyCents, finalPaymentCents: totalCents - monthlyCents * 11, currency: 'CAD' as const, taxTreatment: 'Excluded; simulation only' };
}
export type QuoteTerms = ReturnType<typeof buildQuote>;
export const scenarioInput = z.object({
  households: z.number().int().min(1).max(10000).default(25),
  annualLitres: z.number().int().min(300).max(15000).default(2000),
  initialFillLitres: z.number().int().min(50).max(2500).default(600),
  unitPriceCents: z.number().int().min(10).max(1000).default(150),
  annualServiceCents: z.number().int().min(0).max(120000).default(24000),
  capitalCents: z.number().int().min(0).max(1_000_000_000).default(2500000),
  priceShockBps: z.number().int().min(-5000).max(20000).default(0),
  usageShockBps: z.number().int().min(-5000).max(10000).default(0),
  missedPaymentsBps: z.number().int().min(0).max(10000).default(0),
  supplierLockBps: z.number().int().min(0).max(10000).default(0),
  paymentFeeBps: z.number().int().min(0).max(1000).default(150),
  fundingAprBps: z.number().int().min(0).max(5000).default(1000),
  monthlyOperatingCents: z.number().int().min(0).max(100000).default(1000),
}).strict();
export type Scenario = z.infer<typeof scenarioInput>;
const weights = [1000, 1300, 1600, 1600, 1400, 1000, 600, 300, 200, 200, 300, 500];
const months = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
export function allocate(total: number, portions: number[]) {
  const sum = portions.reduce((a, b) => a + b, 0);
  const result = portions.map(w => Math.floor(total * w / sum));
  let remainder = total - result.reduce((a, b) => a + b, 0);
  const order = portions.map((w, i) => ({ i, remainder: total * w % sum })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (const { i } of order) { if (remainder-- <= 0) break; result[i]++; }
  return result;
}
export function simulate(raw: unknown) {
  const input = scenarioInput.parse(raw);
  const terms = buildQuote(input.annualLitres, input.unitPriceCents, input.annualServiceCents);
  const annualDemand = Math.round(input.annualLitres * (10000 + input.usageShockBps) / 10000);
  const demand = allocate(annualDemand, weights);
  const lockedLitres = Math.floor(input.annualLitres * input.supplierLockBps / 10000);
  let lockRemaining = lockedLitres;
  let inventory = 0, cash = input.capitalCents, minCash = cash;
  let receiptsTotal = 0, expensesTotal = 0, costsTotal = 0, principalGap = 0;
  const rows = months.map((month, i) => {
    // At month 0 fill once, then procure only when inventory cannot cover demand.
    const purchaseLitres = i === 0 ? Math.max(input.initialFillLitres, demand[i]) : Math.max(0, demand[i] - inventory);
    inventory += purchaseLitres - demand[i];
    const covered = Math.min(lockRemaining, purchaseLitres); lockRemaining -= covered;
    const shockedPrice = Math.round(input.unitPriceCents * (10000 + input.priceShockBps) / 10000);
    const fuelCents = (covered * input.unitPriceCents + (purchaseLitres - covered) * shockedPrice) * input.households;
    const scheduledCents = (i === 11 ? terms.finalPaymentCents : terms.monthlyCents) * input.households;
    const receiptsCents = Math.round(scheduledCents * (10000 - input.missedPaymentsBps) / 10000);
    const feesCents = Math.round(receiptsCents * input.paymentFeeBps / 10000);
    const operatingCents = input.monthlyOperatingCents * input.households;
    // Charge funding on negative opening cash. Required capital is reported separately; no funds are invented.
    const interestCents = Math.round(Math.max(0, -cash) * input.fundingAprBps / 120000);
    const expensesCents = feesCents + operatingCents + interestCents;
    cash += receiptsCents - fuelCents - expensesCents;
    minCash = Math.min(minCash, cash);
    receiptsTotal += receiptsCents; expensesTotal += expensesCents; costsTotal += fuelCents;
    principalGap = Math.max(principalGap, costsTotal + expensesTotal - receiptsTotal);
    return { month, demandLitres: demand[i] * input.households, purchaseLitres: purchaseLitres * input.households, inventoryLitres: inventory * input.households, receiptsCents, fuelCents, expensesCents, interestCents, cashCents: cash };
  });
  return { input, terms, rows, receiptsCents: receiptsTotal, procurementCents: costsTotal, expensesCents: expensesTotal,
    additionalCapitalCents: Math.max(0, -minCash), peakFundingCents: principalGap,
    endingCashCents: cash, endingInventoryLitres: inventory * input.households,
    cashSurplusCents: receiptsTotal - costsTotal - expensesTotal,
    funded: minCash >= 0,
    assumptions: ['Synthetic seasonal demand; not a historical backtest.', 'No investment yield or trading-fee income.', 'Taxes, credit recovery, delivery fees and supplier failure excluded.', 'Uncovered extra consumption is absorbed by the operator in this stress model.', 'Monthly cash model assumes customer receipts precede supplier payment; intramonth liquidity can be worse.', 'Supplier lock is hypothetical and limited to the contracted annual volume.'] };
}
export const vaultInput = z.object({ price: z.number().finite().min(0.01).max(1e6), referencePrice: z.number().finite().min(0.01).max(1e6), lower: z.number().finite().min(0.01).max(1e6), upper: z.number().finite().min(0.01).max(1e6), lpQuoteValue: z.number().finite().positive().max(1e9), collateral: z.number().finite().nonnegative().max(1e9), debtBase: z.number().finite().nonnegative().max(1e9), idleBase: z.number().finite().nonnegative().max(1e9).default(0), idleQuote: z.number().finite().nonnegative().max(1e9).default(0), liquidationThreshold: z.number().finite().min(0.01).max(1).default(0.625) }).strict().refine(x => x.lower < x.referencePrice && x.referencePrice < x.upper, 'Reference price must be inside the range.');
export function valueVault(raw: unknown) {
  const p = vaultInput.parse(raw);
  const a = Math.sqrt(p.lower), b = Math.sqrt(p.upper), initial = Math.sqrt(p.referencePrice);
  const liquidity = p.lpQuoteValue / ((1 / initial - 1 / b) * p.referencePrice + initial - a);
  const mark = Math.sqrt(Math.min(p.upper, Math.max(p.lower, p.price)));
  const base = liquidity * (1 / mark - 1 / b), quote = liquidity * (mark - a);
  const debtValue = p.debtBase * p.price, gross = base + p.idleBase;
  const deltaBase = gross - p.debtBase;
  const nav = gross * p.price + quote + p.idleQuote + p.collateral - debtValue;
  const health = debtValue > 0 ? p.collateral * p.liquidationThreshold / debtValue : null;
  return { base, quote, liquidity, deltaBase, deltaQuote: deltaBase * p.price, nav, health, inRange: p.price > p.lower && p.price < p.upper, solvent: nav > 0, depositAllowed: nav > 0 && (health === null || health >= 1.5) && Math.abs(deltaBase) <= Math.max(1e-8, Math.max(gross, p.debtBase) * 0.05), basis: 'Illustrative CLMM + borrow model. No fees, interest accrual or live oracle state.' };
}
