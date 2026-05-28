# Premium Features

Source of truth for what sits behind the Mosaic paywall. Drives the in-app Upgrade screen copy when it's built. Tier model lives in [AI_STRATEGY.md](AI_STRATEGY.md).

This doc is a stub. Grow it as new premium features land. Each entry should link to the file path so the upgrade screen builder can wire it from one place.

## Tier model (current)

- **Free**: rules-based coach, all plan / readiness / GPS / tracking features.
- **AI Coach subscription (Tier 2)** — £4.99/month, £49.99/year. Apple In-App Purchase via RevenueCat; web/Android entitlement via the Supabase `subscription_active` row that the RevenueCat webhook writes.
- **BYOK (legacy, web/Android only)**: user provides their own Anthropic key. iOS path removed (RevenueCat is the App Store path).
- **Full app subscription (Tier 3, planned)**: gates the whole product. Not yet shipped.

## Currently shipped (live in app)

| Feature | What it does | Key file | Tier |
|---|---|---|---|
| AI Coach narrative | Daily Verdict / Why / Action note on Home | `supabase/functions/coach-narrative/index.ts` | AI Coach |
| AI Coach chat | Conversational coach with Apply cards that propose plan changes | `supabase/functions/coach-chat/index.ts` | AI Coach |
| Workout tweak via Coach | Coach proposes swap / reduce / skip / intensity-cap changes to a planned session | `src/coach/coach-tools.ts` | AI Coach |
| **Brain-generated workouts (On-Demand)** | "Generate with Coach" button on On-Demand home + plan. Reads recent training context + free-text intent, returns a context-aware session with reasoning narrative | `supabase/functions/coach-generate-workout/index.ts`, `src/ui/coach-workout-modal.ts` | AI Coach |
| Snapshot export | One-tap export of the coach context as a `.txt` file for use in any external LLM | `src/coach/coach-chat-client.ts` | Free (drives awareness of paid coaching) |

## In progress (this branch / current sessions)

| Feature | What it does | Status |
|---|---|---|
| RevenueCat IAP hardening | App Store Guideline 3.1.3 polish on the paywall surface | Live, ongoing tweaks |

## Planned (designed, not yet built)

| Feature | Source | Notes |
|---|---|---|
| Brain workout-tweak on race-plan sessions | This session's design — `coach-workout-modal` engine reused on planned sessions | Wait until Tier 2 brain generator is validated on On-Demand first |
| Brain cross-training suggestions | Same as above, surfaced inside the suggestion modal | Same dependency |
| Session memory across weeks | AI_STRATEGY.md roadmap | Store last 3 briefs, include in context |
| Proactive coach alerts | AI_STRATEGY.md roadmap | "Your long run HR has been drifting…" |
| Onboarding glass panel introducing AI Coach | AI_STRATEGY.md roadmap | 1-day build |
| Tier 3 — full-app subscription | AI_STRATEGY.md | Charge for the platform; AI is an add-on |

## Draft upgrade-page copy

### Headline
AI Coach for Mosaic

### Subhead
Daily coaching, on-demand workout generation, and plan changes proposed in plain language. Built on your real training data.

### Feature bullets (for the upgrade modal/screen)

- Daily coaching that reads your recovery, your plan, and your last week of sessions.
- Generate context-aware workouts on demand. Tell Coach what you have time for, it builds the session.
- Conversational chat that can propose specific plan changes for you to apply.
- Runs on Claude Haiku via Anthropic. Your data is never used for training.

### Pricing
£4.99/month or £49.99/year. Cancel any time from Apple Subscriptions.

### FAQ stubs

- **Do I need this to use Mosaic?** No. The plan engine, race predictions, readiness scoring, GPS, and activity sync are all free.
- **Can I cancel?** Yes, any time from Settings → Apple ID → Subscriptions. Your existing data stays put.
- **What happens to my plan if I cancel?** Nothing. The rules-based coach takes over the daily insight; the rest of the app is unchanged.
- **Is my data sent anywhere?** Last 4 weeks of activity context goes to Anthropic per coach session. No name, email, GPS, or payment info. Full detail in [AI_STRATEGY.md](AI_STRATEGY.md).
- **Where can I see what I'm being charged?** Settings → Apple ID → Subscriptions. Mosaic never sees your card number.
