// Talks to the self-hosted extraction backend (server/) over plain fetch.
// No DB import here — this only knows how to call the server and shape its
// response; ScanRouteScreen owns persisting the settings URL and, on save,
// calling importRouteSheet().

import { type RouteSheetData, type CheckpointResult } from './route-sheet';

export interface ExtractSuccess {
  ok: true;
  routeSheet: RouteSheetData;
  checkpointResults: CheckpointResult[];
  allPassed: boolean;
}

export interface ExtractFailure {
  ok: false;
  error: string;
}

export type ExtractResponse = ExtractSuccess | ExtractFailure;

export type ScanMimeType = 'application/pdf' | 'image/jpeg' | 'image/png';

/** POSTs a photographed or uploaded route sheet to the extraction server. */
export async function extractRouteSheet(
  serverUrl: string,
  mimeType: ScanMimeType,
  dataBase64: string
): Promise<ExtractResponse> {
  const url = serverUrl.replace(/\/+$/, '') + '/extract';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mimeType, dataBase64 }),
    });
    const body = await res.json();
    if (!res.ok) {
      return { ok: false, error: body?.error ?? `Server returned ${res.status}` };
    }
    return body as ExtractResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    return { ok: false, error: `Could not reach extraction server: ${message}` };
  }
}
