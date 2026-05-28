/**
 * Coach eval suite — gated by RUN_COACH_EVAL=1 so accidental `npm test` doesn't
 * spend Anthropic credits. Run with:
 *
 *   npm run coach:eval
 *
 * Each scenario calls Anthropic directly with the live system prompt + tool
 * schema, then asserts against the expectation bundle. Pass/fail grid prints
 * at the end with total cost.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SCENARIOS } from './eval-scenarios';
import { assertResponse, callAnthropic, loadApiKey, tokenCost } from './eval-helpers';

const ENABLED = process.env.RUN_COACH_EVAL === '1';

interface ScenarioResult {
  name: string;
  passed: boolean;
  passes: string[];
  fails: string[];
  inputTokens: number;
  outputTokens: number;
  cost: number;
}
const results: ScenarioResult[] = [];

(ENABLED ? describe : describe.skip)('coach eval scenarios', () => {
  let apiKey: string;

  beforeAll(() => {
    apiKey = loadApiKey();
    console.log(`\n[coach-eval] running ${SCENARIOS.length} scenarios against Haiku\n`);
  });

  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const resp = await callAnthropic(apiKey, scenario);
      const { passes, fails } = assertResponse(resp, scenario.expect);
      const cost = tokenCost(resp.usage.input_tokens, resp.usage.output_tokens);

      results.push({
        name: scenario.name,
        passed: fails.length === 0,
        passes,
        fails,
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        cost,
      });

      if (fails.length > 0) {
        const failSummary = fails.join('\n   ');
        throw new Error(`${scenario.name} failed:\n   ${failSummary}\n\nAssistant text:\n${resp.text.slice(0, 600)}\n\nTool calls: ${JSON.stringify(resp.toolCalls)}`);
      }
    }, 30_000); // 30s timeout per scenario
  }

  afterAll(() => {
    // Pass/fail grid
    const passCount = results.filter(r => r.passed).length;
    const totalCost = results.reduce((s, r) => s + r.cost, 0);
    const totalIn = results.reduce((s, r) => s + r.inputTokens, 0);
    const totalOut = results.reduce((s, r) => s + r.outputTokens, 0);

    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│ COACH EVAL RESULTS                                          │');
    console.log('└─────────────────────────────────────────────────────────────┘');
    for (const r of results) {
      const status = r.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`${status} ${r.name.padEnd(34)} ${r.inputTokens}in / ${r.outputTokens}out  $${r.cost.toFixed(4)}`);
      if (!r.passed) {
        for (const f of r.fails) console.log(`   \x1b[31m-\x1b[0m ${f}`);
      }
    }
    console.log('─────────────────────────────────────────────────────────────');
    console.log(`Pass:  ${passCount}/${results.length}`);
    console.log(`Tokens: ${totalIn} in / ${totalOut} out`);
    console.log(`Total cost: $${totalCost.toFixed(4)}\n`);

    // Hard cost guard from the plan: fail the whole run if > $1
    if (totalCost > 1.0) {
      throw new Error(`Eval cost $${totalCost.toFixed(4)} exceeds $1 ceiling — investigate before re-running`);
    }
  });
});

if (!ENABLED) {
  describe.skip('coach eval (gated)', () => {
    it('set RUN_COACH_EVAL=1 to enable', () => { /* no-op */ });
  });
}
