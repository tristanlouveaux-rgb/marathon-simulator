/**
 * Unit tests for pure parsing helpers used by the coach UI.
 * Network-free; runs as part of the default `npm test`.
 */

import { describe, it, expect } from 'vitest';
import { extractChoices, extractConfidence, stripMarkdown } from '../../ui/coach-view';
import { isClearDirective } from '../coach-chat-client';
import { scaleWorkoutDescription } from '../coach-tools';

describe('stripMarkdown', () => {
  it('removes bold markers', () => {
    expect(stripMarkdown('You are **tracking** well')).toBe('You are tracking well');
  });

  it('removes italic markers', () => {
    expect(stripMarkdown('Look at *this*')).toBe('Look at this');
  });

  it('removes heading markers at line start', () => {
    expect(stripMarkdown('# Heading\nbody')).toBe('Heading\nbody');
  });

  it('strips inline code backticks', () => {
    expect(stripMarkdown('Run the `reduce_workout` tool')).toBe('Run the reduce_workout tool');
  });

  it('strips em-dashes (banned by copy rules)', () => {
    expect(stripMarkdown('Hard sessions — and easy days')).toContain(',');
    expect(stripMarkdown('Hard sessions — and easy days')).not.toContain('—');
  });

  it('converts en-dashes to hyphens', () => {
    expect(stripMarkdown('2–3 weeks')).toBe('2-3 weeks');
  });

  it('removes bullet markers at line start', () => {
    expect(stripMarkdown('- one\n* two')).toBe('one\ntwo');
  });
});

describe('extractChoices', () => {
  it('returns empty choices when block missing', () => {
    const r = extractChoices('Just a regular message');
    expect(r.choices).toEqual([]);
    expect(r.clean).toBe('Just a regular message');
  });

  it('parses a well-formed choices block', () => {
    const text = 'Brief here.\n\n<choices>\nCut Tuesday threshold\nAdd a rest day\nWhy is CTL rising?\n</choices>';
    const r = extractChoices(text);
    expect(r.choices).toEqual(['Cut Tuesday threshold', 'Add a rest day', 'Why is CTL rising?']);
    expect(r.clean).toBe('Brief here.');
  });

  it('caps at 4 choices', () => {
    const text = '<choices>\n1\n2\n3\n4\n5\n6\n</choices>';
    expect(extractChoices(text).choices).toHaveLength(4);
  });

  it('strips bullet markers from choice lines', () => {
    const text = '<choices>\n- One\n• Two\n</choices>';
    expect(extractChoices(text).choices).toEqual(['One', 'Two']);
  });

  it('handles case-insensitive tag', () => {
    expect(extractChoices('<Choices>Hello</Choices>').choices).toEqual(['Hello']);
  });

  it('drops empty lines and tokens longer than 80 chars', () => {
    const longLine = 'x'.repeat(100);
    const text = `<choices>\nOK\n\n${longLine}\n</choices>`;
    expect(extractChoices(text).choices).toEqual(['OK']);
  });
});

describe('extractConfidence', () => {
  it('returns null when block missing', () => {
    const r = extractConfidence('No tag here');
    expect(r.confidence).toBeNull();
    expect(r.clean).toBe('No tag here');
  });

  it('parses high', () => {
    expect(extractConfidence('body <confidence>high</confidence>').confidence).toBe('high');
  });

  it('parses medium', () => {
    expect(extractConfidence('<confidence>medium</confidence>').confidence).toBe('medium');
  });

  it('parses low', () => {
    expect(extractConfidence('<confidence>low</confidence>').confidence).toBe('low');
  });

  it('removes the tag from cleaned text', () => {
    expect(extractConfidence('body <confidence>high</confidence>').clean).toBe('body');
  });

  it('is case insensitive on level', () => {
    expect(extractConfidence('<confidence>HIGH</confidence>').confidence).toBe('high');
  });
});

describe('isClearDirective', () => {
  it('catches verb+day patterns', () => {
    expect(isClearDirective('reduce tuesday swim by 20%')).toBe(true);
    expect(isClearDirective('swap thursday for rest')).toBe(true);
    expect(isClearDirective('skip tomorrow\'s easy run')).toBe(true);
  });

  it('catches numeric-only replies', () => {
    expect(isClearDirective('20%')).toBe(true);
    expect(isClearDirective('30')).toBe(true);
  });

  it('catches short affirmatives ONLY when prior assistant signalled tool intent', () => {
    const toolIntent = "OK, cutting Tuesday's swim by 30%.";
    const noIntent  = 'Your CTL is 10.3 this week — strong build.';
    expect(isClearDirective('yes do it', toolIntent)).toBe(true);
    expect(isClearDirective('apply', toolIntent)).toBe(true);
    expect(isClearDirective('now?', toolIntent)).toBe(true);
    // Same affirmative, but prior turn was purely informational → not a directive
    expect(isClearDirective('yes', noIntent)).toBe(false);
    expect(isClearDirective('apply', noIntent)).toBe(false);
    // No prior turn at all → conservative (no force)
    expect(isClearDirective('yes')).toBe(false);
  });

  it('catches memory directives', () => {
    expect(isClearDirective('remember that I prefer Tuesday quality days')).toBe(true);
    expect(isClearDirective('forget that previous memory')).toBe(true);
  });

  it('does not match plain questions', () => {
    expect(isClearDirective('how am I tracking?')).toBe(false);
    expect(isClearDirective('explain my plan')).toBe(false);
    expect(isClearDirective('what should I eat?')).toBe(false);
  });

  it('does not match short noise', () => {
    expect(isClearDirective('a')).toBe(false);
    expect(isClearDirective('hi')).toBe(false);
  });
});

describe('scaleWorkoutDescription', () => {
  it('scales metres', () => {
    expect(scaleWorkoutDescription('3300m total', 0.7)).toContain('2300m');
  });

  it('scales km', () => {
    expect(scaleWorkoutDescription('8km easy run', 0.5)).toContain('4km');
  });

  it('scales minutes', () => {
    expect(scaleWorkoutDescription('60 min easy', 0.5)).toContain('30min');
  });

  it('scales h+min compounds', () => {
    expect(scaleWorkoutDescription('1h 30min ride', 0.5)).toContain('45min');
  });

  it('does NOT scale pace tokens like 2:10/100m', () => {
    const scaled = scaleWorkoutDescription('@ 2:10/100m', 0.5);
    expect(scaled).toContain('/100m');
  });

  it('returns input unchanged when factor is 1', () => {
    const original = '3300m total. 200m WU. 8x75m @ 2:10/100m. 200m CD.';
    expect(scaleWorkoutDescription(original, 1)).toBe(original);
  });

  it('handles empty input', () => {
    expect(scaleWorkoutDescription('', 0.5)).toBe('');
  });

  // ── Interval rep-distance guard (P0 regression) ───────────────────────────
  // Reps inside "8x100m" / "4x400m" / "6×200m" are PRESCRIPTIONS, not volumes.
  // A 30% reduce must not scale them — that destroys the interval.
  it('does NOT scale interval rep distances — 8x100m', () => {
    const result = scaleWorkoutDescription('Warm up + 8x100m strides + cool down', 0.7);
    expect(result).toContain('8x100m');
  });

  it('does NOT scale interval rep distances — 4x400m at threshold', () => {
    const result = scaleWorkoutDescription('20min WU. 4x400m threshold. 10min CD.', 0.7);
    expect(result).toContain('4x400m');
  });

  it('does NOT scale interval rep distances — 6 × 200m with spaces', () => {
    const result = scaleWorkoutDescription('Track session: 6 x 200m fast.', 0.7);
    expect(result).toContain('200m');
  });

  it('does NOT scale interval rep distances — 8×200m with unicode multiplication sign', () => {
    const result = scaleWorkoutDescription('8×200m repeats', 0.7);
    expect(result).toContain('200m');
  });

  it('STILL scales total volumes when intervals are present', () => {
    // Total "3000m" should scale, "8x100m" reps should not.
    const result = scaleWorkoutDescription('3000m total. 8x100m strides included.', 0.7);
    expect(result).toContain('8x100m');         // reps unchanged
    expect(result).toMatch(/2[01]00m total/);   // 3000m × 0.7 = 2100m
  });
});
