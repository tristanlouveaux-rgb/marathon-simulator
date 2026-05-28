/**
 * eval-helpers.ts — utility surface for the coach eval harness.
 *
 * Each scenario is a TypeScript object that describes a coachContext, the user
 * message to send, and a bundle of expectations. `runScenario` calls Anthropic
 * directly (bypassing the edge function) with the same system prompt + tool
 * schema the live coach uses, then asserts against the expectation bundle.
 *
 * Why direct-to-Anthropic vs hitting the edge function?
 * - The thing we want to protect from regression is the *prompt*. The edge
 *   function plumbing (auth, rate limit, spend cap) is exercised daily by real
 *   sessions and doesn't drift like a prompt does.
 * - Direct calls remove a layer of flakiness from CI-style runs.
 * - The Mosaic API key sits in `.env.local` as `ANTHROPIC_API_KEY` (Vite reads it
 *   for dev; we read it here too).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COACH_TOOLS } from '../coach-tools';
// NOTE: tests the CLIENT copy of buildSystemPrompt — the canonical (server)
// copy lives in `supabase/functions/coach-chat/index.ts:buildSystemPromptServer`.
// The two must be kept in sync manually. If the eval suite passes but
// production fails, check that the server file's prompt template matches.
import { buildSystemPrompt } from '../coach-chat-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve repo root by walking up until we find package.json.
function repoRoot(): string {
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, 'package.json'))) return cur;
    cur = dirname(cur);
  }
  throw new Error('Could not locate repo root from ' + __dirname);
}

/** Read ANTHROPIC_API_KEY from env, falling back to .env.local. */
export function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const envPath = join(repoRoot(), '.env.local');
  if (existsSync(envPath)) {
    const txt = readFileSync(envPath, 'utf8');
    const m = txt.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  throw new Error(
    'ANTHROPIC_API_KEY not set. Add it to .env.local or export it before running coach:eval.',
  );
}

// ─── Scenario types ──────────────────────────────────────────────────────────

export interface ScenarioExpect {
  /** Tool name that should be invoked. null = no tool. */
  toolCalled?: string | null;
  /** Subset of args the tool call should contain (deep-equal on each key). */
  toolArgsInclude?: Record<string, unknown>;
  /** All listed strings must appear (case-insensitive) in the assistant text. */
  mustInclude?: string[];
  /** None of these strings may appear (case-insensitive) in the assistant text. */
  mustNotInclude?: string[];
  /** The text must include a <choices> block. */
  mustIncludeChoices?: boolean;
  /** The text must include a <confidence>high|medium|low</confidence> block. */
  mustIncludeConfidence?: boolean;
  /** If set, the confidence level must equal this value. */
  confidenceLevel?: 'high' | 'medium' | 'low';
  /** Text must contain at least one substring from this list (OR logic — used
   *  when ANY of several specific numbers from context would satisfy "cited evidence"). */
  mustIncludeAnyOf?: string[];
  /** Max total length of assistant text in chars. */
  maxTextLength?: number;
  /** Min length — guards against empty replies. */
  minTextLength?: number;
}

export interface Scenario {
  name: string;
  description: string;
  coachContext: Record<string, unknown>;
  userMessage: string;
  /** Force tool_choice: 'any' to match the client-side directive detector. */
  forceToolUse?: boolean;
  expect: ScenarioExpect;
}

// ─── Anthropic call ──────────────────────────────────────────────────────────

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;

interface AnthropicResponse {
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  usage: { input_tokens: number; output_tokens: number };
}

export async function callAnthropic(
  apiKey: string,
  scenario: Scenario,
): Promise<AnthropicResponse> {
  const systemPrompt = buildSystemPrompt(scenario.coachContext);

  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: scenario.userMessage }],
    tools: COACH_TOOLS,
  };
  if (scenario.forceToolUse) {
    body.tool_choice = { type: 'any' };
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  let text = '';
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const block of json.content) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block.type === 'tool_use' && block.name) {
      toolCalls.push({ name: block.name, input: block.input ?? {} });
    }
  }

  return { text, toolCalls, usage: json.usage };
}

// ─── Assertion helper ────────────────────────────────────────────────────────

export interface AssertResult {
  passes: string[];
  fails: string[];
}

export function assertResponse(resp: AnthropicResponse, expect: ScenarioExpect): AssertResult {
  const passes: string[] = [];
  const fails: string[] = [];

  // Tool called check
  if (expect.toolCalled !== undefined) {
    if (expect.toolCalled === null) {
      if (resp.toolCalls.length === 0) passes.push('no tool called (expected)');
      else fails.push(`expected no tool, got [${resp.toolCalls.map(t => t.name).join(', ')}]`);
    } else {
      const matched = resp.toolCalls.find(t => t.name === expect.toolCalled);
      if (matched) passes.push(`tool '${expect.toolCalled}' called`);
      else fails.push(`expected tool '${expect.toolCalled}', got [${resp.toolCalls.map(t => t.name).join(', ') || 'none'}]`);
    }
  }

  // Tool args include
  if (expect.toolArgsInclude && expect.toolCalled) {
    const matched = resp.toolCalls.find(t => t.name === expect.toolCalled);
    if (matched) {
      for (const [k, v] of Object.entries(expect.toolArgsInclude)) {
        const got = matched.input[k];
        const ok = typeof v === 'number' && typeof got === 'number'
          ? Math.abs(got - v) < 0.001
          : typeof v === 'string'
            ? String(got).toLowerCase() === v.toLowerCase()
            : JSON.stringify(got) === JSON.stringify(v);
        if (ok) passes.push(`tool.${k} = ${JSON.stringify(v)}`);
        else fails.push(`tool.${k} expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`);
      }
    }
  }

  // Must include
  if (expect.mustInclude) {
    const lower = resp.text.toLowerCase();
    for (const needle of expect.mustInclude) {
      if (lower.includes(needle.toLowerCase())) passes.push(`text includes '${needle}'`);
      else fails.push(`text missing '${needle}'`);
    }
  }

  // Must NOT include
  if (expect.mustNotInclude) {
    const lower = resp.text.toLowerCase();
    for (const banned of expect.mustNotInclude) {
      if (lower.includes(banned.toLowerCase())) fails.push(`text contains banned '${banned}'`);
      else passes.push(`text excludes '${banned}'`);
    }
  }

  // Choices block
  if (expect.mustIncludeChoices !== undefined) {
    const hasChoices = /<choices>[\s\S]*?<\/choices>/i.test(resp.text);
    if (expect.mustIncludeChoices === hasChoices) {
      passes.push(`<choices> ${hasChoices ? 'present' : 'absent'} (expected)`);
    } else {
      fails.push(`<choices> ${hasChoices ? 'present' : 'absent'} (expected ${expect.mustIncludeChoices ? 'present' : 'absent'})`);
    }
  }

  // Confidence block
  if (expect.mustIncludeConfidence !== undefined) {
    const confMatch = resp.text.match(/<confidence>\s*(high|medium|low)\s*<\/confidence>/i);
    if (expect.mustIncludeConfidence) {
      if (confMatch) passes.push(`<confidence> present (${confMatch[1].toLowerCase()})`);
      else fails.push('<confidence> block missing');
    } else {
      if (!confMatch) passes.push('<confidence> absent (expected)');
      else fails.push(`<confidence> present (expected absent)`);
    }
  }
  if (expect.confidenceLevel) {
    const confMatch = resp.text.match(/<confidence>\s*(high|medium|low)\s*<\/confidence>/i);
    if (confMatch && confMatch[1].toLowerCase() === expect.confidenceLevel) {
      passes.push(`confidence = ${expect.confidenceLevel}`);
    } else {
      fails.push(`confidence expected ${expect.confidenceLevel}, got ${confMatch ? confMatch[1] : 'none'}`);
    }
  }

  // Must include ANY of (OR logic — useful for "cited at least one number from context")
  if (expect.mustIncludeAnyOf) {
    const lower = resp.text.toLowerCase();
    const matched = expect.mustIncludeAnyOf.find(s => lower.includes(s.toLowerCase()));
    if (matched) passes.push(`text includes one of [${expect.mustIncludeAnyOf.slice(0, 3).join(', ')}...]: '${matched}'`);
    else fails.push(`text includes none of [${expect.mustIncludeAnyOf.join(', ')}]`);
  }

  // Length bounds
  if (expect.maxTextLength != null && resp.text.length > expect.maxTextLength) {
    fails.push(`text length ${resp.text.length} > max ${expect.maxTextLength}`);
  } else if (expect.maxTextLength != null) {
    passes.push(`text length ${resp.text.length} within max ${expect.maxTextLength}`);
  }
  if (expect.minTextLength != null && resp.text.length < expect.minTextLength) {
    fails.push(`text length ${resp.text.length} < min ${expect.minTextLength}`);
  } else if (expect.minTextLength != null) {
    passes.push(`text length ${resp.text.length} above min ${expect.minTextLength}`);
  }

  return { passes, fails };
}

// ─── Cost accounting ─────────────────────────────────────────────────────────

/** Haiku 4.5 pricing as of 2026-05-14. */
const HAIKU_INPUT_PER_MTOK = 1.0;   // USD
const HAIKU_OUTPUT_PER_MTOK = 5.0;  // USD

export function tokenCost(input: number, output: number): number {
  return (input / 1_000_000) * HAIKU_INPUT_PER_MTOK + (output / 1_000_000) * HAIKU_OUTPUT_PER_MTOK;
}
