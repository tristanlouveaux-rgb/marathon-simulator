/**
 * Body-map silhouette for a strength session summary.
 *
 * Draws a smooth front + back humanoid figure and tints the muscle regions the
 * session worked, shaded by relative volume (most-worked = full accent, lighter
 * where less). Single non-neutral colour (the app accent) used as the data hue,
 * with opacity carrying intensity — within the 2-colour visual budget. Unworked
 * regions stay neutral grey.
 *
 * Each figure is one connected silhouette: a head circle plus a single closed
 * outline path tracing shoulders → arms → torso → legs (no gaps between limbs,
 * which is what made the old rectangle-stack version read as crude). Both
 * figures share one local coordinate frame (centred on x=0, head top at y≈5,
 * feet at y≈185) and are positioned with a `translate`, so the muscle regions
 * are authored once against that frame.
 *
 * SVG holds geometry only. The viewBox keeps a fixed aspect ratio
 * (`preserveAspectRatio="xMidYMid meet"`, never `none`) so nothing stretches;
 * the figure labels ("Front" / "Back") are HTML, not SVG text. The worked-group
 * chips are rendered separately by the caller (strength-summary-card).
 *
 * Regions are deliberately schematic — recognisable, not anatomical. Each
 * muscle group maps to one or more region primitives (ellipse / rounded rect)
 * placed on the front or back figure in the shared local frame.
 */

import type { MuscleGroup, WorkedMuscleGroup } from '@/calculations/strength-muscle-groups';

/** A schematic region: which figure it sits on and its SVG element markup
 *  (without a fill — the renderer injects the fill so intensity can vary).
 *  Coordinates are in the shared local frame, centred on x=0. */
interface Region {
  side: 'front' | 'back';
  /** Returns the inner SVG markup for this region given a fill string. */
  shape: (fill: string) => string;
}

/**
 * Each muscle group is drawn as a hand-authored muscle-belly outline rather than
 * a plain ellipse/rect, so the figure reads as anatomy and not as floating
 * blobs. Paired muscles (quads, glutes, hamstrings, calves, the two rectus
 * columns of the core) author the LEFT side only; `paired()` mirrors it to the
 * right with `scale(-1,1)` about the figure's local centre (x=0). The small
 * centre gap left by the mirror is the real anatomical landmark — the gluteal
 * cleft on the glutes, the linea alba between the abdominal columns.
 *
 * Outlines are tuned to sit inside the silhouette envelope (see BODY_PATH
 * landmarks) so a tint never pokes past the limb edge.
 */

/** Left belly + its mirror image (right belly) for a paired muscle. */
function paired(d: string, f: string): string {
  return `<path d="${d}" fill="${f}"/><path d="${d}" fill="${f}" transform="scale(-1,1)"/>`;
}

// Quadriceps: broad at the hip, tapering to the knee with the vastus medialis
// bulge low on the inner edge (the classic teardrop).
const QUAD_L = 'M -13,113 C -15.5,121 -14.5,133 -12,142 C -10,147 -6.5,148 -5,143 C -3.5,135 -4,121 -5.5,114 C -8,110 -11,110 -13,113 Z';
// Hamstrings: long muscle belly down the back of the thigh, full at the top.
const HAM_L = 'M -13,116 C -15,125 -14,139 -11.5,147 C -10,150.5 -7.5,150 -6.5,146 C -5.5,139 -4.5,127 -5.5,117 C -7.5,113 -11,113 -13,116 Z';
// Gastrocnemius: two-headed calf, bellies high, tapering to the achilles.
const CALF_L = 'M -11.5,154 C -14,159 -13.5,168 -11,173 C -9.5,176 -8.2,175.5 -7.8,170 C -7,165 -5.5,161 -5.5,157 C -6,153.5 -10,152.5 -11.5,154 Z';
// Gluteus maximus: rounded mass; inner edge near centre forms the cleft.
const GLUTE_L = 'M -1.6,103 C -7,101 -14,103.5 -15,109 C -15.5,115 -12,121 -7,121 C -3.5,121 -1.6,118 -1.6,113 Z';
// One rectus-abdominis column; the mirror leaves the linea alba down the middle.
const CORE_L = 'M -8.5,67 C -9.7,76 -9.2,87 -7.2,93 C -5,95.5 -1.6,95.5 -1.2,92 C -1,84 -1,74 -1.4,68 C -4,64.5 -7,64.5 -8.5,67 Z';
// Upper back (trapezius + lats): broad at the shoulders, V-tapering to the
// waist. Symmetric, drawn whole.
const BACK = 'M 0,46 C -8,47 -13,52 -14,60 C -13,72 -10,84 -6,92 C -2,94 2,94 6,92 C 10,84 13,72 14,60 C 13,52 8,47 0,46 Z';

const REGIONS: Record<MuscleGroup, Region[]> = {
  core: [{ side: 'front', shape: f => paired(CORE_L, f) }],
  quads: [{ side: 'front', shape: f => paired(QUAD_L, f) }],
  glutes: [{ side: 'back', shape: f => paired(GLUTE_L, f) }],
  hamstrings: [{ side: 'back', shape: f => paired(HAM_L, f) }],
  calves: [{ side: 'back', shape: f => paired(CALF_L, f) }],
  back: [{ side: 'back', shape: f => `<path d="${BACK}" fill="${f}"/>` }],
};

const SILHOUETTE = '#E6E3DD';     // neutral figure fill
const SILHOUETTE_LINE = 'rgba(0,0,0,0.10)';

/**
 * One connected humanoid silhouette in the shared local frame (centre x=0).
 * Head is a circle; the body is a single closed outline traced clockwise from
 * the left side of the neck: out over the shoulder, down the outside of the arm
 * to the wrist, back up the inside of the arm, down the torso to the hip, down
 * the outside of the leg to the foot, up the inside to the crotch, then the
 * mirror image back up the right side.
 */
const BODY_PATH =
  'M -6,31 ' +
  'C -10,37 -21,39 -24,45 ' +            // left shoulder / deltoid
  'C -27,53 -26,62 -22,66 ' +            // outer upper arm
  'L -21,104 ' +                        // outer forearm
  'C -21,109 -16,109 -15.5,104 ' +      // round the wrist
  'L -15,67 ' +                         // inner arm up to armpit
  'C -14,80 -13.5,88 -13,95 ' +         // torso side to waist
  'L -16,109 ' +                        // hip flare
  'L -15,150 ' +                        // outer thigh to knee
  'L -13,185 ' +                        // outer shin to ankle
  'L -4.5,185 ' +                       // foot
  'L -3.5,150 ' +                       // inner shin up
  'L -2,111 ' +                         // inner thigh to crotch
  'L 0,108 ' +                          // crotch
  'L 2,111 ' +
  'L 3.5,150 ' +
  'L 4.5,185 ' +
  'L 13,185 ' +
  'L 15,150 ' +
  'L 16,109 ' +                         // right hip
  'L 13,95 ' +                          // right waist
  'C 13.5,88 14,80 15,67 ' +            // right torso up to armpit
  'L 15.5,104 ' +                       // inner right arm down
  'C 16,109 21,109 21,104 ' +           // round the wrist
  'L 22,66 ' +                          // outer right forearm/arm
  'C 26,62 27,53 24,45 ' +              // right deltoid / shoulder
  'C 21,39 10,37 6,31 ' +               // right neck
  'Z';

/** Base figure (head + connected body outline) for one side. */
function figure(): string {
  return `
    <g fill="${SILHOUETTE}" stroke="${SILHOUETTE_LINE}" stroke-width="1.25" stroke-linejoin="round">
      <circle cx="0" cy="18" r="13"/>
      <path d="${BODY_PATH}"/>
    </g>`;
}

/**
 * Render the body map. `worked` is the ordered list from
 * deriveWorkedMuscleGroups; intensity scales the accent opacity so the
 * dominant group reads strongest. Returns an HTML string (a wrapper div with
 * the SVG + the two figure captions).
 */
export function renderBodyMap(worked: WorkedMuscleGroup[]): string {
  const byGroup = new Map(worked.map(w => [w.group, w]));

  const overlay = (side: 'front' | 'back'): string => {
    let out = '';
    for (const [group, regions] of Object.entries(REGIONS) as Array<[MuscleGroup, Region[]]>) {
      const w = byGroup.get(group);
      if (!w) continue;
      // Opacity floor 0.35 so a lightly-worked group is still visible; the
      // most-worked group reaches ~0.92.
      const opacity = (0.35 + 0.57 * w.intensity).toFixed(2);
      const fill = `var(--c-accent)`;
      for (const region of regions) {
        if (region.side !== side) continue;
        out += `<g opacity="${opacity}">${region.shape(fill)}</g>`;
      }
    }
    return out;
  };

  // Front centred on x≈58, back on x≈162, both shifted down 8 so the head
  // clears the top edge. Local frame spans y≈5→185, x≈-27→27.
  return `
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
      <svg viewBox="0 0 220 200" width="100%" height="180" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Muscle groups worked">
        <g transform="translate(58,8)">${figure()}${overlay('front')}</g>
        <g transform="translate(162,8)">${figure()}${overlay('back')}</g>
      </svg>
      <div style="display:flex;width:100%;max-width:240px;justify-content:space-around">
        <span style="font-size:11px;color:var(--c-faint)">Front</span>
        <span style="font-size:11px;color:var(--c-faint)">Back</span>
      </div>
    </div>`;
}
