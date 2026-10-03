import { z } from 'zod';

export const zItinerarySlot = z.object({
  name: z.string().default(''),
  categoryLabel: z.string().default(''),
  slot: z.string().default(''),
  priceCNY: z.number().nonnegative().default(0),
  source: z.string().optional(),
});

export const zItineraryCardDay = z.object({
  day: z.number().int().positive().default(1),
  theme: z.string().default(''),
  items: z.array(zItinerarySlot).default([]),
  stayName: z.string().optional(),
  stayPriceCNY: z.number().nonnegative().default(0),
  costCNY: z.number().nonnegative().default(0),
});

export const zItineraryCardProps = z.object({
  title: z.string().optional(),
  city: z.string().optional(),
  days: z.array(zItineraryCardDay).default([]),
  totalCostCNY: z.number().nonnegative().default(0),
  /** null = 用户没在目标里给预算，此时不展示预算行。 */
  budgetCNY: z.number().nonnegative().nullable().default(null),
  overBudget: z.boolean().default(false),
  sourceRefs: z.array(z.object({ label: z.string().default(''), uri: z.string().optional() })).default([]),
  disclaimer: z.string().optional(),
  isEstimate: z.boolean().default(false),
  note: z.string().optional(),
});

export type ItineraryCardProps = z.infer<typeof zItineraryCardProps>;
