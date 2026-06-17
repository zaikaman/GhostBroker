import { z } from "zod";

const jsonValueSchema: z.ZodType<
  string | number | boolean | null | Record<string, unknown> | unknown[]
> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const negotiationMandateSchema = z.object({
  assetCode: z.string().trim().min(1).max(32),
  side: z.enum(["buy", "sell"]),
  targetQuantity: z.number().positive(),
  referencePrice: z.number().positive(),
  priceBandBps: z.number().int().nonnegative().max(100000),
  deadline: z.string().datetime(),
  urgency: z.enum(["low", "normal", "high", "critical"]),
  maxNotional: z.string().regex(/^\d+(?:\.\d+)?$/u),
  disclosableClaims: z.array(z.string().trim().min(1).max(64)).max(32),
  requiredCounterpartyClaims: z.record(z.string(), jsonValueSchema),
  counterpartyConstraints: z.record(z.string(), jsonValueSchema),
  operatorPrompt: z.string().trim().min(1).max(4000),
});

const createNegotiationMandateRequestSchema = z.object({
  mandate: negotiationMandateSchema,
});

const frontendPayload = {
  mandate: {
    assetCode: "WBTC",
    side: "buy",
    targetQuantity: 1,
    referencePrice: 70000,
    priceBandBps: 150,
    deadline: new Date().toISOString(),
    urgency: "normal",
    maxNotional: "70000",
    disclosableClaims: [],
    requiredCounterpartyClaims: {},
    counterpartyConstraints: {},
    operatorPrompt: "test",
  },
};

const result = createNegotiationMandateRequestSchema.safeParse(frontendPayload);
if (!result.success) {
  console.log("FAIL");
  console.log(JSON.stringify(result.error.issues, null, 2));
} else {
  console.log("PASS");
}
