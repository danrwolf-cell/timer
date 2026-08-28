// Zod schema for the extraction model's output. Hand-mirrors
// ExtractedRouteSheet in ../../src/import/route-scan.ts — keep the two in
// sync; this one exists only because zodOutputFormat() needs a real Zod
// schema, and the client-side type has no reason to carry a zod dependency.
// zodOutputFormat() (@anthropic-ai/sdk/helpers/zod) is typed against the
// 'zod/v4' namespace specifically — importing plain 'zod' here would build
// a schema whose internals don't structurally match what it expects.
import { z } from 'zod/v4';

export const CheckTypeSchema = z
  .enum(['known', 'secret', 'emergency', 'gas', 'start', 'finish'])
  .nullable();

export const ExtractedSegmentSchema = z.object({
  distanceMi: z.number().positive(),
  speedMph: z.number().positive().nullable(),
  isFree: z.boolean(),
  isReset: z.boolean(),
  label: z.string().nullable(),
  checkType: CheckTypeSchema,
});

export const ExtractedFreeZoneSchema = z.object({
  startMi: z.number().nonnegative(),
  endMi: z.number().nonnegative(),
  reason: z.string().nullable(),
});

export const ExtractedCheckpointSchema = z.object({
  label: z.string(),
  afterMile: z.number().nonnegative(),
  clockTime: z.string(),
});

export const ExtractedRouteSheetSchema = z.object({
  routeName: z.string(),
  eventDate: z.string().nullable(),
  startClockTime: z.string(),
  segments: z.array(ExtractedSegmentSchema).min(1),
  freeZones: z.array(ExtractedFreeZoneSchema),
  checkpoints: z.array(ExtractedCheckpointSchema).min(1),
});

export type ExtractedRouteSheetParsed = z.infer<typeof ExtractedRouteSheetSchema>;
