import { describe, it, expect, beforeEach } from 'vitest';
import { setState } from '@/state/store';
import type { SimulatorState } from '@/types/state';
import {
  getStrengthSwaps,
  setStrengthSwap,
  clearStrengthSwap,
  listStrengthSwaps,
  countStrengthSwaps,
  clearAllStrengthSwaps,
} from './strength-swaps';

beforeEach(() => setState({} as SimulatorState));

describe('strength swap state (the swap-back surface)', () => {
  it('remembers a swap with both the original and the substitute name', () => {
    setStrengthSwap('Trap-Bar Deadlift', 'Deadlift');
    expect(countStrengthSwaps()).toBe(1);
    expect(getStrengthSwaps()['trap-bar-deadlift']).toEqual({ from: 'Trap-Bar Deadlift', to: 'Deadlift' });
  });

  it('keys by equipment slug, so re-swapping the same movement updates in place', () => {
    setStrengthSwap('Trap-Bar Deadlift', 'Deadlift');
    setStrengthSwap('Trap-Bar Deadlift', 'Front Squat'); // changed my mind
    expect(countStrengthSwaps()).toBe(1);
    expect(getStrengthSwaps()['trap-bar-deadlift'].to).toBe('Front Squat');
  });

  it('lists swaps sorted by original name for the manage surface', () => {
    setStrengthSwap('Weighted Lunge', 'Step-Up');
    setStrengthSwap('Trap-Bar Deadlift', 'Deadlift');
    expect(listStrengthSwaps().map(s => s.from)).toEqual(['Trap-Bar Deadlift', 'Weighted Lunge']);
  });

  it('reverts a single swap, leaving the rest intact', () => {
    setStrengthSwap('Weighted Lunge', 'Step-Up');
    setStrengthSwap('Trap-Bar Deadlift', 'Deadlift');
    clearStrengthSwap('Trap-Bar Deadlift');
    expect(listStrengthSwaps().map(s => s.from)).toEqual(['Weighted Lunge']);
  });

  it('reverts all swaps at once', () => {
    setStrengthSwap('Weighted Lunge', 'Step-Up');
    setStrengthSwap('Trap-Bar Deadlift', 'Deadlift');
    clearAllStrengthSwaps();
    expect(countStrengthSwaps()).toBe(0);
    expect(listStrengthSwaps()).toEqual([]);
  });

  it('reverting a movement that was never swapped is a no-op', () => {
    setStrengthSwap('Trap-Bar Deadlift', 'Deadlift');
    clearStrengthSwap('Back Squat');
    expect(countStrengthSwaps()).toBe(1);
  });
});
