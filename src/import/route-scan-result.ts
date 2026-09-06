// Shared response shape for both extraction paths — the direct-from-phone
// call (route-scan-direct.ts) and the self-hosted server call
// (route-scan-client.ts) — so ScanRouteScreen can treat them identically.

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
