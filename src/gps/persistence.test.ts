import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveGpsRecording,
  loadGpsRecording,
  getWeekRecordings,
  deleteGpsRecording,
  clearAllGpsData
} from './persistence';
import type { GpsRecording } from '@/types';

// Mock localStorage
const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { for (const k in store) delete store[k]; },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
};

Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage });

function makeRecording(id: string, week: number): GpsRecording {
  return {
    id,
    workoutName: `Workout ${id}`,
    week,
    date: '2025-01-01',
    route: [],
    splits: [],
    totalDistance: 5000,
    totalElapsed: 1500,
    averagePace: 300,
  };
}

describe('GPS Persistence', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
  });

  describe('saveGpsRecording / loadGpsRecording', () => {
    it('saves and loads a recording', () => {
      const rec = makeRecording('rec1', 1);
      saveGpsRecording(rec);

      const loaded = loadGpsRecording('rec1');
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('rec1');
      expect(loaded!.workoutName).toBe('Workout rec1');
      expect(loaded!.totalDistance).toBe(5000);
    });

    it('returns null for non-existent recording', () => {
      expect(loadGpsRecording('nonexistent')).toBeNull();
    });

    it('does not duplicate ids in index', () => {
      const rec = makeRecording('rec1', 1);
      saveGpsRecording(rec);
      saveGpsRecording(rec);

      const index = JSON.parse(store['marathonSimulatorGpsIndex']);
      expect(index.length).toBe(1);
    });
  });

  describe('getWeekRecordings', () => {
    it('returns recordings for a specific week', () => {
      saveGpsRecording(makeRecording('w1r1', 1));
      saveGpsRecording(makeRecording('w1r2', 1));
      saveGpsRecording(makeRecording('w2r1', 2));

      const week1 = getWeekRecordings(1);
      expect(week1.length).toBe(2);
      expect(week1[0].week).toBe(1);

      const week2 = getWeekRecordings(2);
      expect(week2.length).toBe(1);

      const week3 = getWeekRecordings(3);
      expect(week3.length).toBe(0);
    });
  });

  describe('deleteGpsRecording', () => {
    it('deletes a recording and removes from index', () => {
      saveGpsRecording(makeRecording('rec1', 1));
      saveGpsRecording(makeRecording('rec2', 1));

      deleteGpsRecording('rec1');

      expect(loadGpsRecording('rec1')).toBeNull();
      expect(loadGpsRecording('rec2')).not.toBeNull();

      const index = JSON.parse(store['marathonSimulatorGpsIndex']);
      expect(index).toEqual(['rec2']);
    });
  });

  describe('clearAllGpsData', () => {
    it('removes all recordings and index', () => {
      saveGpsRecording(makeRecording('rec1', 1));
      saveGpsRecording(makeRecording('rec2', 2));

      clearAllGpsData();

      expect(loadGpsRecording('rec1')).toBeNull();
      expect(loadGpsRecording('rec2')).toBeNull();
      expect(store['marathonSimulatorGpsIndex']).toBeUndefined();
    });
  });
});
