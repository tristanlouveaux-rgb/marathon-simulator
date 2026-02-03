import type { GpsRecording } from '@/types';

const GPS_INDEX_KEY = 'marathonSimulatorGpsIndex';
const GPS_RECORDING_PREFIX = 'marathonSimulatorGps_';

/**
 * Save a GPS recording. Stores the recording under its own key
 * and adds the id to the index.
 */
export function saveGpsRecording(recording: GpsRecording): void {
  try {
    const index = getRecordingIndex();
    if (!index.includes(recording.id)) {
      index.push(recording.id);
    }
    localStorage.setItem(GPS_INDEX_KEY, JSON.stringify(index));
    localStorage.setItem(GPS_RECORDING_PREFIX + recording.id, JSON.stringify(recording));
  } catch (e) {
    console.error('Error saving GPS recording:', e);
  }
}

/**
 * Load a GPS recording by id.
 */
export function loadGpsRecording(id: string): GpsRecording | null {
  try {
    const raw = localStorage.getItem(GPS_RECORDING_PREFIX + id);
    if (!raw) return null;
    return JSON.parse(raw) as GpsRecording;
  } catch {
    return null;
  }
}

/**
 * Get all recording ids for a given week.
 */
export function getWeekRecordings(week: number): GpsRecording[] {
  const index = getRecordingIndex();
  const recordings: GpsRecording[] = [];
  for (const id of index) {
    const rec = loadGpsRecording(id);
    if (rec && rec.week === week) {
      recordings.push(rec);
    }
  }
  return recordings;
}

/**
 * Delete a GPS recording by id.
 */
export function deleteGpsRecording(id: string): void {
  try {
    localStorage.removeItem(GPS_RECORDING_PREFIX + id);
    const index = getRecordingIndex().filter(i => i !== id);
    localStorage.setItem(GPS_INDEX_KEY, JSON.stringify(index));
  } catch (e) {
    console.error('Error deleting GPS recording:', e);
  }
}

/**
 * Clear all GPS data (index + all recordings).
 */
export function clearAllGpsData(): void {
  try {
    const index = getRecordingIndex();
    for (const id of index) {
      localStorage.removeItem(GPS_RECORDING_PREFIX + id);
    }
    localStorage.removeItem(GPS_INDEX_KEY);
  } catch (e) {
    console.error('Error clearing GPS data:', e);
  }
}

/**
 * Get the list of all recording ids.
 */
function getRecordingIndex(): string[] {
  try {
    const raw = localStorage.getItem(GPS_INDEX_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}
