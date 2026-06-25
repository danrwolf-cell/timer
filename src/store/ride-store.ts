import { create } from 'zustand';
import { type Segment, detectSegment, computeKeyTime, computeDeviation, isInFreeSegment, crossedReset } from '../engine/pace-engine';

export type SensorStatus = 'disconnected' | 'connecting' | 'connected' | 'lost';

export interface RideState {
  // Route
  segments: Segment[];
  routeId: number | null;

  // Live ride
  isRiding: boolean;
  startTime: number | null;       // epoch ms
  cumulativeDistanceMi: number;
  currentSpeedMph: number;
  deviationSeconds: number;
  segmentIndex: number;
  inFreeSection: boolean;
  sensorStatus: SensorStatus;
  wheelCircumferenceMm: number;

  // Actions
  loadRoute: (segments: Segment[], routeId: number) => void;
  startRide: () => void;
  updateDistance: (distanceMi: number, speedMph: number) => void;
  manualReset: () => void;
  setSensorStatus: (status: SensorStatus) => void;
  setWheelCircumference: (mm: number) => void;
  endRide: () => void;
}

export const useRideStore = create<RideState>((set, get) => ({
  segments: [],
  routeId: null,
  isRiding: false,
  startTime: null,
  cumulativeDistanceMi: 0,
  currentSpeedMph: 0,
  deviationSeconds: 0,
  segmentIndex: 0,
  inFreeSection: false,
  sensorStatus: 'disconnected',
  wheelCircumferenceMm: 2183,

  loadRoute: (segments, routeId) => set({ segments, routeId }),

  startRide: () =>
    set({
      isRiding: true,
      startTime: Date.now(),
      cumulativeDistanceMi: 0,
      deviationSeconds: 0,
      segmentIndex: 0,
      inFreeSection: false,
    }),

  updateDistance: (distanceMi, speedMph) => {
    const { segments, startTime, isRiding, segmentIndex: prevSegmentIndex } = get();
    if (!isRiding || !startTime || segments.length === 0) return;

    const position = detectSegment(segments, distanceMi);
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    const keyTime = computeKeyTime(segments, position.segmentIndex, position.distanceInSegment);
    const deviation = computeDeviation(elapsedSeconds, keyTime);
    const inFree = isInFreeSegment(segments, position.segmentIndex);

    const didCrossReset = crossedReset(segments, prevSegmentIndex, position.segmentIndex);

    set({
      cumulativeDistanceMi: distanceMi,
      currentSpeedMph: speedMph,
      deviationSeconds: didCrossReset ? 0 : deviation,
      segmentIndex: position.segmentIndex,
      inFreeSection: inFree,
    });
  },

  manualReset: () => set({ deviationSeconds: 0 }),

  setSensorStatus: (status) => set({ sensorStatus: status }),

  setWheelCircumference: (mm) => set({ wheelCircumferenceMm: mm }),

  endRide: () =>
    set({
      isRiding: false,
      startTime: null,
      cumulativeDistanceMi: 0,
      currentSpeedMph: 0,
      deviationSeconds: 0,
    }),
}));
