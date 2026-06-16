/**
 * ENTRY-MODULE ISOLATION GUARD.
 *
 * `src/main.ts` is the application entry point. It runs `bootstrap()` at module
 * load (it boots the whole app). Nothing else may import it.
 *
 * History (2026-06-15): six views and the onboarding `review` step imported two
 * small helpers (`isSimulatorMode`, `awaitStartupSyncs`) from `@/main`. Because
 * `main.ts` also imports the wizard controller, that closed a cycle —
 *   controller -> renderer -> review -> main.ts -> bootstrap() -> launchApp()
 *     -> initWizard() -> reads STEP_ORDER
 * When a wizard module was the evaluation entry point (a unit test importing one
 * step), `main.ts` evaluated mid-way through `controller.ts`, auto-fired
 * `bootstrap()`, and called `initWizard()` before `controller.ts` reached its
 * `STEP_ORDER` const: a temporal-dead-zone crash. The fix moved those helpers to
 * the leaf module `@/app/runtime`.
 *
 * This test makes the regression class unrepresentable: if any module imports
 * `@/main` again, the cycle (and the latent boot-on-import bug) is back. Put the
 * shared helper in a leaf module (`@/app/runtime` or similar), never in
 * `main.ts`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..');

/** Recursively collect every .ts file under src/, excluding the entry itself. */
function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, acc);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      // Skip test files: a test (like this one) may mention the '@/main' string
      // in a regex or comment without actually importing the entry module. Only
      // real source modules forming the import cycle matter.
      acc.push(full);
    }
  }
  return acc;
}

// Matches `from '@/main'`, `from './main'`, `from '../main'`, etc. — any path
// that resolves to the entry module, in static or dynamic-import position.
const MAIN_IMPORT = /from\s+['"](?:@\/main|(?:\.\.?\/)+main)['"]/;

describe('entry-module isolation — nothing imports @/main', () => {
  it('no module imports the auto-bootstrapping entry point', () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(SRC)) {
      if (file === path.join(SRC, 'main.ts')) continue; // the entry itself
      const text = fs.readFileSync(file, 'utf8');
      if (MAIN_IMPORT.test(text)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(
      offenders,
      `These modules import @/main, which runs bootstrap() at load and recreates ` +
        `the STEP_ORDER temporal-dead-zone cycle. Move the shared helper into a ` +
        `leaf module (e.g. @/app/runtime) instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
