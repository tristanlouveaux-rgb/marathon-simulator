/**
 * coach-chat-client.ts
 * ====================
 * Streaming client for the coach-chat Supabase edge function.
 *
 * Reads Anthropic's SSE stream (proxied via our edge fn) and yields typed chunks:
 *   { type: 'text', delta: string }
 *   { type: 'tool_use', name: string, input: Record<string, unknown> }
 *   { type: 'done' }
 *   { type: 'error', message: string }
 *
 * The caller drives the UI — accumulate text deltas, collect tool_use blocks,
 * show Apply cards, send follow-up messages.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, getValidSession } from '@/data/supabaseClient';
import { COACH_TOOLS } from './coach-tools';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type StreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }
  | { type: 'done' }
  | { type: 'error'; message: string };

// ─── System prompt builder ────────────────────────────────────────────────────

export function buildSystemPrompt(coachContext: object): string {
  const mode = (coachContext as any).mode ?? 'running';
  const modeLabel = mode === 'triathlon'
    ? `a ${(coachContext as any).athlete?.race_distance ?? '70.3'} triathlon`
    : `a ${(coachContext as any).athlete?.race ?? 'marathon'}`;

  return `You are a direct, knowledgeable coach. You speak plainly — no filler, no motivational padding.
You are analysing training data for an athlete preparing for ${modeLabel}.

ATHLETE CONTEXT:
${JSON.stringify(coachContext, null, 2)}

Today: ${new Date().toISOString().slice(0, 10)}

When this conversation starts (first user message is "start"), give a 4 to 6 sentence coaching brief: what the data shows, the one or two signals that matter most, and a concrete recommendation for this week. Then wait for the athlete to respond.

You may call tools to propose changes to this week's plan. Always explain your reasoning in plain text before calling a tool. Only call a tool when the change is clearly justified by the data. Every tool call creates a confirmation card — the athlete must press Apply before any change takes effect.

Hard rules:
- No em dashes. No emoji. No markdown headers or bullet lists. Plain prose only.
- No motivational filler: no "listen to your body", "recovery is where the magic happens", "trust the process", "your body needs".
- No medical advice. No nutrition advice. No technique or form advice. No equipment recommendations. Stick to training load, intensity, and session timing.
- Short sentences. Active voice. Lead with the point.
- If all signals look fine, say so directly. Do not manufacture concern.
- If injury or illness is active, the advice is about rest or symptom resolution, not training load.
- When you propose a tool call, name the specific workout and day. Do not be vague.
- Do not repeat the same tool call if the athlete has already applied or skipped it.`;
}

// ─── Streaming fetch ──────────────────────────────────────────────────────────

const EDGE_FN_URL = `${SUPABASE_URL}/functions/v1/coach-chat`;

export async function* streamCoachChat(
  messages: ChatMessage[],
  coachContext: object,
  apiKey: string,
): AsyncGenerator<StreamChunk> {
  let session: Awaited<ReturnType<typeof getValidSession>>;
  try {
    session = await getValidSession();
  } catch {
    yield { type: 'error', message: 'Not signed in. Please reconnect your account.' };
    return;
  }

  const systemPrompt = buildSystemPrompt(coachContext);

  let response: Response;
  try {
    response = await fetch(EDGE_FN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        'X-Anthropic-Key': apiKey,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        messages,
        system_prompt: systemPrompt,
        tools: COACH_TOOLS,
        max_tokens: 1024,
      }),
    });
  } catch (err) {
    yield { type: 'error', message: 'Network error. Check your connection and try again.' };
    return;
  }

  if (!response.ok) {
    let errMsg = 'Coach session failed.';
    try {
      const j = await response.json();
      if (j.message) errMsg = j.message;
      else if (j.error === 'rate_limited') errMsg = 'Daily coaching limit reached. Check back tomorrow.';
      else if (j.error === 'invalid_api_key') errMsg = 'Your Anthropic API key is invalid. Check Settings.';
    } catch { /* ignore */ }
    yield { type: 'error', message: errMsg };
    return;
  }

  // ── Parse SSE stream from Anthropic (proxied) ─────────────────────────────
  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: 'error', message: 'No response stream received.' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  // Track tool_use accumulation across stream events
  let currentToolName = '';
  let currentToolInputJson = '';
  let inToolUse = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        const evType = event.type as string;

        // Text delta
        if (evType === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown>;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            yield { type: 'text', delta: delta.text };
          } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            currentToolInputJson += delta.partial_json;
          }
        }

        // Tool use start
        if (evType === 'content_block_start') {
          const block = event.content_block as Record<string, unknown>;
          if (block?.type === 'tool_use') {
            currentToolName = String(block.name ?? '');
            currentToolInputJson = '';
            inToolUse = true;
          }
        }

        // Tool use complete — emit the parsed tool call
        if (evType === 'content_block_stop' && inToolUse) {
          inToolUse = false;
          if (currentToolName) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(currentToolInputJson || '{}');
            } catch { /* malformed — drop */ }
            yield { type: 'tool_use', name: currentToolName, input };
          }
          currentToolName = '';
          currentToolInputJson = '';
        }

        // Stream-level errors
        if (evType === 'error') {
          const errMsg = (event.error as any)?.message ?? 'Unknown error from AI.';
          yield { type: 'error', message: String(errMsg).slice(0, 200) };
          return;
        }

        // Message stop
        if (evType === 'message_stop') {
          yield { type: 'done' };
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: 'done' };
}

/** Quick connection test — sends a minimal 1-token request */
export async function testApiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await getValidSession();

    const res = await fetch(EDGE_FN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        'X-Anthropic-Key': apiKey,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'ping' }],
        system_prompt: 'Reply with only the word "ok".',
        tools: [],
        max_tokens: 10,
      }),
    });

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, error: j.message ?? `HTTP ${res.status}` };
    }

    // Consume the stream briefly to confirm it opens
    const reader = res.body?.getReader();
    if (reader) {
      await reader.read();
      reader.releaseLock();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
