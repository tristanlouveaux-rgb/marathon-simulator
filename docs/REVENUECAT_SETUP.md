# RevenueCat + App Store IAP Setup Runbook

**Audience**: Tristan (non-coder). Each step is something *you* do in a web dashboard. The code side is being built in parallel on the `feat/revenue-cat-iap` branch — you don't need to touch any code.

**Goal**: enable in-app subscription purchases on iOS for the AI Coach, with a 7-day free trial, at £4.99/month or £49.99/year.

**Time required**: ~60 minutes total, spread across several waiting periods (Apple takes time to "process" each step).

**Prerequisite**: an active Apple Developer Program account (£79/year — you should already have this for the App Store submission). Banking and tax info must be filled in on App Store Connect, otherwise you can't sell anything. Check now at https://appstoreconnect.apple.com/business → "Agreements, Tax, and Banking".

---

## Part 1 — App Store Connect (create the subscription products)

### Step 1: Open the Mosaic app record

1. Go to https://appstoreconnect.apple.com/
2. **My Apps** → click **Mosaic**.
3. In the left sidebar, click **Monetization** → **Subscriptions**.

### Step 2: Create a subscription group

A subscription group is a set of "tiers" the user can pick from. Mosaic has one tier (AI Coach) with two SKUs (monthly + annual) — but they go in the same group so the user can upgrade or downgrade between them.

1. Click **+ Create** next to "Subscription Groups".
2. **Reference Name**: `AI Coach` (only you see this).
3. Click **Create**.

### Step 3: Create the monthly product

1. Inside the new "AI Coach" group, click **+ Create** under "Subscriptions".
2. **Reference Name**: `AI Coach Monthly` (internal).
3. **Product ID**: `mosaic_ai_coach_monthly_v1` (this exact string — the app reads it).
4. Click **Create**.
5. On the product page:
   - **Subscription Duration**: 1 Month
   - **Subscription Price**:
     - Click **+** under Subscription Prices.
     - **Base Country/Region**: United Kingdom → £4.99.
     - Apple auto-fills equivalent prices in every other country. Review the suggested USD/EUR — adjust if you want a clean number like $5.99.
     - Save.
   - **Localizations** (English UK):
     - **Subscription Display Name**: `AI Coach`
     - **Description**: `Personal AI coach that reads your training data and recommends plan adjustments. 7-day free trial. Cancel anytime in App Store settings.`
     - Save.
   - **Review Information**:
     - **Screenshot**: upload a screenshot of the paywall (you can use a placeholder for now — Apple requires this before final review).
     - **Review Notes**: `AI Coach subscription. Powered by RevenueCat. Test by creating a sandbox Apple ID in App Store Connect → Users and Access → Sandbox.`

### Step 4: Create the annual product

1. Inside the "AI Coach" group, click **+ Create** again.
2. **Reference Name**: `AI Coach Annual`.
3. **Product ID**: `mosaic_ai_coach_annual_v1`.
4. Click **Create**.
5. On the product page:
   - **Subscription Duration**: 1 Year
   - **Subscription Price**: £49.99 in United Kingdom.
   - **Localizations**:
     - **Display Name**: `AI Coach (Annual)`
     - **Description**: `Personal AI coach that reads your training data and recommends plan adjustments. 7-day free trial. Save 17% vs monthly. Cancel anytime in App Store settings.`
   - **Review Information**: same as monthly.

### Step 5: Add the 7-day free trial introductory offer (BOTH products)

For each product (monthly and annual), repeat:

1. Open the product page.
2. Scroll to **Subscription Prices** → click **View All Subscription Pricing** → **Introductory Offers**.
3. Click **+** to create a new introductory offer.
4. **Offer Type**: `Free`.
5. **Duration**: `1 Week`.
6. **Country**: leave as "All Countries" (the same trial applies worldwide).
7. **Eligibility**: `New Subscribers` (the default — only first-time subscribers get the trial).
8. Set the start date to today, no end date.
9. Save.

### Step 6: Mark both products "Ready to Submit"

When all fields are green:

1. Each product should show a yellow "Missing Metadata" or "Ready to Submit" pill at the top.
2. Click into each product, fix any remaining red items, and confirm both products show **Ready to Submit**.
3. **DO NOT** submit yet — these products are submitted alongside the app binary that contains the IAP code (still being built). Apple won't approve them in isolation.

---

## Part 2 — RevenueCat (account + project setup)

### Step 7: Create the RevenueCat account

1. Go to https://www.revenuecat.com/ and click **Get Started**.
2. Sign up with your email (or "Sign up with Apple").
3. RevenueCat is free up to $2,500/month MTR (monthly tracked revenue), so it costs nothing until Mosaic has many subscribers.

### Step 8: Create the Mosaic project

1. On first login, RevenueCat asks for a project name. Use `Mosaic`.
2. Pick the **Apple App Store** platform first.
3. **iOS Bundle ID**: `com.mosaicrunning.app` (or whatever's in `ios/App/App.xcodeproj` — RevenueCat needs the exact bundle ID Apple sees).

### Step 9: Connect RevenueCat to App Store Connect (the hard part)

RevenueCat needs to verify Apple receipts. Two pieces of info from Apple are required:

**9a — App Store Connect Shared Secret** (legacy, but still required for some receipt-validation paths):

1. In App Store Connect → **Mosaic** → **App Information** → scroll to **App-Specific Shared Secret** → **Generate** (or "Manage" if one exists).
2. Copy the long hex string.
3. In RevenueCat → **Project Settings** → **Apps** → **Mosaic iOS** → paste into the **App Store Shared Secret** field.

**9b — App Store Server API Key** (the modern way):

1. In App Store Connect → **Users and Access** → **Integrations** tab → **In-App Purchase**.
2. Click **+** → **Generate In-App Purchase Key**.
3. **Name**: `RevenueCat`.
4. Click **Generate** → **Download** the `.p8` file (you can only download it once — keep it safe).
5. Note the **Key ID** and **Issuer ID** shown on the page.
6. In RevenueCat → **Project Settings** → **Apps** → **Mosaic iOS** → fill in:
   - **In-App Purchase Key ID**: paste the Key ID from Apple.
   - **Issuer ID**: paste the Issuer ID.
   - **Private Key**: upload the `.p8` file.

### Step 10: Import the products into RevenueCat

1. RevenueCat → **Products** in the sidebar.
2. Click **Import Products** (or **+ New** → "Import from App Store").
3. RevenueCat queries App Store Connect using the credentials above and pulls in your two products.
4. Confirm `mosaic_ai_coach_monthly_v1` and `mosaic_ai_coach_annual_v1` both appear.

### Step 11: Create an Entitlement

An "entitlement" is the RevenueCat concept that maps "what did the user buy" to "what feature is unlocked". Both products should grant the same entitlement.

1. RevenueCat → **Entitlements** in the sidebar.
2. **+ New Entitlement**.
3. **Identifier**: `ai_coach`.
4. **Display Name**: `AI Coach`.
5. Click **Create**.
6. On the entitlement page → **Attach Products** → add both `mosaic_ai_coach_monthly_v1` and `mosaic_ai_coach_annual_v1`.

### Step 12: Create an Offering

An "offering" is the set of products shown on the paywall. We have one offering with two packages (monthly + annual).

1. RevenueCat → **Offerings**.
2. **+ New Offering**.
3. **Identifier**: `default` (this exact string — the app reads it).
4. **Display Name**: `Default`.
5. Click **Create**.
6. On the offering page → **+ Add Package**:
   - **Identifier**: `$rc_monthly` (RevenueCat's reserved identifier for monthly).
   - **Product**: select `mosaic_ai_coach_monthly_v1`.
7. **+ Add Package** again:
   - **Identifier**: `$rc_annual`.
   - **Product**: `mosaic_ai_coach_annual_v1`.
8. Set this offering as the **Current Offering** (top of the page) so it's the default the app pulls.

### Step 13: Get the iOS SDK API key

1. RevenueCat → **Project Settings** → **API Keys**.
2. Under **Apple App Store**, copy the **App-Specific API Key** (starts with `appl_`).
3. **You'll paste this into the app code later (Step 17)** — keep the tab open or save the key somewhere safe.

### Step 14: Configure the webhook

The webhook is how RevenueCat notifies Mosaic's backend that a subscription was bought, renewed, cancelled, etc.

1. RevenueCat → **Project Settings** → **Integrations** → **Webhooks** → **+ New Webhook**.
2. **URL**: `https://elnuiudfndsvtbfisaje.supabase.co/functions/v1/revenuecat-webhook` (this URL will work once I deploy the webhook handler edge function).
3. **Authorization Header**: pick a long random string — this is a shared secret only you and the backend know. Something like `Bearer rc_webhook_<32_random_chars>`. You can generate one at https://www.random.org/strings/ (length 32, hex characters, generate).
4. **Save** the webhook.
5. **Copy the Authorization Header value** — you'll paste this into Supabase as an environment variable (Step 18).

---

## Part 3 — Sandbox tester (for testing without real money)

### Step 15: Create a sandbox Apple ID

1. App Store Connect → **Users and Access** → **Sandbox** tab → **Testers**.
2. Click **+** → **Add Tester**.
3. Fill in any fake details. **Email** must be one you can receive at (Apple sends a verification code). Use something like `tristan+sandbox@gmail.com` — Gmail ignores the `+sandbox` part and forwards to your real inbox.
4. **Password**: must satisfy Apple's full password rules (12+ chars, uppercase, lowercase, number, symbol). Save it somewhere — you'll type it into your iPhone.
5. **Country**: United Kingdom (so prices appear in £).

### Step 16: Sign your iPhone in to the sandbox tester

**Do NOT sign out of your real Apple ID — sandbox testing uses a separate slot.**

1. On your iPhone: **Settings** → **App Store** → scroll to the bottom → **Sandbox Account** → **Sign In** with the sandbox tester credentials from Step 15.
2. The first time, Apple may ask you to confirm the email — check inbox for the verification code.

---

## Part 4 — Pasting credentials into the code (once I'm done building)

I'll mark the file `src/coach/revenuecat-config.ts` with `TODO_PASTE_HERE` placeholders. There are three values to swap in:

### Step 17: Paste the RevenueCat SDK key

1. Open `src/coach/revenuecat-config.ts`.
2. Find the line with `REVENUECAT_IOS_SDK_KEY = 'TODO_PASTE_HERE'`.
3. Replace `'TODO_PASTE_HERE'` with the key from Step 13. Keep the quotes.
4. Save.

### Step 18: Paste the webhook secret into Supabase

1. Go to https://supabase.com/dashboard → Mosaic project → **Settings** → **Edge Functions**.
2. Click **Add new secret**.
3. **Name**: `REVENUECAT_WEBHOOK_AUTH`
4. **Value**: paste the full Authorization Header value from Step 14 (the `Bearer rc_webhook_...` string).
5. Save.

### Step 19: Apply the database migration

You can either:
- **Easy**: ask me in a new session to run `supabase db push` for you.
- **Manual**: from terminal — `supabase db push` — applies the new `subscription_active` migration.

### Step 20: Deploy the new edge functions

You can either:
- **Easy**: ask me in a new session to deploy them.
- **Manual**: from terminal — `supabase functions deploy coach-chat revenuecat-webhook` — pushes both edge functions live.

---

## Part 5 — Sandbox testing the full purchase flow

This is how you confirm the IAP works end-to-end before submitting the build to Apple. Sandbox testing uses real Apple infrastructure but no money changes hands.

### Step 21: Confirm the prerequisites

Before testing, all of these must be true:

- Steps 1 through 20 are complete.
- `src/coach/revenuecat-config.ts` has the real SDK key pasted in (no `TODO_PASTE_HERE`).
- The Supabase migration ran (`subscription_active` table exists).
- Both edge functions are deployed (`supabase functions deploy coach-chat revenuecat-webhook`).
- The `REVENUECAT_WEBHOOK_AUTH` Supabase secret matches the value RevenueCat is sending.
- Your iPhone is signed in to the sandbox Apple ID under **Settings → App Store → Sandbox Account**.

### Step 22: Build and install on your iPhone

You can ask me in a new session to do this, or run yourself from terminal:

```
npm run build:ios
npx cap run ios
```

The dev build installs over your existing Mosaic. It's signed with your developer cert (the only build type Apple lets you test IAP with — TestFlight works too once that's set up).

### Step 23: Trigger the paywall

1. Open Mosaic on your iPhone.
2. **Sign out and sign back in** if you were previously allowlisted — the new entitlement check should now see "no row in subscription_active" and route you to the paywall.
3. Tap the **Coach** tab.
4. You should see the AI Coach paywall screen (not the rules-based classic coach).

**If you see classic coach instead of the paywall**: you're either still in the env allowlist (`ALLOWED_USER_IDS` includes your UID — remove it via Supabase secrets), or the app thinks you're not on iOS (Capacitor platform detection issue).

### Step 24: Run a sandbox purchase

1. Tap **Start 7-day free trial**.
2. Apple's payment sheet appears. The header reads **\[Environment: Sandbox\]** — this is your visual confirmation no real money is involved.
3. The sheet shows the price (£0 for the first 7 days, then £4.99 or £49.99).
4. Tap **Subscribe** → confirm with Face ID / passcode.
5. Wait 5–10 seconds. The paywall should dismiss and you should land on the AI Coach view.

**Sandbox time acceleration**: Apple's sandbox runs subscription periods compressed — a 1-month subscription renews every 5 minutes, an annual every hour. The 7-day trial completes in ~3 minutes.

### Step 25: Verify the webhook fired

1. Go to https://supabase.com/dashboard → Mosaic project → **Edge Functions** → **revenuecat-webhook** → **Logs** tab.
2. You should see a log line like `INITIAL_PURCHASE user=44bd716f tier=ai_coach status=in_trial` within a minute of the purchase.
3. If you see `auth mismatch` — the shared secret between RevenueCat and Supabase is wrong (Step 14 / Step 18).
4. If you see `unhandled event type` — RevenueCat sent something we don't handle yet (rare; tell me what type it was).

### Step 26: Verify the database row

1. Supabase → **Table Editor** → `subscription_active`.
2. Find the row matching your sandbox tester's user UUID.
3. Confirm: `tier='ai_coach'`, `status='in_trial'`, `product_id='mosaic_ai_coach_monthly_v1'` (or annual), `valid_until` is ~7 days from now.

### Step 27: Verify the Coach unlocks

1. Tap the Coach tab. You should land directly on the AI Coach view (no paywall).
2. Send a message. The AI should respond — confirms the edge function read the entitlement row correctly and bypassed the 402.

### Step 28: Verify Restore Purchases

1. Delete Mosaic from your iPhone.
2. Reinstall (`npx cap run ios` again, or from TestFlight if that's where you're testing).
3. Sign back in.
4. Tap Coach — you should see the paywall again (entitlement cache is fresh; the SDK hasn't seen the receipt yet on this fresh install).
5. Tap **Restore Purchases**.
6. Within 5 seconds, the paywall should dismiss and Coach should unlock.

### Step 29: Verify cancellation

1. On your iPhone: **Settings** → tap your name → **Subscriptions**.
2. Look for "AI Coach" in the **Active** list.
3. Tap it → **Cancel Subscription** → confirm.
4. Within ~30 seconds, RevenueCat should fire a `CANCELLATION` webhook → Supabase `subscription_active` row updates to `status='cancelled'` (but `tier` stays `ai_coach`, `valid_until` is unchanged — Apple lets the user keep access until period end).
5. Open the app, tap Coach — still AI Coach view, because `cancelled` + `valid_until` in the future = still entitled.

### Step 30: Verify expiration (sandbox accelerated)

1. Wait for the sandbox-accelerated period to elapse (~5 minutes for monthly).
2. RevenueCat fires `EXPIRATION` → Supabase row updates to `tier='free'`, `status='expired'`.
3. Open the app, tap Coach — paywall appears again.

### Step 31: Test the "no SDK key configured" path (optional, recommended)

1. Temporarily revert `src/coach/revenuecat-config.ts` to `TODO_PASTE_HERE`.
2. Rebuild and reinstall.
3. Open Coach — should fall through to classic coach (no paywall, no SDK init).
4. Re-paste the real key after the test.

This confirms the app behaves cleanly in environments where RevenueCat isn't configured yet (dev builds for new contributors, etc.).

### Sandbox debugging cheatsheet

| Symptom | Likely cause | Fix |
|---|---|---|
| Paywall shows "Loading subscription options…" forever | RevenueCat couldn't reach App Store, or offering empty | Check Step 12 — offering must have packages and be set as Current |
| Tapping Subscribe shows nothing | iOS isn't signed in to sandbox tester | Settings → App Store → Sandbox Account |
| Purchase succeeds but Coach still shows paywall | Webhook didn't fire or failed | Check `revenuecat-webhook` logs in Supabase |
| Webhook log shows `auth mismatch` | Shared secret mismatch | Compare Step 14 and Step 18 — must be byte-for-byte identical including any "Bearer " prefix |
| Database row updates but Coach still shows paywall | Client cache stale | Force close and relaunch the app, or call `resetEntitlementCache()` |
| `RevenueCat SDK key not configured` in console | Step 17 not done | Paste the real key into `src/coach/revenuecat-config.ts` |

---

## What ships to production

When you're ready to submit the binary with IAP to App Store Review:

1. All of Parts 1–4 complete.
2. Sandbox tests Step 21–31 pass on your device.
3. In App Store Connect, **submit the two subscription products alongside the binary** — they're attached to the build, not separate.
4. App Review tests the paywall on their own sandbox infrastructure. Tell them in the review notes: "AI Coach subscription requires sandbox tester. Test by tapping Coach tab → Start 7-day free trial. The sandbox flow takes ~10 seconds. To reset between test passes, sign into a fresh sandbox tester in Settings → App Store → Sandbox Account."

---

## Reference: things you might worry about

**"What if I want to change the price later?"**
Easy. Change the price in App Store Connect → Subscriptions → product → Subscription Prices. Apple notifies existing subscribers 30 days before any increase takes effect. No code changes needed.

**"What if I want to add a third tier later (e.g. Mosaic Premium)?"**
Repeat Part 1 with a new Product ID. RevenueCat picks it up via Step 10. Paywall UI needs a code update to show the third package.

**"How do I refund someone?"**
You can't directly — Apple owns refunds. Direct the user to https://reportaproblem.apple.com/. RevenueCat's dashboard will flag the refund on your end.

**"Where do I see how much I've earned?"**
App Store Connect → **Sales and Trends**. RevenueCat dashboard also shows live MRR. Apple pays out monthly, ~45 days after each month closes.

**"What happens if RevenueCat goes down?"**
Apple is the source of truth for subscription state. RevenueCat is a convenience layer. If RevenueCat is unreachable, the iOS SDK falls back to reading directly from StoreKit. Worst case, a user's subscription state lags by a few minutes until RevenueCat recovers.
