import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CAPGO_READ_TYPES, ALL_READ_TYPES } from './appleHealthSync';

/**
 * Guard rail for the 2026-06-12 bug class: a single read identifier that the
 * @capgo/capacitor-health plugin can't map throws `invalidDataType` natively
 * BEFORE `requestAuthorization` runs, so iOS never shows the permission sheet
 * and Apple Health connect fails silently for every user.
 *
 * The plugin's `HealthDataType` is a TypeScript type (erased at runtime), so
 * the compiler already rejects a bad string in `ALL_READ_TYPES`. This test
 * adds the second half: it parses the plugin's SHIPPED `definitions.d.ts` and
 * asserts our runtime `CAPGO_READ_TYPES` mirror still matches it. A plugin
 * upgrade that renames or drops a type then fails the build here instead of
 * silently breaking the popup on device.
 */
describe('capgo read types stay in sync with the plugin', () => {
  /** Parse `export type HealthDataType = 'a' | 'b' | ...;` from the plugin's d.ts. */
  function pluginHealthDataTypes(): string[] {
    const dtsPath = fileURLToPath(
      new URL('../../node_modules/@capgo/capacitor-health/dist/esm/definitions.d.ts', import.meta.url),
    );
    const src = readFileSync(dtsPath, 'utf8');
    const m = src.match(/export type HealthDataType\s*=\s*([^;]+);/);
    if (!m) throw new Error('Could not find HealthDataType union in capgo definitions.d.ts');
    return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  }

  it('CAPGO_READ_TYPES equals the plugin union plus the special "workouts" identifier', () => {
    const pluginTypes = pluginHealthDataTypes();
    expect(pluginTypes.length).toBeGreaterThan(0);

    const expected = new Set([...pluginTypes, 'workouts']);
    const actual = new Set<string>(CAPGO_READ_TYPES);

    // Anything we list that the plugin no longer ships = the popup-killing bug.
    const unsupported = [...actual].filter(t => !expected.has(t));
    expect(unsupported, `read types the plugin can't map: ${unsupported.join(', ')}`).toEqual([]);

    // Anything the plugin ships that we dropped from the mirror = drift to fix.
    const missing = [...expected].filter(t => !actual.has(t));
    expect(missing, `plugin types missing from CAPGO_READ_TYPES: ${missing.join(', ')}`).toEqual([]);
  });

  it('every type we authorize is one the plugin can map', () => {
    const allowed = new Set<string>(CAPGO_READ_TYPES);
    for (const t of ALL_READ_TYPES) {
      expect(allowed.has(t), `ALL_READ_TYPES contains unsupported "${t}"`).toBe(true);
    }
  });

  it('still requests workout authorization (activity import reads HKWorkoutType)', () => {
    expect(ALL_READ_TYPES).toContain('workouts');
  });
});
