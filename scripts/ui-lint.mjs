#!/usr/bin/env node
/**
 * UI lint — scans src/ui/**\/*.ts for the four anti-patterns called out in
 * docs/UX_PATTERNS.md "Visual Constraints":
 *
 *   1. ALL-CAPS data labels  — `text-transform: uppercase` (only allowed on
 *      phase badges, which live in PHASE_BADGE_FILES)
 *   2. Heavy letter-spacing  — `letter-spacing: 0.05em+` on regular labels
 *   3. Tinted card backgrounds — `background: rgba(0,0,0,0.0X)` inline
 *   4. Blue accent buttons    — `background: var(--c-accent)` on raw buttons
 *      (allowed via `.m-btn-glass` / accent CTAs that go through CSS)
 *
 * Baseline mechanism: `scripts/ui-lint-baseline.json` snapshots the count of
 * each rule per file. The lint passes when every file's count is <= baseline.
 * Run `node scripts/ui-lint.mjs --update-baseline` to re-snapshot after
 * deliberately accepting changes.
 *
 * Why this exists: the UI Pre-flight checklist in CLAUDE.md kept getting
 * skipped under time pressure. This is a hard backstop.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UI_ROOT = join(ROOT, 'src/ui');
const BASELINE_PATH = join(ROOT, 'scripts/ui-lint-baseline.json');

const PHASE_BADGE_FILES = new Set([
  // Allowlist — files where ALL-CAPS / heavy letter-spacing is the existing
  // established phase-badge pattern. Add sparingly.
]);

const RULES = [
  {
    id: 'uppercase',
    label: 'ALL-CAPS data label (text-transform:uppercase)',
    test: (line) => /text-transform\s*:\s*uppercase/i.test(line),
    skipIf: (file) => PHASE_BADGE_FILES.has(file),
  },
  {
    id: 'letter-spacing',
    label: 'Heavy letter-spacing (>=0.05em) on a label',
    test: (line) => {
      const m = line.match(/letter-spacing\s*:\s*(\d*\.?\d+)\s*em/i);
      if (!m) return false;
      return parseFloat(m[1]) >= 0.05;
    },
    skipIf: (file) => PHASE_BADGE_FILES.has(file),
  },
  {
    id: 'tinted-bg',
    label: 'Tinted card background (background:rgba(0,0,0,0.0X))',
    test: (line) => /background\s*:\s*rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\.0\d/i.test(line),
  },
  {
    id: 'accent-button',
    label: 'Blue accent button (background:var(--c-accent))',
    test: (line) => /background\s*:\s*var\(--c-accent\)/i.test(line),
  },
  {
    // A full-screen takeover (fixed, inset:0, column layout) escapes the
    // body's safe-area padding, so its header renders under the iOS status
    // bar unless the overlay pads itself with env(safe-area-inset-top).
    // Centered modals/spinners are exempt — their content can't reach the
    // status bar. Real incident 2026-06-12: Match Activities Cancel/Save
    // buried behind the clock.
    id: 'takeover-no-safe-top',
    label: 'Full-screen takeover overlay missing env(safe-area-inset-top) top padding',
    // Content-level (not line-level): multi-line cssText template literals and
    // ['…'].join(';') styles would evade a per-line regex.
    testContent: (content) => {
      const hits = [];
      const isTakeover = (s) =>
        /position\s*:\s*fixed/i.test(s) &&
        /inset\s*:\s*0/i.test(s) &&
        /flex-direction\s*:\s*column/i.test(s) &&
        !/justify-content\s*:\s*center/i.test(s) &&
        !/safe-area-inset-top/i.test(s);
      const lineOf = (idx) => content.slice(0, idx).split('\n').length;
      const blockPatterns = [
        /style\s*=\s*"([^"]*)"/g,                   // HTML style attribute (may span lines)
        /\.cssText\s*=\s*(['"`])([\s\S]*?)\1/g,     // el.style.cssText = '…' / `…`
        /\.cssText\s*=\s*\[([\s\S]*?)\]\s*\.join/g, // el.style.cssText = ['…','…'].join(';')
      ];
      for (const re of blockPatterns) {
        for (const m of content.matchAll(re)) {
          const block = m[2] ?? m[1];
          if (!isTakeover(block)) continue;
          hits.push({ line: lineOf(m.index), text: block.replace(/\s+/g, ' ').trim().slice(0, 120) });
        }
      }
      // Tailwind variant of the same takeover signature
      for (const m of content.matchAll(/class(?:Name)?\s*=\s*(['"`])([\s\S]*?)\1/g)) {
        const cls = m[2];
        if (/\bfixed\b/.test(cls) && /\binset-0\b/.test(cls) && /\bflex-col\b/.test(cls) && !/\bjustify-center\b/.test(cls)) {
          hits.push({ line: lineOf(m.index), text: cls.replace(/\s+/g, ' ').trim().slice(0, 120) });
        }
      }
      return hits;
    },
  },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function scanFile(absPath) {
  const rel = relative(ROOT, absPath);
  const content = readFileSync(absPath, 'utf8');
  const lines = content.split('\n');
  const hits = []; // { rule, line, text }
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    for (const r of RULES) {
      if (r.skipIf?.(rel) || !r.test) continue;
      if (r.test(text)) hits.push({ rule: r.id, line: i + 1, text: text.trim() });
    }
  }
  for (const r of RULES) {
    if (!r.testContent || r.skipIf?.(rel)) continue;
    for (const h of r.testContent(content)) hits.push({ rule: r.id, ...h });
  }
  return { rel, hits };
}

function buildCounts(scanResults) {
  const counts = {};
  for (const { rel, hits } of scanResults) {
    if (!hits.length) continue;
    counts[rel] = {};
    for (const h of hits) counts[rel][h.rule] = (counts[rel][h.rule] || 0) + 1;
  }
  return counts;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

const updateBaseline = process.argv.includes('--update-baseline');

const files = walk(UI_ROOT);
const scanned = files.map(scanFile);
const currentCounts = buildCounts(scanned);

if (updateBaseline) {
  writeFileSync(BASELINE_PATH, JSON.stringify(currentCounts, null, 2) + '\n');
  const totalFiles = Object.keys(currentCounts).length;
  const totalHits = Object.values(currentCounts)
    .flatMap((m) => Object.values(m))
    .reduce((a, b) => a + b, 0);
  console.log(`ui-lint: baseline updated — ${totalFiles} files, ${totalHits} known violations.`);
  process.exit(0);
}

const baseline = loadBaseline();
const violations = []; // { rel, rule, currentCount, baselineCount, hits }

for (const { rel, hits } of scanned) {
  if (!hits.length) continue;
  const byRule = {};
  for (const h of hits) (byRule[h.rule] ??= []).push(h);
  for (const [rule, ruleHits] of Object.entries(byRule)) {
    const baseCount = baseline[rel]?.[rule] || 0;
    if (ruleHits.length > baseCount) {
      violations.push({ rel, rule, currentCount: ruleHits.length, baselineCount: baseCount, hits: ruleHits });
    }
  }
}

if (!violations.length) {
  process.exit(0);
}

console.error('\nui-lint: NEW UX_PATTERNS violations vs baseline:\n');
for (const v of violations) {
  const r = RULES.find((x) => x.id === v.rule);
  const overage = v.currentCount - v.baselineCount;
  console.error(`  ${v.rel}`);
  console.error(`    [${v.rule}] ${r.label}`);
  console.error(`    +${overage} new (was ${v.baselineCount}, now ${v.currentCount})`);
  for (const h of v.hits.slice(0, 6)) {
    console.error(`      ${v.rel}:${h.line}  ${h.text.slice(0, 100)}`);
  }
  console.error('');
}
console.error('Fix the new violations, or run `node scripts/ui-lint.mjs --update-baseline`');
console.error('if the change is deliberate (rare — see docs/UX_PATTERNS.md).\n');
process.exit(1);
