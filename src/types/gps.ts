/** A single GPS fix from the device */
export interface GpsPoint {
  lat: number;
  lng: number;
  altitude: number | null;
  accuracy: number;       // horizontal accuracy in meters
  speed: number | null;   // m/s from device, may be null
  timestamp: number;      // epoch ms
}

/** A completed split */
export interface GpsSplit {
  index: number;
  label: string;           // e.g. "km 1", "Rep 3 of 8", "Recovery 2"
  distance: number;        // meters covered in this split
  elapsed: number;         // seconds for this split
  pace: number;            // sec/km for this split
  targetPace: number | null; // expected pace from plan, null if none
}

/** A segment in a split scheme (what the tracker watches for) */
export interface SplitSegment {
  label: string;
  distance: number;        // meters for this segment
  targetPace: number | null; // sec/km target, null for untimed
}

/** A full split scheme describing the structure of a workout */
export interface SplitScheme {
  segments: SplitSegment[];
  totalDistance: number;    // sum of all segment distances
  description: string;     // human-readable summary
}

/** Live tracking data exposed to the UI on every GPS update */
export interface GpsLiveData {
  status: GpsTrackingStatus;
  totalDistance: number;   // meters
  elapsed: number;         // seconds (excludes pause time)
  currentPace: number | null; // rolling pace in sec/km
  currentSplit: GpsSplit | null;  // the in-progress split
  completedSplits: GpsSplit[];
  points: number;          // total accepted GPS points
  accuracy: number | null; // current GPS accuracy in meters (shown during acquisition)
}

/** A full GPS recording saved after a workout */
export interface GpsRecording {
  id: string;
  workoutName: string;
  week: number;
  date: string;            // ISO date string
  route: GpsPoint[];
  splits: GpsSplit[];
  totalDistance: number;
  totalElapsed: number;
  averagePace: number;
}

/** GPS tracker state machine states */
export type GpsTrackingStatus = 'idle' | 'acquiring' | 'tracking' | 'paused' | 'stopped';
