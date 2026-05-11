/**
 * Page Flair — concentric ring backgrounds + sun-glint corner overlay.
 *
 * Two complementary visual systems shared across the app:
 *
 *   1. Ring backgrounds — concentric SVG circles with linear-gradient strokes
 *      (white highlight upper-left → mid blue/teal → dark lower-right).
 *      Five named variants (centered / sweep / focused / asymmetric / whisper)
 *      give per-page composition variety while keeping the same DNA.
 *
 *   2. Sun glint — warm cream radial-gradient at upper-left of every page.
 *      The universal corner mark. Three intensities (low / mid / high).
 *
 * Reference: docs/UX_PATTERNS.md → "Ring Backgrounds" + "Sun Glint".
 *
 * **Exclusivity rule** (read before applying anywhere new):
 *   - Rings are wizard-only (onboarding flow) by default
 *   - Mountains (`buildSkyBackground` from sky-background.ts) are detail-page-only
 *   - Sun glint is universal (every page)
 *
 * **Animation system** (all motion is one-shot — page settles after arrival):
 *   - First-ever ring experience (per device): large entrance (~1.4s, scale 0.28→1)
 *     plus a single light haptic tap on iOS. Tracked via localStorage flag.
 *   - All subsequent appearances: small "settle" entrance (~0.55s, scale 0.85→1).
 *     No haptic. Designed to be near-invisible on rapid form toggles.
 *   - Pulse: opt-in, runs once (~9s opacity breath) then holds at baseline.
 *   - Drift ring: opt-in (auto-added when `pulse:true`), runs once (~6.5s outward
 *     ripple) then disappears. Single "exhale" on arrival, no looping.
 *   - Wave pulse: triggered manually via `triggerRingWave(prefix)` when navigating
 *     between persistent-ring contexts (e.g. intro slide transitions). Subtle
 *     opacity+scale flicker that propagates inner→outer like dipping a finger.
 *   - **`prefers-reduced-motion: reduce`**: every animation in this module is
 *     disabled and the static end-state is rendered immediately. iOS Reduce
 *     Motion users get no entrance, no drift, no pulse, no wave.
 *
 * **iOS notes**:
 *   - backdrop-filter perf: glassy cards stack a heavy filter; watch fps when
 *     pages with several glassy surfaces render simultaneously.
 *   - safe-area-inset-top: the sun glint origins from upper-left of viewport;
 *     respect notch via the helper's positioning (uses 0,0 coords; pages with
 *     notches should ensure no critical content sits under the glint).
 *
 * **ViewBox assumption**: variants are tuned for mobile portrait (~400×800).
 * App is locked portrait via Capacitor.
 *
 * Pattern model: src/ui/sky-background.ts (HTML-string builder + separate
 * animation CSS helper, prefix-namespaced gradient/animation IDs).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type RingVariant = 'centered' | 'sweep' | 'focused' | 'asymmetric' | 'whisper';
export type GlintIntensity = 'low' | 'mid' | 'high';
export type RingPalette =
  | 'blue'      // wizard default; Readiness (clinical, focused)
  | 'sky'       // Home (softer, more atmospheric — morning sky vs data)
  | 'teal'      // race-prediction moments, Strava-results
  | 'indigo'    // Sleep
  | 'mint'      // Freshness
  | 'deepBlue'  // Rolling Load
  | 'slate'     // Load / Taper
  | 'grey'      // archive contexts
  | 'coral'     // Strain (warm intensity)
  | 'rose'      // Recovery (warm soft pink)
  | 'amber';    // Injury Risk (warning warmth)
/** Entrance animation intensity. 'small' is the default; 'large' is the hero
 * water-droplet ripple (used only on the user's first ever ring experience). */
export type EntranceMode = 'large' | 'small' | 'none';

export interface RingOptions {
  variant: RingVariant;
  /** Pulse animation on the near-ring group. One-shot: a single ~9s opacity
   *  breath on arrival, then holds at baseline. Also auto-adds the drift ring. */
  pulse?: boolean;
  /** Side for `asymmetric` variant. Ignored for other variants. Default 'right'. */
  side?: 'left' | 'right';
  /** Colour palette for ring strokes + accents. Default 'blue'. */
  palette?: RingPalette;
  /** Entrance animation intensity. Default 'small'. Use 'large' only for hero
   * first-impression moments (gate via `isFirstRingExperience()`). */
  entrance?: EntranceMode;
}

// ── Shared visual constants (single source of truth) ─────────────────────────

/**
 * Three gradient tiers create depth between rings.
 * All share the same colour DNA — light upper-left, depth lower-right —
 * but inner/outer rings use different intensity envelopes so the inner
 * rings "pop" and the outer rings "recede".
 */
const RING_GRADIENTS = {
  outer: { hi: 0.55, mid: 0.32, lo: 0.12 },
  mid:   { hi: 0.75, mid: 0.55, lo: 0.22 },
  inner: { hi: 0.95, mid: 0.72, lo: 0.32 },
} as const;

/** Ring stroke palettes. All share the same white highlight; mid + shadow shift
 * to give each page a colour identity within the same DNA. */
const RING_PALETTES: Record<RingPalette, { highlight: string; mid: string; shadow: string }> = {
  blue:     { highlight: '#FFFFFF', mid: '#5874A0', shadow: '#2E4668' },
  sky:      { highlight: '#FFFFFF', mid: '#7A9BC4', shadow: '#3F5C82' },
  teal:     { highlight: '#FFFFFF', mid: '#3F8F84', shadow: '#1C4A44' },
  indigo:   { highlight: '#FFFFFF', mid: '#6B5BCB', shadow: '#312A66' },
  mint:     { highlight: '#FFFFFF', mid: '#4FA887', shadow: '#1F4A3C' },
  deepBlue: { highlight: '#FFFFFF', mid: '#3F62A8', shadow: '#1A3066' },
  slate:    { highlight: '#FFFFFF', mid: '#6B7E9E', shadow: '#36476A' },
  grey:     { highlight: '#FFFFFF', mid: '#7A8294', shadow: '#3F4658' },
  coral:    { highlight: '#FFFFFF', mid: '#C56B5C', shadow: '#7A2E20' },
  rose:     { highlight: '#FFFFFF', mid: '#C5707A', shadow: '#7A2E40' },
  amber:    { highlight: '#FFFFFF', mid: '#D08B3A', shadow: '#7A4A14' },
};

/** Atmosphere base palettes — soft radial gradient tinted to each page's family.
 * All fade to the page background `#FAF9F6` at the edges so they dissolve cleanly. */
const ATMOSPHERE_GRADIENTS: Record<RingPalette, string> = {
  blue:     'radial-gradient(ellipse 85% 75% at 50% 42%, #E6EEF7 0%, #EDF3F9 35%, #F5F7FA 65%, #FAF9F6 100%)',
  sky:      'radial-gradient(ellipse 90% 80% at 35% 30%, #C8DEF2 0%, #DAE9F4 25%, #E8F0F7 55%, #F2F5F8 75%, #FAF9F6 100%)',
  teal:     'radial-gradient(ellipse 85% 75% at 50% 42%, #DDEEEA 0%, #E5F1ED 35%, #EFF6F4 65%, #FAF9F6 100%)',
  indigo:   'radial-gradient(ellipse 85% 75% at 50% 42%, #E2DFF5 0%, #ECEAF7 35%, #F4F2FA 65%, #FAF9F6 100%)',
  mint:     'radial-gradient(ellipse 85% 75% at 50% 42%, #DEEEE5 0%, #E7F2EC 35%, #F0F6F2 65%, #FAF9F6 100%)',
  deepBlue: 'radial-gradient(ellipse 85% 75% at 50% 42%, #DDE6F0 0%, #E5EBF3 35%, #EEF1F7 65%, #FAF9F6 100%)',
  slate:    'radial-gradient(ellipse 85% 75% at 50% 42%, #E0E4EC 0%, #E8EAF0 35%, #F0F2F5 65%, #FAF9F6 100%)',
  grey:     'radial-gradient(ellipse 85% 75% at 50% 42%, #E2E4E8 0%, #EAEBEE 35%, #F2F3F5 65%, #FAF9F6 100%)',
  coral:    'radial-gradient(ellipse 85% 75% at 50% 42%, #F2DCD7 0%, #F5E5E1 35%, #F8EDEB 65%, #FAF9F6 100%)',
  rose:     'radial-gradient(ellipse 85% 75% at 50% 42%, #F2D8DD 0%, #F5E1E5 35%, #F8EBED 65%, #FAF9F6 100%)',
  amber:    'radial-gradient(ellipse 85% 75% at 50% 42%, #F2E5CC 0%, #F5EAD8 35%, #F8F0E5 65%, #FAF9F6 100%)',
};

const ACCENT_GRADIENT = { hi: 0.45, lo: 0.12 } as const;

/** Sun glint — warm cream upper-left corner. Always upper-left for a consistent light source. */
const GLINT_OPACITY: Record<GlintIntensity, { core: number; halo: number }> = {
  low:  { core: 0.10, halo: 0.04 },
  mid:  { core: 0.18, halo: 0.08 },
  high: { core: 0.28, halo: 0.12 },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

type GradientTier = keyof typeof RING_GRADIENTS;

function gradientStops(tier: GradientTier, palette: RingPalette): string {
  const t = RING_GRADIENTS[tier];
  const hex = RING_PALETTES[palette];
  return `
    <stop offset="0%"   stop-color="${hex.highlight}" stop-opacity="${t.hi}"/>
    <stop offset="45%"  stop-color="${hex.mid}"       stop-opacity="${t.mid}"/>
    <stop offset="100%" stop-color="${hex.shadow}"    stop-opacity="${t.lo}"/>
  `;
}

function accentStops(palette: RingPalette): string {
  const hex = RING_PALETTES[palette];
  return `
    <stop offset="0%"   stop-color="${hex.highlight}" stop-opacity="${ACCENT_GRADIENT.hi}"/>
    <stop offset="100%" stop-color="${hex.mid}"       stop-opacity="${ACCENT_GRADIENT.lo}"/>
  `;
}

type DepthLayer = 'far' | 'mid' | 'near';

interface RingDef {
  r: number;
  tier: GradientTier;
  sw: number;
  opacity: number;
  depth: DepthLayer;
}
interface AccentDef { cx: number; cy: number; rx: number; ry: number; sw: number; }
interface VariantDef {
  cx: number;
  cy: number;
  rings: RingDef[];
  accents: AccentDef[];
}

// ── Variant definitions ──────────────────────────────────────────────────────

const VARIANTS: Record<Exclude<RingVariant, 'asymmetric'>, VariantDef> = {
  centered: {
    cx: 200, cy: 380,
    rings: [
      { r: 395, tier: 'outer', sw: 2.6, opacity: 0.22, depth: 'far'  },
      { r: 310, tier: 'outer', sw: 2.2, opacity: 0.38, depth: 'far'  },
      { r: 225, tier: 'mid',   sw: 1.8, opacity: 0.62, depth: 'mid'  },
      { r: 148, tier: 'inner', sw: 1.4, opacity: 0.88, depth: 'near' },
      { r: 80,  tier: 'inner', sw: 1.2, opacity: 1.00, depth: 'near' },
    ],
    accents: [
      { cx: 310, cy: 155, rx: 200, ry: 155, sw: 1.5 },
      { cx: 90,  cy: 625, rx: 180, ry: 140, sw: 1.5 },
    ],
  },
  sweep: {
    cx: 200, cy: 950,
    rings: [
      { r: 800, tier: 'outer', sw: 2.4, opacity: 0.20, depth: 'far'  },
      { r: 700, tier: 'outer', sw: 2.0, opacity: 0.38, depth: 'far'  },
      { r: 600, tier: 'mid',   sw: 1.8, opacity: 0.62, depth: 'mid'  },
      { r: 500, tier: 'inner', sw: 1.6, opacity: 0.92, depth: 'near' },
    ],
    accents: [],
  },
  focused: {
    cx: 200, cy: 200,
    rings: [
      { r: 195, tier: 'outer', sw: 1.8, opacity: 0.30, depth: 'far'  },
      { r: 130, tier: 'mid',   sw: 1.5, opacity: 0.62, depth: 'mid'  },
      { r: 70,  tier: 'inner', sw: 1.3, opacity: 1.00, depth: 'near' },
    ],
    accents: [
      { cx: 320, cy: 580, rx: 160, ry: 130, sw: 1.3 },
    ],
  },
  whisper: {
    cx: 200, cy: 380,
    rings: [
      { r: 480, tier: 'outer', sw: 1.6, opacity: 0.28, depth: 'far' },
      { r: 350, tier: 'outer', sw: 1.4, opacity: 0.36, depth: 'mid' },
    ],
    accents: [],
  },
};

function asymmetricVariant(side: 'left' | 'right'): VariantDef {
  const cx = side === 'right' ? 460 : -60;
  return {
    cx, cy: 400,
    rings: [
      { r: 440, tier: 'outer', sw: 2.4, opacity: 0.26, depth: 'far'  },
      { r: 360, tier: 'outer', sw: 2.0, opacity: 0.46, depth: 'mid'  },
      { r: 280, tier: 'mid',   sw: 1.7, opacity: 0.78, depth: 'near' },
    ],
    accents: [
      { cx: side === 'right' ? 80 : 320, cy: 600, rx: 130, ry: 105, sw: 1.3 },
    ],
  };
}

function getVariant(opts: RingOptions): VariantDef {
  if (opts.variant === 'asymmetric') {
    return asymmetricVariant(opts.side ?? 'right');
  }
  return VARIANTS[opts.variant];
}

// ── Public exports ───────────────────────────────────────────────────────────

/**
 * Returns the SVG ring background as an HTML string. Caller wraps in a
 * `position:absolute;inset:0;pointer-events:none` container.
 *
 * Does NOT include the page's atmosphere/gradient base — call `buildAtmosphereBase()`
 * separately and layer this on top.
 *
 * If `pulse: true`, you must include `<style>${ringAnimationCSS(prefix, pulseCycles)}</style>`
 * in the rendered HTML page (the SVG embeds entrance + wave keyframes itself, but
 * pulse keyframes need to live in the page so they work alongside other page styles).
 */
export function buildRingBackground(prefix: string, opts: RingOptions): string {
  const v = getVariant(opts);
  const palette = opts.palette ?? 'blue';
  const entrance = opts.entrance ?? 'small';

  const ringGradientDefs = (['outer', 'mid', 'inner'] as const)
    .map(tier => `
      <linearGradient id="${prefix}Ring_${tier}" x1="20%" y1="10%" x2="80%" y2="90%">
        ${gradientStops(tier, palette)}
      </linearGradient>
    `).join('');

  const accentGradientDef = v.accents.length > 0 ? `
    <linearGradient id="${prefix}Acc" x1="0%" y1="0%" x2="100%" y2="100%">
      ${accentStops(palette)}
    </linearGradient>
  ` : '';

  const filterDefs = `
    <filter id="${prefix}Far"  x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="0.7"/>
    </filter>
    <filter id="${prefix}Near" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="2.5"/>
      <feOffset dx="1.5" dy="2.5" result="shadow"/>
      <feComponentTransfer in="shadow" result="shadowFaded">
        <feFuncA type="linear" slope="0.45"/>
      </feComponentTransfer>
      <feMerge>
        <feMergeNode in="shadowFaded"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  `;

  // Stagger by ascending radius (smallest r → delay 0, largest r → max delay).
  // Entrance stagger is bigger on 'large' so the bloom feels deliberate.
  // Wave stagger is fixed (innermost first → outermost last) — same map, used as
  // both `animation-delay` for entrance AND a CSS variable for the wave so the
  // ripple actually travels outward through the rings.
  const sortedByR = [...v.rings].sort((a, b) => a.r - b.r);
  const entranceStagger = entrance === 'large' ? 280 : 80;
  // Per-ring wave delay. Tighter stagger = more overlap = "flowing together" feel.
  // 140ms means peaks are only ~560ms apart across 5 rings (vs 1000ms at 250ms),
  // so the rings move almost in concert with just a hint of cascade.
  const WAVE_STAGGER_MS = 140;
  const ringDelay = new Map<RingDef, number>();
  const ringWaveDelay = new Map<RingDef, number>();
  sortedByR.forEach((ring, i) => {
    ringDelay.set(ring, i * entranceStagger);
    ringWaveDelay.set(ring, i * WAVE_STAGGER_MS);
  });
  const accentDelay = sortedByR.length * entranceStagger;
  const accentWaveDelay = sortedByR.length * WAVE_STAGGER_MS;

  // CRITICAL: entrance and wave animations live on SEPARATE nested <g> elements.
  // If they share an element, the wave's `animation` property REPLACES the entrance's
  // `animation: ... forwards`, killing the entrance's frozen end state. When the wave
  // ends (no forwards), opacity reverts to the .entrance class baseline of `opacity:0`
  // → rings flash blank. Nesting separates concerns: outer = opacity entrance,
  // inner = scale wave. Each owns one CSS animation property without conflict.
  const renderRing = (ring: RingDef, kind: 'farMid' | 'near') => {
    const filter = ring.depth === 'far'  ? ` filter="url(#${prefix}Far)"`
                 : ring.depth === 'near' ? ` filter="url(#${prefix}Near)"`
                 : '';
    const delay = ringDelay.get(ring) ?? 0;
    const waveDelay = ringWaveDelay.get(ring) ?? 0;
    const entranceClass = entrance === 'none' ? '' : `${prefix}-entrance`;
    const waveClass = `${prefix}-wave-${kind === 'near' ? 'near' : 'far'}`;
    return `
      <g class="${entranceClass}"
         style="transform-origin: ${v.cx}px ${v.cy}px;${entrance !== 'none' ? ` animation-delay: ${delay}ms;` : ''}">
        <g class="${waveClass}" style="transform-origin: ${v.cx}px ${v.cy}px; --wave-delay: ${waveDelay}ms;">
          <circle cx="${v.cx}" cy="${v.cy}" r="${ring.r}"
                  fill="none"
                  stroke="url(#${prefix}Ring_${ring.tier})"
                  stroke-width="${ring.sw}"
                  opacity="${ring.opacity}"${filter}/>
        </g>
      </g>
    `;
  };

  const farMidRings = v.rings.filter(r => r.depth !== 'near').map(r => renderRing(r, 'farMid')).join('');
  const nearRings   = v.rings.filter(r => r.depth === 'near').map(r => renderRing(r, 'near')).join('');

  const nearGroupAttrs = opts.pulse
    ? ` class="${prefix}-pulse" style="transform-origin: ${v.cx}px ${v.cy}px"`
    : '';

  const accentEllipses = v.accents.map(acc => {
    const entranceClass = entrance === 'none' ? '' : `${prefix}-entrance`;
    return `
      <g class="${entranceClass}"
         style="transform-origin: ${acc.cx}px ${acc.cy}px;${entrance !== 'none' ? ` animation-delay: ${accentDelay}ms;` : ''}">
        <g class="${prefix}-wave-far" style="transform-origin: ${acc.cx}px ${acc.cy}px; --wave-delay: ${accentWaveDelay}ms;">
          <ellipse cx="${acc.cx}" cy="${acc.cy}" rx="${acc.rx}" ry="${acc.ry}"
                   fill="none"
                   stroke="url(#${prefix}Acc)"
                   stroke-width="${acc.sw}"/>
        </g>
      </g>
    `;
  }).join('');

  // Entrance + wave keyframes embedded inside the SVG <style>.
  // 'large' = water-droplet (~2.0s, scale 0.22→1, 280ms stagger) — first-impression hero.
  //   Slower than the small entrance so the bloom feels deliberate, like a slow inhale.
  // 'small' = settle (~0.55s, scale 0.85→1, 80ms stagger) — fast and unobtrusive.
  // Wave    = triggered manually via triggerRingWave() — TRAVELLING ripple that
  //           propagates inner→outer (per-ring delay via --wave-delay var).
  //           Scale peak hits at 30% of the animation (fast expand), then settles
  //           back over the remaining 70% so slowly the eye doesn't catch a snap.
  //           Far rings expand to 1.10, near rings to 1.16 — foreground gets the
  //           strongest pulse + parallax depth.
  const entranceKeyframes = entrance === 'large' ? `
    @keyframes ${prefix}Entrance {
      from { opacity: 0; transform: scale(0.22); }
      to   { opacity: 1; transform: scale(1); }
    }
    .${prefix}-entrance {
      opacity: 0;
      animation: ${prefix}Entrance 2.0s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    @media (prefers-reduced-motion: reduce) {
      .${prefix}-entrance { opacity: 1; animation: none; transform: none; }
    }
  ` : entrance === 'small' ? `
    @keyframes ${prefix}Entrance {
      from { opacity: 0; transform: scale(0.85); }
      to   { opacity: 1; transform: scale(1); }
    }
    .${prefix}-entrance {
      opacity: 0;
      animation: ${prefix}Entrance 0.55s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    @media (prefers-reduced-motion: reduce) {
      .${prefix}-entrance { opacity: 1; animation: none; transform: none; }
    }
  ` : '';

  // Wave keyframes. Rings expand FAR outward (scale 1.8 / 2.4) and fade to invisible
  // at 45%. The snap back to scale 1 happens during 45%-58% while opacity is 0 — a
  // wide silent window so no eye can catch the contraction. Then opacity fades back
  // in over 58%-100% with ease-in-out for a graceful settle (no snap-to-static).
  //
  // Per-keyframe `animation-timing-function`:
  //   • 0%→45%   — strong ease-out for the dramatic outward push
  //   • 45%→58%  — linear, doesn't matter (invisible)
  //   • 58%→100% — ease-in-out for smooth, gradual fade-in (the bit that was "snappy")
  //
  // Total 3.6s — slow enough to be deliberate. Per-ring delay via --wave-delay var.
  const waveKeyframes = `
    @keyframes ${prefix}WaveFar {
      0%   { transform: scale(1);   opacity: 1; animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      45%  { transform: scale(1.8); opacity: 0; animation-timing-function: linear; }
      58%  { transform: scale(1);   opacity: 0; animation-timing-function: cubic-bezier(0.42, 0, 0.58, 1); }
      100% { transform: scale(1);   opacity: 1; }
    }
    @keyframes ${prefix}WaveNear {
      0%   { transform: scale(1);   opacity: 1; animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
      45%  { transform: scale(2.4); opacity: 0; animation-timing-function: linear; }
      58%  { transform: scale(1);   opacity: 0; animation-timing-function: cubic-bezier(0.42, 0, 0.58, 1); }
      100% { transform: scale(1);   opacity: 1; }
    }
    .${prefix}-wave-active .${prefix}-wave-far  { animation: ${prefix}WaveFar  3.6s linear var(--wave-delay, 0ms); }
    .${prefix}-wave-active .${prefix}-wave-near { animation: ${prefix}WaveNear 3.6s linear var(--wave-delay, 0ms); }

    /* Click-triggered phantom — small ring emerges from centre alongside the wave */
    @keyframes ${prefix}WaveBirth {
      0%   { transform: scale(0.2); opacity: 0; }
      30%  { transform: scale(0.6); opacity: 0.55; }
      100% { transform: scale(1.6); opacity: 0; }
    }
    .${prefix}-wave-active .${prefix}-wave-birth {
      animation: ${prefix}WaveBirth 3.2s cubic-bezier(0.4, 0, 0.6, 1);
    }
    @media (prefers-reduced-motion: reduce) {
      .${prefix}-wave-active .${prefix}-wave-far,
      .${prefix}-wave-active .${prefix}-wave-near,
      .${prefix}-wave-active .${prefix}-wave-birth { animation: none; }
    }
  `;

  // Drift ring — single ambient ripple on arrival, only added when pulse is enabled
  // (hero pages: intro slides, plan-preview, stats/plan/forecast tabs). A phantom
  // circle expands outward from centre and fades over 6.5s, then disappears.
  // One-shot — used to be `infinite` but constant motion is bad for iOS battery
  // and accessibility. Page should feel alive on arrival, not perpetually moving.
  const driftKeyframes = opts.pulse ? `
    @keyframes ${prefix}Drift {
      0%   { transform: scale(0.4); opacity: 0; }
      15%  { opacity: 0.55; }
      100% { transform: scale(6); opacity: 0; }
    }
    .${prefix}-drift {
      transform-origin: ${v.cx}px ${v.cy}px;
      animation: ${prefix}Drift 6.5s cubic-bezier(0.4, 0, 0.6, 1) 1 forwards;
    }
    @media (prefers-reduced-motion: reduce) {
      .${prefix}-drift { animation: none; opacity: 0; }
    }
  ` : '';

  const driftElement = opts.pulse ? `
    <circle class="${prefix}-drift"
            cx="${v.cx}" cy="${v.cy}"
            r="60" fill="none"
            stroke="url(#${prefix}Ring_mid)" stroke-width="1.4"/>
  ` : '';

  // Click-triggered phantom — a small "fresh" ring that emerges from centre
  // when the wave fires. Sits behind the rings as they push outward, so it
  // looks like a new ripple is being born to replace the ones flying off.
  // Only rendered alongside drift (i.e. on hero pages with pulse:true).
  const birthElement = opts.pulse ? `
    <g style="transform-origin: ${v.cx}px ${v.cy}px;">
      <circle class="${prefix}-wave-birth"
              cx="${v.cx}" cy="${v.cy}"
              r="80" fill="none"
              stroke="url(#${prefix}Ring_inner)" stroke-width="1.6"
              style="transform-origin: ${v.cx}px ${v.cy}px;"
              opacity="0"/>
    </g>
  ` : '';

  return `
    <svg class="${prefix}-ring-svg" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"
         viewBox="0 0 400 800" preserveAspectRatio="xMidYMid slice"
         xmlns="http://www.w3.org/2000/svg">
      <defs>
        ${ringGradientDefs}
        ${accentGradientDef}
        ${filterDefs}
      </defs>
      <style>${entranceKeyframes}${waveKeyframes}${driftKeyframes}</style>
      ${driftElement}
      ${birthElement}
      ${farMidRings}
      <g${nearGroupAttrs}>
        ${nearRings}
      </g>
      ${accentEllipses}
    </svg>
  `;
}

/**
 * CSS keyframes for the ring pulse animation. Inject inside a `<style>` block
 * on the same page that uses `pulse: true`.
 *
 * Single 9s opacity breath (1 → 1.32 → 1) on arrival, then holds at baseline.
 * Pairs with the auto-added drift ring (also one-shot when `pulse: true`) —
 * together they form the "exhale on arrival" layer that wakes the page up
 * without animating forever. Disabled entirely under `prefers-reduced-motion`.
 */
export function ringAnimationCSS(prefix: string): string {
  return `
    @keyframes ${prefix}Pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 1.32; }
    }
    .${prefix}-pulse {
      animation: ${prefix}Pulse 9s ease-in-out 1 forwards;
    }
    @media (prefers-reduced-motion: reduce) {
      .${prefix}-pulse { animation: none; }
    }
  `;
}

/**
 * Atmospheric base — soft cool radial gradient that gives the rings something
 * to "live in", instead of sitting on flat warm cream. Apply as the bottom layer
 * of the background stack on any page using rings.
 *
 * Layering order: atmosphere (this) → rings → sun glint → content.
 */
export function buildAtmosphereBase(palette: RingPalette = 'blue'): string {
  return `<div style="position:absolute;inset:0;background:${ATMOSPHERE_GRADIENTS[palette]}"></div>`;
}

/** CSS gradient string for a given atmosphere palette — use as the page-root background
 *  so the atmospheric feel continues below the 480 px SVG fold when scrolling. */
export function atmosphereGradient(palette: RingPalette = 'blue'): string {
  return ATMOSPHERE_GRADIENTS[palette];
}

/**
 * Sun glint — warm cream radial-gradient at upper-left of the page.
 * The universal brand mark across every page in the app.
 *
 * Always upper-left for a consistent light source. Three intensities:
 *   • low  — Home, Plan, Stats, detail pages (alongside mountain background)
 *   • mid  — wizard steps (alongside ring background)
 *   • high — hero / celebration moments only
 */
export function buildSunGlint(intensity: GlintIntensity = 'mid'): string {
  const op = GLINT_OPACITY[intensity];
  return `
    <div aria-hidden="true"
         style="position:absolute;top:0;left:0;width:560px;height:560px;
                pointer-events:none;z-index:1;
                background:radial-gradient(ellipse 65% 65% at 18% 18%,
                  rgba(255,248,229,${op.core}) 0%,
                  rgba(255,248,229,${op.halo}) 30%,
                  transparent 70%);
                max-width:100vw;max-height:100vh"></div>
  `;
}

// ── First-launch tracking ────────────────────────────────────────────────────

const FIRST_LAUNCH_KEY = 'mosaic_has_seen_ring_intro';

/**
 * Returns true if the user has never seen the rings before on this device.
 * Used to gate the large entrance animation + the welcome haptic — both
 * happen exactly once per device install, then it's always small/quiet.
 */
export function isFirstRingExperience(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return !localStorage.getItem(FIRST_LAUNCH_KEY);
  } catch {
    return false;
  }
}

/** Marks the user as having seen the rings. Call once after the first hero render. */
export function markRingExperienceSeen(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(FIRST_LAUNCH_KEY, '1');
  } catch {
    // localStorage unavailable — silent fail
  }
}

// ── Haptic feedback (iOS native only) ────────────────────────────────────────

/**
 * Fires a single light haptic tap on iOS via the Capacitor Haptics plugin.
 * Silently no-ops on web and on platforms without the plugin.
 *
 * Currently used only on the first-ever ring entrance to accompany the large
 * water-droplet ripple. Subsequent (small) entrances do not haptic.
 */
export async function triggerRingEntranceHaptic(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) return;
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Plugin unavailable or platform not supported — silent fail
  }
}

// ── Wave pulse trigger (for slide transitions etc) ───────────────────────────

/**
 * Triggers the outward wave + birth-ring on a persistent ring SVG. Use when
 * navigating between contexts that share the same ring background (e.g. intro
 * slide transitions). Each ring pushes outward, fades to invisible, snaps back
 * silently, then fades in at base. A small "birth" phantom emerges from the
 * centre alongside the outward wave so it reads as a fresh ripple replacing
 * the ones that flew off.
 *
 * **Debounced**: if a wave is already in progress, subsequent calls are ignored
 * until the current wave completes. This prevents jarring restarts when the
 * user clicks Next rapidly through slides.
 *
 * Prefix must match the prefix used when calling `buildRingBackground(prefix, ...)`.
 */
export function triggerRingWave(prefix: string): void {
  if (typeof document === 'undefined') return;
  const svg = document.querySelector(`.${prefix}-ring-svg`);
  if (!svg) return;
  // Debounce: if wave is mid-flight, let it complete naturally rather than restart.
  if (svg.classList.contains(`${prefix}-wave-active`)) return;
  svg.classList.add(`${prefix}-wave-active`);
  // Remove after the longest staggered wave completes so it can fire again later.
  // 5 rings × 140ms stagger + 3.6s anim + buffer = ~4.5s.
  setTimeout(() => svg.classList.remove(`${prefix}-wave-active`), 4500);
}

// ── Flowey wave background (replacement for sky-background.ts mountains) ────
//
// Shares the page-flair DNA: gradient stroke recipe (light upper-left → mid →
// dark lower-right), atmospheric depth (far layers blurred), subtle continuous
// motion (each layer drifts horizontally on a different cycle for parallax).
//
// Replaces the angular mountain peaks of sky-background.ts with smooth
// horizontal wave layers — softer, more contemporary, sibling to the rings.

/**
 * Returns the full HTML for the flowey detail-page background — sky gradient
 * base + 4 stacked WAVE LAYERS in the page's signature colour, plus a clean
 * top fade so nothing touches the screen edge.
 *
 * Each wave is a colour-prominent fill (page palette mid colour at decreasing
 * opacity from near to far) with a gradient stroke on its top edge (same
 * gradient recipe as the wizard rings — light highlight upper-left → mid →
 * shadow). The stroke is what makes the waves recognisable as siblings of
 * the rings; the fill is what makes the page colour-focused.
 *
 * Caller wraps in a relative container at z-index 0. Layer the sun glint on
 * top separately. Pair with `floweyAnimationCSS(prefix)` for per-layer drift.
 */
export function buildFloweyBackground(prefix: string, palette: RingPalette = 'blue'): string {
  const hex = RING_PALETTES[palette];
  const skyTop    = ATMOSPHERE_GRADIENTS[palette].match(/#[0-9A-F]{6}/i)?.[0] ?? '#E6EEF7';
  const skyMidHex = pickSkyHex(palette, 'mid');
  const skyBotHex = pickSkyHex(palette, 'bottom');

  // Wave layers — far/blurred at top with low colour opacity, near/sharp at
  // bottom with high colour opacity. The page colour visually anchors the page.
  // Top of each wave is curved horizontally; bottom is closed at the SVG floor.
  const WAVES = [
    { yBase: 130, amp: 18, fillOp: 0.10, strokeOp: 0.45, blur: 'far',  cls: 'w1' },
    { yBase: 200, amp: 24, fillOp: 0.18, strokeOp: 0.60, blur: 'far',  cls: 'w2' },
    { yBase: 270, amp: 30, fillOp: 0.30, strokeOp: 0.78, blur: 'mid',  cls: 'w3' },
    { yBase: 340, amp: 36, fillOp: 0.50, strokeOp: 1.00, blur: 'none', cls: 'w4' },
  ];

  // Build a smooth wave path. Cubic-spline-ish via Q+T quadratic curves.
  // Going off-canvas left/right (-40, 440) ensures clean edges at the viewport.
  const wavePath = (y: number, amp: number, phase = 0) => {
    const a = amp;
    const p1y = y - a + phase;
    const p2y = y + a + phase;
    return `M-40,${y + a/2} Q80,${p1y} 200,${y + a/2 - 6} T440,${p2y - 12} L440,480 L-40,480 Z`;
  };

  return `
    <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
      <svg style="width:100%;height:100%" viewBox="0 0 400 480" preserveAspectRatio="xMidYMid slice"
           xmlns="http://www.w3.org/2000/svg">
        <defs>
          <!-- Sky base -->
          <linearGradient id="${prefix}FlSky" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"  stop-color="${skyTop}"/>
            <stop offset="40%" stop-color="${skyMidHex}"/>
            <stop offset="80%" stop-color="${skyBotHex}"/>
            <stop offset="100%" stop-color="${skyBotHex}"/>
          </linearGradient>

          <!-- Same gradient stroke recipe as the wizard rings — the visual sibling link -->
          <linearGradient id="${prefix}FlStroke" x1="20%" y1="10%" x2="80%" y2="90%">
            <stop offset="0%"  stop-color="${hex.highlight}" stop-opacity="0.85"/>
            <stop offset="50%" stop-color="${hex.mid}"       stop-opacity="0.70"/>
            <stop offset="100%" stop-color="${hex.shadow}"   stop-opacity="0.30"/>
          </linearGradient>

          <!-- Atmospheric blur for far layers — same recipe as ring filters -->
          <filter id="${prefix}FlBlurFar" x="-5%" y="-5%" width="110%" height="110%">
            <feGaussianBlur stdDeviation="1.4"/>
          </filter>
          <filter id="${prefix}FlBlurMid" x="-5%" y="-5%" width="110%" height="110%">
            <feGaussianBlur stdDeviation="0.6"/>
          </filter>

          <!-- Top fade so waves don't touch the screen edge — fades from sky-top to transparent -->
          <linearGradient id="${prefix}FlTopFade" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="${skyTop}" stop-opacity="1"/>
            <stop offset="100%" stop-color="${skyTop}" stop-opacity="0"/>
          </linearGradient>

          <!-- Bottom fade so background dissolves into the page -->
          <linearGradient id="${prefix}FlBotFade" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="${skyBotHex}" stop-opacity="0"/>
            <stop offset="100%" stop-color="${skyBotHex}" stop-opacity="1"/>
          </linearGradient>
        </defs>

        <!-- Sky base -->
        <rect width="100%" height="100%" fill="url(#${prefix}FlSky)"/>

        <!-- Wave layers — colour-prominent fill + gradient stroke on top edge -->
        ${WAVES.map(w => {
          const filter = w.blur === 'far'  ? ` filter="url(#${prefix}FlBlurFar)"`
                       : w.blur === 'mid'  ? ` filter="url(#${prefix}FlBlurMid)"`
                       : '';
          return `
            <g class="${prefix}-${w.cls}">
              <path d="${wavePath(w.yBase, w.amp)}"
                    fill="${hex.mid}" fill-opacity="${w.fillOp}"
                    stroke="url(#${prefix}FlStroke)" stroke-width="1.5"
                    stroke-opacity="${w.strokeOp}"${filter}/>
            </g>
          `;
        }).join('')}

        <!-- Top fade — keeps top wave from touching the screen edge -->
        <rect x="0" y="0" width="400" height="80" fill="url(#${prefix}FlTopFade)"/>

        <!-- Bottom fade — starts before the lowest wave stroke for a smooth dissolve -->
        <rect x="0" y="280" width="400" height="200" fill="url(#${prefix}FlBotFade)"/>
      </svg>
    </div>
  `;
}

/** Helper: extract a sky stop colour from the atmosphere gradient string by index. */
function pickSkyHex(palette: RingPalette, position: 'top' | 'mid' | 'bottom'): string {
  const matches = ATMOSPHERE_GRADIENTS[palette].match(/#[0-9A-F]{6}/gi) ?? [];
  if (position === 'top')    return matches[0] ?? '#E6EEF7';
  if (position === 'mid')    return matches[1] ?? '#EDF3F9';
  return matches[2] ?? '#F5F7FA';
}

// ── Flowey HALO variant — alternative to the wave version ──────────────────
// Used on pages where rings RADIATING from behind the hero data ring is more
// thematic than horizontal waves. Currently used only on Readiness, where the
// halo concept lands as "background rings echoing the score ring".

interface FloweyHaloOptions {
  /** Where the halo centre sits in the 400×480 viewBox. Should align with the
   *  page's hero data ring. Default (200, 240). */
  haloCenter?: { cx: number; cy: number };
  /** Where the inner halo ring starts (just outside the hero data ring's outer edge).
   *  Default 175 — sized to clear a typical hero ring. */
  haloInnerR?: number;
  /** Whether to also include the off-axis "drift" accent ellipses at the corners.
   *  Adds organic asymmetry. Default true. */
  driftAccents?: boolean;
}

/**
 * Halo variant of the flowey background — sky base + concentric rings radiating
 * from behind the page's hero data ring + off-axis accent ellipses for organic
 * composition. Use this on pages where the data ring IS the focal point and the
 * background should echo it (e.g. Readiness).
 *
 * Same DNA as buildFloweyBackground (waves): same sky palette, gradient stroke
 * recipe, atmospheric depth filters. Just composed as concentric arcs around a
 * point instead of horizontal layers.
 */
export function buildFloweyHaloBackground(
  prefix: string,
  palette: RingPalette = 'blue',
  opts: FloweyHaloOptions = {},
): string {
  const skyTop    = pickSkyHex(palette, 'top');
  const skyMidHex = pickSkyHex(palette, 'mid');
  const skyBotHex = pickSkyHex(palette, 'bottom');

  const center = opts.haloCenter ?? { cx: 200, cy: 240 };
  const innerR = opts.haloInnerR ?? 175;
  const driftAccents = opts.driftAccents ?? true;

  const RINGS = [
    { r: innerR,        tier: 'inner' as const, sw: 1.5, opacity: 1.00, depth: 'near' as const, cls: 'h1' },
    { r: innerR + 60,   tier: 'mid'   as const, sw: 1.7, opacity: 0.85, depth: 'mid'  as const, cls: 'h2' },
    { r: innerR + 130,  tier: 'mid'   as const, sw: 1.9, opacity: 0.65, depth: 'mid'  as const, cls: 'h3' },
    { r: innerR + 210,  tier: 'outer' as const, sw: 2.2, opacity: 0.45, depth: 'far'  as const, cls: 'h4' },
    { r: innerR + 300,  tier: 'outer' as const, sw: 2.4, opacity: 0.28, depth: 'far'  as const, cls: 'h5' },
  ];

  const ACCENTS = driftAccents ? [
    { cx: 70,  cy: 90,  rx: 130, ry: 100, sw: 1.3, cls: 'a1' },
    { cx: 360, cy: 410, rx: 140, ry: 110, sw: 1.3, cls: 'a2' },
  ] : [];

  return `
    <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
      <svg style="width:100%;height:100%" viewBox="0 0 400 480" preserveAspectRatio="xMidYMid slice"
           xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="${prefix}HSky" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"  stop-color="${skyTop}"/>
            <stop offset="40%" stop-color="${skyMidHex}"/>
            <stop offset="80%" stop-color="${skyBotHex}"/>
            <stop offset="100%" stop-color="${skyBotHex}"/>
          </linearGradient>

          <linearGradient id="${prefix}HRing_outer" x1="20%" y1="10%" x2="80%" y2="90%">
            ${gradientStops('outer', palette)}
          </linearGradient>
          <linearGradient id="${prefix}HRing_mid" x1="20%" y1="10%" x2="80%" y2="90%">
            ${gradientStops('mid', palette)}
          </linearGradient>
          <linearGradient id="${prefix}HRing_inner" x1="20%" y1="10%" x2="80%" y2="90%">
            ${gradientStops('inner', palette)}
          </linearGradient>
          <linearGradient id="${prefix}HAcc" x1="0%" y1="0%" x2="100%" y2="100%">
            ${accentStops(palette)}
          </linearGradient>

          <filter id="${prefix}HFar" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="1.0"/>
          </filter>

          <linearGradient id="${prefix}HFade" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="${skyBotHex}" stop-opacity="0"/>
            <stop offset="100%" stop-color="${skyBotHex}" stop-opacity="1"/>
          </linearGradient>
        </defs>

        <rect width="100%" height="100%" fill="url(#${prefix}HSky)"/>

        ${RINGS.map(r => {
          const filter = r.depth === 'far' ? ` filter="url(#${prefix}HFar)"` : '';
          return `
            <g class="${prefix}-${r.cls}" style="transform-origin: ${center.cx}px ${center.cy}px;">
              <circle cx="${center.cx}" cy="${center.cy}" r="${r.r}"
                      fill="none"
                      stroke="url(#${prefix}HRing_${r.tier})"
                      stroke-width="${r.sw}"
                      opacity="${r.opacity}"${filter}/>
            </g>
          `;
        }).join('')}

        ${ACCENTS.map(a => `
          <g class="${prefix}-${a.cls}" style="transform-origin: ${a.cx}px ${a.cy}px;">
            <ellipse cx="${a.cx}" cy="${a.cy}" rx="${a.rx}" ry="${a.ry}"
                     fill="none"
                     stroke="url(#${prefix}HAcc)"
                     stroke-width="${a.sw}"/>
          </g>
        `).join('')}

        <rect x="0" y="280" width="400" height="200" fill="url(#${prefix}HFade)"/>
      </svg>
    </div>
  `;
}

/** Animation CSS for the halo variant — single scale breathe per ring + one
 *  accent drift cycle on arrival, then everything holds still. Disabled
 *  entirely under `prefers-reduced-motion`. */
export function floweyHaloAnimationCSS(prefix: string): string {
  return `
    @keyframes ${prefix}HBreathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.012); } }
    @keyframes ${prefix}HDrift { 0%,100% { transform: translate(0,0); } 50% { transform: translate(6px,-3px); } }
    .${prefix}-h1 { animation: ${prefix}HBreathe 11s ease-in-out 1 forwards; }
    .${prefix}-h2 { animation: ${prefix}HBreathe 13s ease-in-out 1 forwards; }
    .${prefix}-h3 { animation: ${prefix}HBreathe 15s ease-in-out 1 forwards; }
    .${prefix}-h4 { animation: ${prefix}HBreathe 17s ease-in-out 1 forwards; }
    .${prefix}-h5 { animation: ${prefix}HBreathe 19s ease-in-out 1 forwards; }
    .${prefix}-a1 { animation: ${prefix}HDrift 24s ease-in-out 1 forwards; }
    .${prefix}-a2 { animation: ${prefix}HDrift 28s ease-in-out 1 reverse forwards; }
    @media (prefers-reduced-motion: reduce) {
      .${prefix}-h1, .${prefix}-h2, .${prefix}-h3, .${prefix}-h4, .${prefix}-h5,
      .${prefix}-a1, .${prefix}-a2 { animation: none; }
    }
  `;
}

// ── Scroll-page atmospheric background — for full-page scrollable pages ────
// Designed for Home / Plan / Stats / Account where the page is taller than the
// 480px detail-page hero. Continuous atmosphere gradient with no hard cutoff,
// plus soft halo rings spread across more vertical space. Reads as a calm
// chill backdrop that the page floats over.

interface ScrollAtmosphereOptions {
  /** Where the soft halo sits in the 400×800 viewBox. Default centred at (200, 320).
   *  Pages can shift this for differentiation — e.g. home uses (320, 200) to put
   *  the halo upper-right, balancing the upper-left sun glint. */
  haloCenter?: { cx: number; cy: number };
}

/**
 * Returns a continuous atmospheric background for tall scrollable pages.
 * Atmosphere gradient fills 100% of parent (no hard bottom edge). Halo rings
 * are larger + softer + spread out so they cover the upper-mid region as a
 * gentle backdrop rather than a tight hero halo.
 *
 * Caller wraps with `position:relative` (the mosaic-page already does). Pair
 * with `floweyHaloAnimationCSS(prefix)` for the breathe + drift.
 */
export function buildScrollAtmosphereBackground(
  prefix: string,
  palette: RingPalette = 'blue',
  opts: ScrollAtmosphereOptions = {},
): string {
  // Soft halo — rings positioned in upper-mid, larger and spread further apart
  // for a "wallpaper" feel instead of a focused halo. Lower opacities = chill.
  const RINGS = [
    { r: 200, tier: 'inner' as const, sw: 1.4, opacity: 0.55, depth: 'near' as const, cls: 'h1' },
    { r: 320, tier: 'mid'   as const, sw: 1.6, opacity: 0.42, depth: 'mid'  as const, cls: 'h2' },
    { r: 460, tier: 'mid'   as const, sw: 1.8, opacity: 0.30, depth: 'mid'  as const, cls: 'h3' },
    { r: 620, tier: 'outer' as const, sw: 2.0, opacity: 0.20, depth: 'far'  as const, cls: 'h4' },
    { r: 800, tier: 'outer' as const, sw: 2.2, opacity: 0.12, depth: 'far'  as const, cls: 'h5' },
  ];
  const ACCENTS = [
    { cx: 80,  cy: 120, rx: 180, ry: 130, sw: 1.3, cls: 'a1' },
    { cx: 380, cy: 600, rx: 200, ry: 150, sw: 1.3, cls: 'a2' },
  ];
  const center = opts.haloCenter ?? { cx: 200, cy: 320 };

  return `
    <!-- Continuous atmosphere — fills the entire scrollable parent. No hard 480px cutoff. -->
    <div style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0;background:${ATMOSPHERE_GRADIENTS[palette]}">
      <!-- Soft halo SVG — taller viewBox so rings spread across more space.
           preserveAspectRatio="xMidYMin slice" anchors content at the top so as
           the user scrolls, the halo sits in the upper portion of the page. -->
      <svg style="position:absolute;top:0;left:0;width:100%;height:1100px;max-height:100%"
           viewBox="0 0 400 800" preserveAspectRatio="xMidYMin slice"
           xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="${prefix}HRing_outer" x1="20%" y1="10%" x2="80%" y2="90%">
            ${gradientStops('outer', palette)}
          </linearGradient>
          <linearGradient id="${prefix}HRing_mid" x1="20%" y1="10%" x2="80%" y2="90%">
            ${gradientStops('mid', palette)}
          </linearGradient>
          <linearGradient id="${prefix}HRing_inner" x1="20%" y1="10%" x2="80%" y2="90%">
            ${gradientStops('inner', palette)}
          </linearGradient>
          <linearGradient id="${prefix}HAcc" x1="0%" y1="0%" x2="100%" y2="100%">
            ${accentStops(palette)}
          </linearGradient>
          <filter id="${prefix}HSAFar" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="0.8"/>
          </filter>
          <filter id="${prefix}HSANear" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="2.5"/>
            <feOffset dx="1.5" dy="2.5" result="shadow"/>
            <feComponentTransfer in="shadow" result="shadowFaded">
              <feFuncA type="linear" slope="0.40"/>
            </feComponentTransfer>
            <feMerge>
              <feMergeNode in="shadowFaded"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>

        ${RINGS.map(r => {
          const filter = r.depth === 'far'  ? ` filter="url(#${prefix}HSAFar)"`
                       : r.depth === 'near' ? ` filter="url(#${prefix}HSANear)"`
                       : '';
          return `
            <g class="${prefix}-${r.cls}" style="transform-origin: ${center.cx}px ${center.cy}px;">
              <circle cx="${center.cx}" cy="${center.cy}" r="${r.r}"
                      fill="none"
                      stroke="url(#${prefix}HRing_${r.tier})"
                      stroke-width="${r.sw}"
                      opacity="${r.opacity}"${filter}/>
            </g>
          `;
        }).join('')}

        ${ACCENTS.map(a => `
          <g class="${prefix}-${a.cls}" style="transform-origin: ${a.cx}px ${a.cy}px;">
            <ellipse cx="${a.cx}" cy="${a.cy}" rx="${a.rx}" ry="${a.ry}"
                     fill="none"
                     stroke="url(#${prefix}HAcc)"
                     stroke-width="${a.sw}"/>
          </g>
        `).join('')}
      </svg>
    </div>
  `;
}

/**
 * CSS keyframes for the flowey wave drift. Each layer drifts horizontally
 * once on arrival and returns to its starting position — far layers take
 * longer than near layers, so the parallax cascade reads as a single tide
 * rolling in then settling. Disabled under `prefers-reduced-motion`.
 */
export function floweyAnimationCSS(prefix: string): string {
  return `
    @keyframes ${prefix}FlDriftR { 0%,100% { transform: translateX(0); } 50% { transform: translateX(10px); } }
    @keyframes ${prefix}FlDriftL { 0%,100% { transform: translateX(0); } 50% { transform: translateX(-9px); } }
    .${prefix}-w1 { animation: ${prefix}FlDriftR 26s ease-in-out 1 forwards; }
    .${prefix}-w2 { animation: ${prefix}FlDriftL 22s ease-in-out 1 forwards; }
    .${prefix}-w3 { animation: ${prefix}FlDriftR 18s ease-in-out 1 forwards; }
    .${prefix}-w4 { animation: ${prefix}FlDriftL 14s ease-in-out 1 forwards; }
    @media (prefers-reduced-motion: reduce) {
      .${prefix}-w1, .${prefix}-w2, .${prefix}-w3, .${prefix}-w4 { animation: none; }
    }
  `;
}
