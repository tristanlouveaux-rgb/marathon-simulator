/**
 * Discipline palette (§18.8).
 *
 * Swim muted teal, bike warm clay, run existing olive/sage. All three sit
 * in the project's nature palette — nothing here is a primary RGB.
 */

import type { Discipline } from '@/types/triathlon';

export const DISCIPLINE_COLOURS: Record<Discipline, {
  bg: string;         // Faint card tint
  border: string;     // Discipline-coloured border
  badge: string;      // Badge background
  badgeText: string;  // Badge text
  accent: string;     // Bars, dots, accents
}> = {
  swim: {
    bg: 'rgba(91, 138, 138, 0.06)',
    border: 'rgba(91, 138, 138, 0.25)',
    badge: 'rgba(91, 138, 138, 0.14)',
    badgeText: '#3d6666',
    accent: '#5b8a8a',
  },
  bike: {
    bg: 'rgba(192, 132, 96, 0.06)',
    border: 'rgba(192, 132, 96, 0.25)',
    badge: 'rgba(192, 132, 96, 0.14)',
    badgeText: '#9c6245',
    accent: '#c08460',
  },
  run: {
    bg: 'rgba(122, 132, 92, 0.06)',
    border: 'rgba(122, 132, 92, 0.25)',
    badge: 'rgba(122, 132, 92, 0.14)',
    badgeText: '#4f5a3b',
    accent: '#7a845c',
  },
};

export const DISCIPLINE_LABEL: Record<Discipline, string> = {
  swim: 'Swim',
  bike: 'Bike',
  run: 'Run',
};

export const DISCIPLINE_ICON: Record<Discipline, string> = {
  swim: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M2.5 17c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0"/><path d="M2.5 13c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0"/></svg>`,
  bike: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17l4-7h5l3 7M10 10l2-5h3"/></svg>`,
  run: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><circle cx="15" cy="4.5" r="1.6"/><path d="M7 11l3.5-3 3 1.5 2.5 3 2.5 0.5M10.5 8.5l-3 4 3 2 0.5 4.5"/></svg>`,
};
