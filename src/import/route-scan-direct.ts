// Calls Anthropic directly from the phone — no backend. The rider supplies
// their own API key via Settings (stored in the device Keychain/Keystore,
// see api-key-store.ts); it's never bundled with the app.
//
// This is plain fetch against the Messages API, NOT the @anthropic-ai/sdk
// client: the SDK's credential-resolution path imports `node:fs` (reading
// ~/.config/anthropic profiles), which Metro can't bundle for React Native
// — confirmed by a real `expo export` failure, not a guess. zod itself has
// no such dependency and bundles fine, so the schema/parsing logic below
// mirrors exactly what the SDK's own parser.mjs does internally (send
// output_config.format as JSON Schema, then JSON.parse + zod-validate the
// response's text block) — just without the client wrapper. See
// server/README.md for the SDK-based equivalent, which runs fine in
// server/'s plain Node environment.
//
// Same extraction + check pipeline as server/src/index.ts either way: the
// model transcribes, checkKeyTimes() is the judge.

import { z } from 'zod/v4';
import { ExtractedRouteSheetSchema } from './route-scan-schema';
import { EXTRACTION_PROMPT } from './route-scan-prompt';
import { toRouteSheetData, type ExtractedRouteSheet } from './route-scan';
import { checkKeyTimes, type RouteSheetData, type CheckpointResult } from './route-sheet';
import { type ExtractResponse, type ScanMimeType } from './route-scan-result';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Anthropic's structured-output subset doesn't carry zod's numeric
// constraints (exclusiveMinimum/minimum) as real JSON Schema keywords —
// zodOutputFormat() downgrades those into a `description` string instead,
// confirmed by inspecting its actual output. Constraints aren't load-
// bearing here anyway: checkKeyTimes() is what actually catches a bad
// extraction, not schema strictness, so this hand-written mirror omits them.
const EXTRACTED_ROUTE_SHEET_JSON_SCHEMA = {
  type: 'object',
  properties: {
    routeName: { type: 'string' },
    eventDate: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    startClockTime: { type: 'string' },
    segments: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          distanceMi: { type: 'number' },
          speedMph: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          isFree: { type: 'boolean' },
          isReset: { type: 'boolean' },
          label: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          checkType: {
            anyOf: [
              { type: 'string', enum: ['known', 'secret', 'emergency', 'gas', 'start', 'finish'] },
              { type: 'null' },
            ],
          },
        },
        additionalProperties: false,
        required: ['distanceMi', 'speedMph', 'isFree', 'isReset', 'label', 'checkType'],
      },
    },
    freeZones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startMi: { type: 'number' },
          endMi: { type: 'number' },
          reason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        additionalProperties: false,
        required: ['startMi', 'endMi', 'reason'],
      },
    },
    checkpoints: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          afterMile: { type: 'number' },
          clockTime: { type: 'string' },
        },
        additionalProperties: false,
        required: ['label', 'afterMile', 'clockTime'],
      },
    },
  },
  additionalProperties: false,
  required: ['routeName', 'eventDate', 'startClockTime', 'segments', 'freeZones', 'checkpoints'],
} as const;

interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string;
}

export async function extractRouteSheetDirect(
  apiKey: string,
  mimeType: ScanMimeType,
  dataBase64: string
): Promise<ExtractResponse> {
  if (!apiKey.trim()) {
    return { ok: false, error: 'No API key set. Add one in Settings.' };
  }

  const fileBlock =
    mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: dataBase64 } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data: dataBase64 } };

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey.trim(),
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: 'high',
          format: { type: 'json_schema', schema: EXTRACTED_ROUTE_SHEET_JSON_SCHEMA },
        },
        messages: [
          { role: 'user', content: [fileBlock, { type: 'text', text: EXTRACTION_PROMPT }] },
        ],
      }),
    });

    const body = await res.json();
    if (!res.ok) {
      return { ok: false, error: body?.error?.message ?? `Anthropic API returned ${res.status}` };
    }

    const message = body as AnthropicMessageResponse;
    if (message.stop_reason === 'refusal') {
      return { ok: false, error: 'Extraction model declined the request.' };
    }
    const textBlock = message.content.find(b => b.type === 'text' && typeof b.text === 'string');
    if (!textBlock?.text) {
      return { ok: false, error: 'Extraction did not return any text output.' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      return { ok: false, error: 'Extraction output was not valid JSON.' };
    }

    const validated = ExtractedRouteSheetSchema.safeParse(parsed);
    if (!validated.success) {
      return { ok: false, error: `Extraction output didn't match the expected shape: ${z.prettifyError(validated.error)}` };
    }

    const extracted = validated.data as ExtractedRouteSheet;
    const { routeSheet, checkpoints } = toRouteSheetData(extracted);
    const checkpointResults: CheckpointResult[] = checkKeyTimes(routeSheet.segments, checkpoints);

    return {
      ok: true,
      routeSheet: routeSheet as RouteSheetData,
      checkpointResults,
      allPassed: checkpointResults.every(r => r.passed),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    return { ok: false, error: `Could not reach Anthropic: ${message}` };
  }
}
