import { z } from 'zod';

export const preferenceSchema = z.discriminatedUnion('product', [
  z.object({
    product: z.literal('oil-subscription'),
    fuel: z.enum(['heating-oil', 'propane', 'natural-gas']),
    region: z.string().trim().max(80),
  }).strict(),
  z.object({
    product: z.literal('strategy'),
    direction: z.enum(['neutral', 'long', 'short']),
    leverage: z.union([z.literal(3), z.literal(5), z.literal(10)]),
  }).strict(),
]);

export type Preference = z.infer<typeof preferenceSchema>;
