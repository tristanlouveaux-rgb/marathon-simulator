/**
 * Shared watercolour sky background for all detail pages.
 * Same wave/mountain shapes, parameterised by colour palette.
 * Includes subtle CSS drift animation on wave layers.
 *
 * Reference: recovery-view.ts skyBackground() — the canonical pattern.
 */

const PAGE_BG = '#FAF9F6';

// ── Colour palettes ──────────────────────────────────────────────────────────

export interface SkyPalette {
  sky:      [string, string, string]; // top, mid, bottom gradient stops
  far:      [string, string];         // far mountain top, mid opacity
  mid:      [string, string];         // mid mountain top, mid opacity
  near:     [string, string];         // near mountain start, end (horizontal)
  glow:     string;                   // sun/moon glow colour
  cloud:    string;                   // cloud tint
}

export const SKY_PALETTES = {
  /** Physiology / Readiness / Freshness — clean blue-grey sky */
  blue: {
    sky:   ['#C5DFF8', '#E3F0FA', '#F0F7FC'],
    far:   ['#8BB8D8', '#A8CDE8'],
    mid:   ['#6BA3C9', '#8FC4E3'],
    near:  ['#5CB8A8', '#A8E0D4'],
    glow:  '#FFF8E7',
    cloud: '#FFFFFF',
  },
  /** Sleep — deep indigo/purple */
  indigo: {
    sky:   ['#C5C0F0', '#DDD8F8', '#F0EEFC'],
    far:   ['#9088D0', '#B0A8E0'],
    mid:   ['#7B6FC8', '#A898E0'],
    near:  ['#8B7ACC', '#C4B8E8'],
    glow:  '#E8E0FF',
    cloud: '#F0ECFF',
  },
  /** Strain — teal/blue-green */
  teal: {
    sky:   ['#B8E0E0', '#D4EEEE', '#EEF8F8'],
    far:   ['#78BCC0', '#98D0D4'],
    mid:   ['#5AA8B0', '#80C4CC'],
    near:  ['#4CA8A0', '#90D0C8'],
    glow:  '#E8FFF8',
    cloud: '#F0FFFC',
  },
  /** Rolling Load — deeper blue */
  deepBlue: {
    sky:   ['#A8C8E8', '#CCE0F4', '#EAF2FA'],
    far:   ['#7098C0', '#90B8D8'],
    mid:   ['#5880B0', '#80A8D0'],
    near:  ['#4888B8', '#88C0D8'],
    glow:  '#F0F4FF',
    cloud: '#F0F6FF',
  },
  /** Load-Taper — slate blue */
  slate: {
    sky:   ['#B0C4DE', '#D0DCE8', '#ECF0F4'],
    far:   ['#8098B8', '#A0B8D0'],
    mid:   ['#6888A8', '#90A8C4'],
    near:  ['#5890A8', '#98C0D0'],
    glow:  '#F0F4F8',
    cloud: '#F4F6F8',
  },
  /** Injury Risk — cool grey */
  grey: {
    sky:   ['#C0C8D4', '#D8DDE4', '#EEF0F2'],
    far:   ['#90A0B0', '#A8B8C4'],
    mid:   ['#7890A0', '#98B0C0'],
    near:  ['#6898A0', '#A0C0C8'],
    glow:  '#F0F2F4',
    cloud: '#F4F6F8',
  },
} as const satisfies Record<string, SkyPalette>;

export type SkyPaletteName = keyof typeof SKY_PALETTES;

// ── Animation CSS (inject once per page) ─────────────────────────────────────

export function skyAnimationCSS(prefix: string): string {
  return `
    @keyframes ${prefix}Drift1 {
      0%, 100% { transform: translateX(0); }
      50%      { transform: translateX(8px); }
    }
    @keyframes ${prefix}Drift2 {
      0%, 100% { transform: translateX(0); }
      50%      { transform: translateX(-6px); }
    }
    @keyframes ${prefix}Drift3 {
      0%, 100% { transform: translateX(0) translateY(0); }
      50%      { transform: translateX(5px) translateY(-3px); }
    }
  `;
}

// ── SVG background builder ───────────────────────────────────────────────────

/**
 * Build a watercolour sky background with animated wave layers.
 * @param prefix  Unique prefix for gradient/filter IDs (e.g. 'rec', 'slp', 'str')
 * @param palette Colour palette name or object
 */
export function buildSkyBackground(prefix: string, palette: SkyPaletteName | SkyPalette): string {
  const p: SkyPalette = typeof palette === 'string' ? SKY_PALETTES[palette] : palette;

  return `
    <div style="position:absolute;top:0;left:0;width:100%;height:480px;overflow:hidden;pointer-events:none;z-index:0">
      <svg style="width:100%;height:100%" viewBox="0 0 400 480" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="${prefix}SkyGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="${p.sky[0]}"/>
            <stop offset="30%" stop-color="${p.sky[1]}"/>
            <stop offset="70%" stop-color="${p.sky[2]}"/>
            <stop offset="100%" stop-color="${PAGE_BG}"/>
          </linearGradient>
          <linearGradient id="${prefix}Far" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="${p.far[0]}" stop-opacity="0.6"/>
            <stop offset="60%" stop-color="${p.far[1]}" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="${p.sky[2]}" stop-opacity="0.05"/>
          </linearGradient>
          <linearGradient id="${prefix}Mid" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="${p.mid[0]}" stop-opacity="0.75"/>
            <stop offset="50%" stop-color="${p.mid[1]}" stop-opacity="0.4"/>
            <stop offset="100%" stop-color="${p.sky[2]}" stop-opacity="0.1"/>
          </linearGradient>
          <linearGradient id="${prefix}Near" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="${p.near[0]}" stop-opacity="0.5"/>
            <stop offset="40%" stop-color="${p.near[1]}" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="${p.sky[2]}" stop-opacity="0.15"/>
          </linearGradient>
          <linearGradient id="${prefix}Mist" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.95"/>
            <stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.5"/>
            <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="${prefix}Glow" x1="50%" y1="50%" r="50%">
            <stop offset="0%" stop-color="${p.glow}" stop-opacity="0.8"/>
            <stop offset="100%" stop-color="${p.glow}" stop-opacity="0"/>
          </linearGradient>
          <filter id="${prefix}Sb"><feGaussianBlur stdDeviation="6"/></filter>
          <filter id="${prefix}Hb"><feGaussianBlur stdDeviation="20"/></filter>
          <filter id="${prefix}Wc"><feTurbulence type="fractalNoise" baseFrequency="0.008" numOctaves="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G"/><feGaussianBlur stdDeviation="1.5"/></filter>
        </defs>
        <!-- Sky -->
        <rect width="100%" height="100%" fill="url(#${prefix}SkyGrad)"/>
        <!-- Glow -->
        <ellipse cx="200" cy="130" rx="100" ry="80" fill="url(#${prefix}Glow)" filter="url(#${prefix}Sb)" opacity="0.7"/>
        <!-- Far mountains -->
        <g style="animation:${prefix}Drift1 12s ease-in-out infinite">
          <path d="M-60,190 Q20,150 80,180 T200,160 T350,170 T460,150 L460,480 L-60,480 Z" fill="url(#${prefix}Far)" filter="url(#${prefix}Wc)"/>
        </g>
        <!-- Clouds -->
        <ellipse cx="100" cy="210" rx="80" ry="25" fill="${p.cloud}" filter="url(#${prefix}Hb)" opacity="0.45"/>
        <ellipse cx="320" cy="195" rx="60" ry="20" fill="${p.cloud}" filter="url(#${prefix}Hb)" opacity="0.35"/>
        <!-- Mid mountains -->
        <g style="animation:${prefix}Drift2 15s ease-in-out infinite">
          <path d="M-40,270 Q50,210 130,250 T280,220 T420,250 L420,480 L-40,480 Z" fill="url(#${prefix}Mid)" filter="url(#${prefix}Wc)"/>
        </g>
        <!-- Mist -->
        <ellipse cx="280" cy="285" rx="120" ry="40" fill="#FFFFFF" opacity="0.45" filter="url(#${prefix}Hb)"/>
        <!-- Near mountains -->
        <g style="animation:${prefix}Drift3 18s ease-in-out infinite">
          <path d="M-20,350 Q60,290 150,330 T320,310 T440,340 L440,480 L-20,480 Z" fill="url(#${prefix}Near)" filter="url(#${prefix}Wc)"/>
        </g>
        <!-- Bottom mist layers -->
        <path d="M0,370 Q100,330 200,370 T400,350 L400,480 L0,480 Z" fill="url(#${prefix}Mist)" filter="url(#${prefix}Sb)"/>
        <path d="M0,410 Q150,390 300,420 T400,410 L400,480 L0,480 Z" fill="url(#${prefix}Mist)" opacity="0.7" filter="url(#${prefix}Hb)"/>
        <!-- High clouds -->
        <ellipse cx="50" cy="90" rx="40" ry="15" fill="${p.cloud}" filter="url(#${prefix}Hb)" opacity="0.28"/>
        <ellipse cx="350" cy="110" rx="30" ry="12" fill="${p.cloud}" filter="url(#${prefix}Hb)" opacity="0.22"/>
      </svg>
      <div style="position:absolute;bottom:0;left:0;width:100%;height:120px;background:linear-gradient(to top,${PAGE_BG},transparent)"></div>
    </div>`;
}
