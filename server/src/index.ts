// Route-sheet extraction backend. One endpoint: POST /extract takes a
// photographed or uploaded route sheet (image or PDF, base64) and returns
// structured segments/free-zones/checkpoints plus the result of checking
// every checkpoint against the same pace engine the app runs — see
// ../../src/import/route-scan.ts and ../../src/import/route-sheet.ts for
// why that check exists and what it guarantees.
//
// Run: ANTHROPIC_API_KEY=... npm start   (see README.md for deployment)

import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ExtractedRouteSheetSchema } from './schema';
import { EXTRACTION_PROMPT } from './prompt';
import { toRouteSheetData, type ExtractedRouteSheet } from '../../src/import/route-scan';
import { checkKeyTimes } from '../../src/import/route-sheet';

const ACCEPTED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number];

function isAcceptedMimeType(m: unknown): m is AcceptedMimeType {
  return typeof m === 'string' && (ACCEPTED_MIME_TYPES as readonly string[]).includes(m);
}

const app = express();
app.use(express.json({ limit: '30mb' })); // base64 PDFs/photos inflate ~33% over raw bytes

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/extract', async (req, res) => {
  const { mimeType, dataBase64 } = req.body ?? {};

  if (!isAcceptedMimeType(mimeType)) {
    res.status(400).json({ ok: false, error: `mimeType must be one of ${ACCEPTED_MIME_TYPES.join(', ')}` });
    return;
  }
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
    res.status(400).json({ ok: false, error: 'dataBase64 is required' });
    return;
  }

  try {
    const fileBlock: Anthropic.Messages.ContentBlockParam =
      mimeType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: dataBase64 } }
        : { type: 'image', source: { type: 'base64', media_type: mimeType, data: dataBase64 } };

    const response = await client.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: zodOutputFormat(ExtractedRouteSheetSchema),
      },
      messages: [
        {
          role: 'user',
          content: [fileBlock, { type: 'text', text: EXTRACTION_PROMPT }],
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      res.status(502).json({ ok: false, error: 'Extraction model declined the request.' });
      return;
    }
    if (!response.parsed_output) {
      res.status(502).json({ ok: false, error: 'Extraction did not return parseable output.' });
      return;
    }

    const extracted = response.parsed_output as ExtractedRouteSheet;
    const { routeSheet, checkpoints } = toRouteSheetData(extracted);
    const checkpointResults = checkKeyTimes(routeSheet.segments, checkpoints);

    res.json({
      ok: true,
      routeSheet,
      checkpointResults,
      allPassed: checkpointResults.every(r => r.passed),
    });
  } catch (err) {
    console.error('extraction failed:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ ok: false, error: message });
  }
});

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8787;
app.listen(port, () => {
  console.log(`Route-scan server listening on :${port}`);
});
