# Coach evals

Regression tests for the AI Coach prompt + tool surface. Calls Anthropic directly with the live system prompt and tool schema, then asserts each scenario produced the expected behaviour.

## Why this exists

We changed the prompt repeatedly during the v2 and v3 sprints and only found regressions when Tristan noticed something broken. The eval suite locks the gains in: prompt changes that break a known scenario fail the run.

## Running

```bash
npm run coach:eval
```

Requires `ANTHROPIC_API_KEY` in `.env.local` (the same key used by the live edge function). Each run hits Haiku ~10 times and costs roughly **$0.05–$0.30** depending on response lengths.

Hard cost guard: the suite aborts if the run total crosses $1.

## Adding a scenario

Edit `eval-scenarios.ts`. Each scenario is a plain object:

```ts
{
  name: 'unique-id-kebab',
  description: 'One sentence explaining what this protects against',
  coachContext: baseTriContext,            // or override fields with spread
  userMessage: 'reduce Tuesday swim 30%',
  forceToolUse: true,                      // mirrors the client-side directive detector
  expect: {
    toolCalled: 'reduce_workout',          // null = no tool expected
    toolArgsInclude: { day: 'tuesday', reduction_pct: 30 },
    mustInclude: ['training'],             // substrings the text must contain (case-insensitive)
    mustNotInclude: ['ibuprofen'],         // substrings the text must NOT contain
    mustIncludeChoices: true,              // require the <choices>...</choices> block
    minTextLength: 30,
    maxTextLength: 400,
  },
}
```

## When to run

- **Before merging any change** to `coach-chat-client.ts` (system prompt), `coach-tools.ts` (tool schema or validation), or `coach-context-builder.ts` (payload shape).
- After Anthropic announces a new Haiku version, run before pinning it.
- Quarterly drift check even when nothing visibly changed.

## Why direct-to-Anthropic instead of the edge function

We want to protect the *prompt*. The edge function plumbing (auth, rate limit, spend cap) is exercised daily by real sessions; the prompt is the part that drifts silently. Direct calls also remove a layer of flakiness so the suite is reliable.

## What this doesn't cover

- Edge function plumbing (CORS, auth, rate limits, spend cap) — daily real-use covers this.
- Streaming behaviour (`<choices>` parsing in the client, chip rendering) — covered by manual dogfood.
- Multi-turn conversations — each scenario is single-shot. Multi-turn coverage is a future addition.
