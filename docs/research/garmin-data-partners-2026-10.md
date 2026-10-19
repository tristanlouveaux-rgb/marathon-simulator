# Garmin and other watches: data partner research (parked)

Researched and fact-checked 2026-10-19. **Status: PARKED by Tristan on 2026-10-20.** Recall this when Garmin users need full data (routes, per-km splits) at scale, or when Strava stays capped. Tracked as ISSUE-401.

Raw research (JSON with every source URL) is in `docs/audits/aggregator-research/` (untracked): terra.json, alternatives.json, codebase.json, synthesis.json, factcheck.json.

## Where things stood

- Apple Watch users: fully covered by HealthKit, free.
- Garmin users: only rich route is Garmin -> Strava -> Mosaic, capped at 10 athletes. The free Garmin -> Apple Health bridge has heart rate, load and recovery but no GPS route and no per-km splits. File import (FIT/GPX/TCX) covers routes and splits manually.
- Strava (June 2026) bans routing Strava data through intermediaries such as Terra, so an aggregator replaces "Garmin via Strava", not Strava itself.

## Decision options when this is picked up

1. Email Junction (draft below). Ask for the written confirmations first; price second.
2. Ask Strava for a Standard-tier increase (up to 9,999 athletes). Free, and keeps full data for Garmin users. Their FAQ is inconsistent about which tier to apply for.
3. Keep the launch baseline regardless: Apple Health bridge + file import, and finish the iOS "Share to Mosaic" step (src/data/shared-file-intake.ts exists; the iOS settings part is not done).

## Open questions for Tristan (unanswered at parking)

- Is Mosaic a registered company (UK Ltd) or trading as a sole trader? Contracts and data agreements need a legal name; Garmin, Suunto and COROS only accept companies.
- Willing to pay $300 a month from launch if Junction will not discount (about 66 paying subscribers at GBP 4.99 covers it)?
- OK for COROS users to launch on file import only (COROS is not on Junction)?
- Happy to be named publicly as a Junction customer (case study, "Powered by Junction")?

---

# Garmin and other watches: what to do

Researched 2026-10-19 and fact-checked the same day against the cited pages. Prices and terms come from public pages. Anything not public is marked "not public". Full files: /Users/tristanlouveaux/Documents/marathon-simulator/docs/audits/aggregator-research/synthesis.json and factcheck.json.

## Short answer

Yes, try to partner with an aggregator, and approach **Junction** (formerly Vital) first. Treat it as promising but unproven until Junction answers a few questions in writing.

- Terra cannot give you Garmin today. Junction's docs say its own Garmin app is switched on, so you would not need your own Garmin approval [S8].
- Three things decide whether $300 a month actually buys what you need, and none of them is public:
  - Whether Garmin counts as a "basic" integration on the $300 Launch plan. "Premium" integrations are Enterprise-only [S7].
  - Whether Junction's Garmin workouts carry the GPS and heart-rate stream that routes and per-km splits need [S9, S47].
  - Whether Garmin still lets Junction pass Garmin data to a new app like Mosaic [S28, S31].
- Junction says it offers no startup discounts [S7]. So the "partnership" is mostly about getting those answers in writing. A discount would be a bonus.
- Garmin itself is the big risk for every aggregator. Pay monthly, never yearly, and keep file import as the safety net.

## Why not Terra

- Terra's Garmin docs say Garmin requires every company that connects Garmin users to have its own Garmin app, "with no third party in the application" [S1]. Garmin has paused new applications since spring 2026 [S30]. So Terra cannot give you Garmin.
- Read that as a warning about Garmin, not just about Terra. If Terra is right about Garmin's rule, a shared Garmin app like Junction's is exactly what Garmin is moving against. Terra is a competitor, so this is Terra's claim, not Garmin's.
- Terra's Garmin feed has shown "Major outage" since 1 September 2026, when "Garmin's API began rejecting authorization requests". The last update, on 21 September, says Garmin data stopped for most connections. Terra links the problem to Garmin "changing its API terms and the way partners access its APIs" [S2].
- Terra's Strava route is not an option at all. On 1 June 2026 Strava said apps "routing Strava data through third-party intermediary platforms are no longer supported" [S32]. Strava's FAQ calls putting your Strava app credentials into an intermediary a "non-compliant use case" [S33]. Terra's help page still suggests telling Strava you use Terra [S44]. Do not say that in your Strava application.
- Terra has no partner programme for apps like Mosaic. Its partner programme is for data providers [S6]. Its accelerator gives credits to about 0.8% of applicants, who must be new to Terra [S5]. Credits do not fix Garmin.
- Terra's strength is that COROS, Polar, Suunto and Wahoo work without your own app [S3]. Keep it in mind for COROS later.

## Why Junction first

- **Garmin without your own approval, according to its docs.** Junction's own Garmin app is listed as "Enabled" [S8]. Users sign in on Garmin's own page, because Junction treats Garmin as an OAuth provider [S46].
- **No Garmin incidents on Junction's status page.** Garmin is listed with no incidents from July to October 2026 [S48]. That is a different picture from Terra. It shows Junction's systems are up. It does not prove Garmin allows new customer apps.
- **Routes and per-km splits: probably, not confirmed.** Junction's workout stream returns time, heart rate, latitude, longitude and distance arrays [S9]. Mosaic's existing code already turns those into routes, splits, zones and load (src/data/fitImport.ts:501-631). But:
  - The stream page does not say which brands fill it.
  - Junction's provider-by-data table is an embedded spreadsheet that could not be read.
  - Junction's own sample Garmin workout has no map.
  - The only Garmin sample rate Junction publishes is a peak of one heart-rate sample every 15 seconds, for its all-day heart-rate data [S47].
  - Confirm in writing before building.
- **EU data, with gaps.** Junction's EU region stores data in Belgium and cannot be changed later [S10]. Junction is a US company (Adept Labs Inc., under Delaware law) and publishes no data processing agreement [S49]. Ask for one, with the EU standard contract clauses, the UK Addendum and a list of subprocessors.
- **Price.** $300 a month flat for 1 to 500 connected users, billed monthly, with no annual contract [S7]. The Launch plan lists "Basic integrations". The Enterprise plan adds "Premium and Bluetooth integrations". The page does not say which group Garmin is in [S7].
- **Free to build.** The sandbox is free [S7]. It is not stated whether the sandbox can connect a real Garmin account.
- **Other brands.** Polar and Wahoo are enabled. Suunto is "Planned". COROS is not listed [S8]. Junction's Polar history covers sleep only, for 28 days [S11].
- **History.** Garmin backfill defaults to 90 days [S11].
- **Contract risk.** Junction's terms let it withdraw or change the service "without notice" [S49]. That is another reason to pay monthly and get a notice period in writing.
- **Not for Strava.** Junction made Strava bring-your-own-credentials only in July 2026 [S50]. Its own credentials sit on the Enterprise plan ("Custom OAuth credentials") [S7]. Strava's intermediary rule applies anyway [S32].

## The big risk: Garmin itself

- Section 5.2(o) of Garmin's agreement (Rev. B) bars building an API that provides users' data to third parties "that have not been approved by Garmin in writing" [S28]. Section 4.2 lets Garmin cancel any licence key at any time [S28].
- Garmin is about to enforce this. Its updated terms stop licensees sharing data with services Garmin has not approved in writing. No date has been announced [S31].
- A UK AI coaching app, Intervals Pro, closed on 12 October ahead of the change. Its owner said Garmin "are going to restrict downstream data" [S31].
- Garmin told the intervals.icu developer three things, according to his forum post [S51]. No date was given, and this is second-hand.
  - The rules on third-party sharing "are not new".
  - The revised agreement is part of a "planned reopening" of the developer programme.
  - There will be "an easier path for individuals and apps".
- So any aggregator's Garmin feed could stop at short notice. That is why the first asks below are written promises, not price.

## What to ask Junction for

Must-haves, in writing:

1. Garmin is included on the $300 Launch plan and is not a premium (Enterprise-only) integration.
2. New customers can connect Garmin users today through Junction's Garmin app.
3. Garmin's current terms, and its revised agreement, allow Mosaic to receive Garmin data through Junction. Does Garmin's written approval cover apps that use Junction? How much notice would you get if that changed?
4. Garmin workouts fill the workout stream with latitude, longitude, distance and heart rate for runs, rides and swims. At what interval? Are raw FIT files available? FIT files would save 8 to 12 hours of build.
5. The EU (Belgium) region is available on Launch, with a signed data processing agreement (EU standard clauses plus UK Addendum) and a subprocessor list.
6. Garmin data received through Junction may be used in an AI feature (the AI Coach).
7. What counts as a "connected user": one per person, or one per brand connection? This decides whether Polar and Wahoo connections eat into the 500.

The partnership part (nice to have):

8. Junction's old public price was $0.50 per user with a $300 minimum [S13]. Ask for $0.50 per connected user with no minimum until you pass 500 users. Or ask them to waive the fee until your public launch.
9. In return, offer a public case study, "Powered by Junction" on the connect screen, a short piece for their blog, and detailed feedback from a four-sport app that uses the full workout data.

Be realistic. Junction's pricing page says plainly that it has no startup discounts [S7]. The written promises matter more than the price.

## Realistic monthly cost

| Garmin users | Junction | Spike (backup) | Thryve (EU backup, if GPS confirmed) | ROOK (with GPS samples) | Terra (no Garmin today) |
|---|---|---|---|---|---|
| 10 | $300, if Garmin is on Launch | from $450 | from EUR 499 | $747 | $399 (annual) or $499 (monthly) |
| 100 | $300, if Garmin is on Launch | from $450 | from EUR 499 | $747 | $399 or $499 |
| 1,000 | Custom, not public. The old public rate would have given $500 | Not public | About EUR 749 (my arithmetic) | $999 (Core+) | At least $899 or $999 (my arithmetic) |

Notes:

- Junction's pricing page never defines "connected user" [S7].
- At 10 users, Junction works out at $30 per user. At 100 it is $3. At 500 it is $0.60.
- ROOK is $399 plus $249 for GPS samples plus $99 for webhooks, on a 12-month contract with 30 days' notice. At 1,000 users, Core+ at $999 covers both add-ons among its three free picks [S21].
- Terra at 1,000 users: each user costs 200 credits, so 1,000 users need 200,000. The plan includes 100,000. The extra 100,000 at $0.005 each is $500 [S4]. Data events beyond 400 per user per month cost extra (0.5 credits each), so treat this as a floor.
- Thryve is EUR 499 for 500 users plus EUR 0.50 for each extra user [S24].
- Spike's $450 is labelled "Sandbox". Production terms are not stated [S15].

**What it takes to cover $300 a month.** At the live price of £4.99 a month (docs/AI_STRATEGY.md:47), a UK subscriber brings in about £3.53 after VAT (20%) and Apple's 15% small-business cut [S40, S39]. Subscribers needed = $300 ÷ (that day's dollars per pound) ÷ £3.53. At an illustrative $1.30 to £1, $300 is about £231, or about 66 paying monthly subscribers. Annual subscribers bring in less per month.

## If Junction says no

1. **Spike next.** Ask the same questions. From $450 a month, on a plan labelled "Sandbox" [S15]. It says no separate Garmin approval is needed [S16], but that claim dates from January, before the pause became public.
   - Its workout format has fields for laps, splits and route points [S17]. Its brand-by-brand table, though, confirms only GPS and second-level heart rate for Garmin, with no laps [S18].
   - Cautions: its privacy policy (dated 2023) names both the USA and Germany, and relies on user consent for transfers [S19]. A competitor reports it was bought by Raintree Systems [S20].
2. **Thryve as the EU-hosted option.** Data is hosted in Germany and it uses a shared Garmin app [S24, S25]. Its docs list a GPS data category but do not say whether Garmin workouts include routes or laps [S25]. Ask the same questions. EUR 499 a month for 500 users.
3. **If no aggregator will confirm Garmin in writing**, launch Garmin users on what already exists:
   - The Garmin to Apple Health bridge for heart rate, load and recovery. Garmin's own push to Apple Health is outside the new restriction [S31].
   - File import for routes and splits. It already reads FIT, GPX and TCX files and Garmin's export zips (src/data/fitImport.ts:874-955). Files that users upload themselves are expected to stay outside Garmin's restriction [S31].
   - Be honest that this is clunky. The Garmin Connect phone app cannot export activity files, so single-activity export means using the Garmin Connect website [S53].
   - Finishing the iOS "Share to Mosaic" step would help. The app side exists in src/data/shared-file-intake.ts, but ios/App/App/Info.plist has no document types yet.
4. **Do these anyway, in parallel:**
   - **Register a UK company** if Mosaic is not one yet. Suunto and COROS require a company [S36, S37]. Garmin's FAQ says the programme is "only for business use" [S29], and others report it needs a legal entity [S27]. Garmin's promised "easier path for individuals" may change that [S51].
   - **Suunto.** It takes company applications and says that, if accepted, "you should get the response within two weeks" [S36]. Terra lists Suunto as "Applications no longer open" [S3], so email partners@suunto.com first to check it is open.
   - **Garmin.** Reapply when it reopens.
   - **Strava.** Strava's FAQ is inconsistent [S33]. Its text says the Standard tier reaches 9,999 athletes after review and Extended Access starts at 10,000. Its table puts 11 to 9,999 under Extended Access. Both go through the same review form.
     - Make sure the request asks for the up-to-9,999 level, and that Mosaic holds the required Strava subscription.
     - Strava says it will not approve apps that expose athlete data to third-party AI tools [S33]. State in the application that Strava data stays out of the AI Coach.

## A useful side effect, with a caveat

Strava's policy bans using its data in AI features [S34]. That is why the AI Coach cannot serve Strava users today (docs/AI_STRATEGY.md). Garmin users who connect through Junction might be able to use the Coach, if Junction confirms Garmin allows it (ask number 6).

There is a caveat. Garmin's global agreement (Rev. B) has no AI clause, but it limits data use to internal business purposes and display [S28]. Garmin's March 2026 agreement template for China adds an "AI Transparency Statement" that requires explicit user consent before AI processing [S52]. The revised global agreement may add something similar.

**Sources** (P = primary, vendor or official page; S = secondary). All accessed or re-checked 2026-10-19 unless dated otherwise.

- [S1] P. Terra Garmin setup docs: Garmin requires every company to have its own app, "no third party in the application"; evaluation apps cannot carry production traffic. https://docs.tryterra.co/unified-api/garmin.md
- [S2] P. Terra status page: "Garmin: new user connections failing", Major outage. 2026-09-01 "Garmin's API began rejecting authorization requests"; 2026-09-04 terms and partner-access change; 2026-09-21 last update. https://status.tryterra.co
- [S3] P. Terra supported integrations: Garmin and Strava "Required"; COROS, Polar, Suunto, Wahoo "Managed"; Suunto "Applications no longer open". https://docs.tryterra.co/reference/health-and-fitness-api/supported-integrations.md
- [S4] P. Terra pricing: $399/mo annual or $499/mo monthly, 100,000 credits; 200 credits per active authentication; 400 free events then 0.5 credits each; $0.005 per extra credit. https://tryterra.co/pricing and https://docs.tryterra.co/unified-api/pricing.md
- [S5] P. Terra Startup Accelerator: up to $100k credits over 6 months, about 0.8% accepted, new to Terra only. https://tryterra.co/startup-accelerator
- [S6] P. Terra Integration Partner programme is for data providers. https://docs.tryterra.co/integration-partners/overview.md
- [S7] P. Junction pricing: Launch $300/mo, billed monthly, 1-500 connected users, "Basic integrations"; Enterprise adds "Premium and Bluetooth integrations" and "Custom OAuth credentials"; no startup discounts; free sandbox; "connected user" undefined. https://www.junction.com/pricing
- [S8] P. Junction provider table: Garmin default app "Enabled"; Polar and Wahoo enabled; Suunto "Planned"; COROS not listed; Strava BYOO-only. https://docs.junction.com/wearables/providers/introduction.md
- [S9] P. Junction workout stream fields; no providers or sample rate stated. https://docs.junction.com/api-reference/data/workouts/get-stream.md
- [S10] P. Junction regions: EU data stored in Belgium; cannot be changed. https://docs.junction.com/api-details/regions.md
- [S11] P. Junction backfill: Garmin 90 days default; Polar 28 days, sleep only. https://docs.junction.com/wearables/providers/historical-data-pull-range.md
- [S13] S, 2026-08-24. PricingSaaS: Launch changed from $0.50/user (min $300) to flat $300. https://pricingsaas.com/companies/tryvital
- [S15] P. Spike pricing: "Sandbox" plan "Starts from $450/month"; billing, user limits and hosting not stated. https://spikeapi.com/pricing
- [S16] P, 2026-01-29. Spike: "No separate Garmin approval is required". https://www.spikeapi.com/blog/garmin-api-integration-spike
- [S17] P. Spike workout object: laps, splits, samples, route_points; which brands fill them not stated. https://docs.spikeapi.com/api-reference/query-workout-by-id.md
- [S18] P. Spike provider matrix: Garmin lat/long and intraday HR, no laps listed, 90-day backfill; COROS no lat/long; Wahoo absent. https://docs.spikeapi.com/technical-references/provider_matrix.md
- [S19] P, policy dated 2023-12-27. Spike privacy policy: services maintained in USA, data stored in Germany, consent-based transfers. https://www.spikeapi.com/privacy-policy
- [S20] S, 2026-10-09 (competitor page). Spike acquired by Raintree Systems. https://sahha.ai/compare/spike-api-alternatives/
- [S21] P. ROOK pricing: Core $399 up to 750 users; Core+ $999 up to 5,000 with 3 add-ons of choice; Granular Data $249, Webhook $99; 12-month term, 30 days' notice. https://www.tryrook.io/pricing
- [S22] P. ROOK Garmin docs: GPS and HR arrays; laps and credential model not stated. https://docs.tryrook.io/data-sources/garmin/
- [S23] P. ROOK privacy: AWS in the USA. https://www.tryrook.io/privacy-policy
- [S24] P. Thryve pricing: Start Up from EUR 499 for 500 users + EUR 0.50 per extra; Scale Up from EUR 1,000 for startups under 10 years; hosted in Germany. https://www.thryve.health/pricing
- [S25] P. Thryve docs: shared oAuth client for Garmin, Polar, Suunto (and Strava); "Location & GPS" data category; Garmin routes and laps not documented; default 14 days history. https://docs.thryve.health/llms-full.txt
- [S26] P. Sahha: Garmin beta, sandbox only, own Garmin Client ID; Starter $299/mo billed annually. https://docs.sahha.ai/docs/connect/integrations/garmin.md and https://sahha.ai/pricing
- [S27] S. Open Wearables: own Garmin credentials; programme on hold; legal entity required. https://openwearables.io/docs/providers/garmin-api-integration.md
- [S28] P, Rev. B (PDF dated Oct 2023). Garmin agreement: 4.1 internal business and display only; 4.2 Garmin may rescind any licence key; 5.2(o) onward-sharing bar. https://developerportal.garmin.com/sites/default/files/Garmin%20Connect%20Developer%20Program%20Agreement.pdf
- [S29] P. Garmin programme FAQ: free, "only for business use"; no registered-company wording. https://developer.garmin.com/gc-developer-program/program-faq
- [S30] S, 2026-09-14. Garmin paused new applications in spring 2026. https://the5krunner.com/2026/09/14/garmin-developer-api-access-paused/
- [S31] S, 2026-10-14. Garmin's updated terms; no date announced; Intervals Pro closed 12 Oct; uploaded files and Apple Health push outside the restriction; aggregators not mentioned. https://the5krunner.com/2026/10/14/garmin-api-intervals-third-party-apps/
- [S32] P, 2026-06-01. Strava: intermediary routing no longer supported. https://communityhub.strava.com/insider-journal-9/an-update-to-our-developer-program-13428
- [S33] P, updated 2026-06-04. Strava API FAQ: tiers (internally inconsistent), subscription required, same review form, intermediary use "non-compliant", no approval for apps exposing data to third-party AI tools. https://communityhub.strava.com/developers-knowledge-base-14/strava-api-faq-12906
- [S34] P, effective 2026-06-01. Strava API Policy: 5.3 no AI Applications; 5.16 no intermediaries; 6.2 7-day cache; 7.4 delete within 30 days of revocation. https://www.strava.com/legal/api_policy
- [S35] P. Polar AccessLink: self-serve; last 30 days, after registration only. https://www.polar.com/accesslink-api/
- [S36] P. Suunto API FAQ: companies only; response "within two weeks" if accepted; open status not stated. https://apizone.suunto.com/faq
- [S37] P (via search extracts). COROS Partner API: established platform and registered company. https://support.coros.com/hc/en-us/articles/53181766856724
- [S38] P. Wahoo Cloud API: on request. https://developers.wahooligan.com/cloud
- [S39] P. Apple Small Business Program: 15%. https://developer.apple.com/app-store/small-business-program/
- [S40] P. UK standard VAT 20%. https://www.gov.uk/vat-rates
- [S41] S, 2025-07-02. Garmin attribution requirement, relayed by Validic. https://trust.validic.com/incidents/yxdvbtfk0cqg
- [S42] P (ROOK), 2026-09-29. Garmin attribution rules "follow the data". https://tryrook.io/blog/garmin-connect-api-access/
- [S44] P. Terra Strava help: own Strava app needed; suggests telling Strava you use Terra. https://docs.tryterra.co/help-center/help-topics/connecting/getting-a-provider-developer-app-approved/strava-production-app-and-athlete-limit.md
- [S45] P, updated 2026-09-24. Terra DPA: UK and Netherlands primary; US transfer may be necessary. https://tryterra.co/dpa
- [S46] P. Junction provider types: Garmin is OAuth; OAuth providers redirect the user to the provider's site. https://docs.junction.com/wearables/connecting-providers/auth_types.md
- [S47] P. Junction resources: no fixed sample rates; Garmin heart-rate peak 1 sample per 15 s; sample Garmin workout has "map": null; provider tables are embedded spreadsheets. https://docs.junction.com/wearables/providers/resources.md
- [S48] P. Junction status page and history: Garmin listed under device providers; no Garmin incidents July to October 2026. https://status.junction.com and https://status.junction.com/history
- [S49] P. Junction Terms of Service: Adept Labs Inc. dba Junction, Delaware law; may withdraw or amend the service without notice; no DPA referenced. https://www.junction.com/terms
- [S50] P, July 2026. Junction changelog: Strava is BYOO-only. https://docs.junction.com/changelog/wearables/providers.md
- [S51] S, 2026-10-14. intervals.icu developer's forum post relaying Garmin: rules "not new", "planned reopening", "easier path for individuals and apps". https://forum.intervals.icu/t/api-access-to-intervals-icu/609/829
- [S52] P, PDF dated 2026-03-03 (China variant). Garmin agreement template with section 15.10 "AI Transparency Statement" requiring explicit consent. https://www8.garmin.com/en-US/GARMINCONNECTDEVELOPERPROGRAMAGREEMENT/GARMINCONNECTDEVELOPERPROGRAMAGREEMENT_EN.pdf
- [S53] S, 2026-05-23. Garmin Connect phone app exports no files; single-activity export is via the website. Replaces the earlier riveralabs link, which now returns 404. https://www.fitmesh.fit/en/blog/export-garmin-data

Dropped: [S12] (Garmin sign-in question now answered by [S46]); [S14] (StatusGator's "Junction Garmin" page mirrors Junction's whole status page; replaced by [S48]); [S43] (dead link, replaced by [S53]).


---

## Comparison

| Option | Garmin today | Routes + per-km splits | COROS / Polar / Suunto / Wahoo | EU data hosting | Monthly cost at 10 / 100 / 1,000 users | Contract | Startup or partner offer | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Junction** (ex-Vital) | Docs say yes. Its own Garmin app is "Enabled", no approval needed [S8]. Status page shows no Garmin incidents July to October 2026 [S48]. Not public whether Garmin is on the $300 plan or is a premium (Enterprise) integration [S7]. Get it in writing. | Probably. The stream has GPS, HR, distance and time [S9]. Not documented that Garmin fills it, or at what rate. Junction's only Garmin rate is HR at a 15 s peak [S47]. Confirm. | No / Yes / Planned / Yes [S8] | Data stored in Belgium [S10]. US company, no public DPA [S49]. Plan coverage not stated. | $300 / $300 / custom, not public, if Garmin is on Launch [S7] | Monthly, no annual contract [S7]. Terms allow changes "without notice" [S49] | None. "No startup discounts" [S7] | **Approach first, conditional on written answers** |
| **Spike** | Says yes, "no separate Garmin approval" (Jan 2026, before the pause was public) [S16] | GPS and HR samples confirmed for Garmin [S18]. Laps and splits fields exist [S17] but are not listed for Garmin [S18] | Yes (no GPS) / Yes / Yes / Not listed [S18] | Unclear. Names USA and Germany, consent-based transfers [S19] | from $450 ("Sandbox" plan) / from $450 / not public [S15] | Not public | None published | **Backup** |
| **Thryve** | Yes, shared Garmin app [S25] | Unconfirmed. Has a GPS data category, but Garmin routes and laps are not documented [S25] | Not listed / Yes / Yes / Not listed [S25] | Yes, Germany [S24] | EUR 499 / EUR 499 / about EUR 749 [S24] | Priced per month; term not stated | Scale Up tier for startups under 10 years, from EUR 1,000 [S24] | **EU-hosted backup, if GPS is confirmed** |
| **ROOK** | Implied yes. Credential model not documented [S22, S42] | GPS and HR samples. Laps not mentioned [S22] | Not cloud / Yes / Not cloud / Not cloud (earlier lane, not re-checked) | No, US (AWS) [S23] | $747 / $747 / $999 [S21] | 12 months, 30 days' notice [S21] | Only by asking sales [S21] | Fourth choice |
| **Terra** | No. Needs your own Garmin app, which Terra says is Garmin's rule [S1]. Garmin feed in "Major outage" since 1 September [S2] | Would be yes (GPS, laps, FIT) if Garmin worked | All four, no own app needed. Suunto marked "Applications no longer open" [S3] | UK and Netherlands, may go to US [S45] | $399 or $499 / same / at least $899 or $999 [S4] | Annual for the $399 price [S4] | Accelerator, up to $100k credits, about 0.8% accepted [S5] | Not for Garmin. Maybe later for COROS. Never for Strava [S32] |
| **Sahha** | No. Needs your own Garmin app, beta and sandbox only [S26] | n/a | Not checked | DPA on all plans [S26] | $299 (annual billing) / $299 / $299 [S26] | Annual | Free 30-day sandbox | No |
| **Open Wearables** | No. Needs your own Garmin credentials [S27] | n/a | Polar, Suunto | Self-hosted | Free software, you pay hosting | n/a | n/a | No for Garmin |
| **Garmin direct** | No. Applications paused since spring 2026 [S30]. A reopening is "planned", no date [S51]. Business use only [S29] | Yes (FIT files) | n/a | n/a | Free [S29] | Agreement | n/a | Reapply when it reopens |
| **Strava** | Capped at 10 athletes. Higher tiers use one review form, no timeline [S33] | Yes | Any watch that syncs to Strava | n/a | Free, but developer needs a Strava subscription [S33] | API Policy | n/a | Beta only. No AI use, 7-day cache, no intermediaries [S34] |
| **Direct brand APIs** | n/a | Polar, Suunto: yes [S35, S36] | Polar self-serve [S35]. Suunto company only, reply within 2 weeks if accepted, open status unclear [S36, S3]. Wahoo on request [S38]. COROS needs an established platform and a company [S37] | Your own Supabase | Fees not public | Per brand | n/a | Polar now. Check Suunto is open, then apply |
| **Apple Health bridge + file import** (fallback, built) | Partly. HR, load and recovery arrive automatically | Only from a file the user uploads. The Garmin phone app cannot export files [S53] | Any watch that exports FIT | Your own Supabase | $0 | n/a | n/a | Safety net |

Cost notes:

- Junction's pricing page does not define "connected user" [S7].
- ROOK = $399 Core + $249 granular data + $99 webhooks. At 1,000 users, Core+ at $999 includes both add-ons among its three free picks [S21].
- Terra and Thryve figures at 1,000 users are my arithmetic from their published rates. Terra's is a floor, because data events beyond 400 per user per month cost extra [S4].
- Junction at 1,000 users would have been $500 under its old public rate of $0.50 per user [S13]. The current price is not public.
- Spike's $450 is labelled "Sandbox", and production terms are not stated [S15].

Source numbers are listed in full, with URL, primary or secondary, and date, at the end of the corrected recommendation and in /Users/tristanlouveaux/Documents/marathon-simulator/docs/audits/aggregator-research/factcheck.json ("sources").


---

## Draft outreach email (Junction)

```
To: sales@junction.com
Subject: Garmin, Polar and Wahoo data for a UK multi-sport training app

Hi Junction team,

I'm Tristan Louveaux, founder of Mosaic, an adaptive training app for running, triathlon, HYROX and cycling on iOS and the web. I'm a solo founder in the UK. Our backend is hosted in the EU, and we are preparing for public launch.

Mosaic builds a training plan, then adjusts it from what the athlete actually did. That needs full workout detail: GPS route, heart rate samples and distance, so we can compute per-km splits, heart rate zones and training load. Apple Watch users are covered through HealthKit. Garmin users are the gap I want Junction to close, with Polar and Wahoo alongside.

I'd like to start on the Launch plan in your EU region. Before I build, could you confirm in writing:

1. Garmin is included on the Launch plan, and is not one of the premium integrations reserved for Enterprise.
2. New customers can connect Garmin users today through Junction's Garmin app, without their own Garmin approval.
3. Garmin's current terms, including its revised developer agreement, allow an app like Mosaic to receive Garmin data through Junction, and what notice we would get if that changed.
4. Garmin workouts include the workout stream with latitude, longitude, distance and heart rate for runs, rides and swims. At what sample interval? Are raw FIT files available?
5. The EU (Belgium) region is available on Launch, with a signed data processing agreement (EU standard contractual clauses and the UK Addendum) and your subprocessor list.
6. Whether Garmin data received through Junction may be used in an in-app AI coaching feature.
7. Whether "connected user" counts each person once, or each device connection.

I've read that Launch has no startup discounts. Even so, would you consider a lower rate while we are small, such as $0.50 per connected user with no minimum until we reach 500 users, or a start date deferred to our public launch? In return I'm happy to write a public case study, show "Powered by Junction" on our connect screen, and give detailed feedback on the workout stream from a four-sport use case.

Happy to do a short call.

Thanks,
Tristan Louveaux
Founder, Mosaic
mosaicrunning.run

```

---

## Build plan

# Build plan: Junction feed into Mosaic

Estimates are agent hours, by analogy to the existing Garmin code. They are estimates, not measurements. Your device testing and vendor onboarding are extra.

The design in one line: the server stores what Junction sends, and the phone does the maths with the code it already has, then saves the finished activity back. This keeps one copy of the maths, the same way Apple Health already works.

## Step 0. Before any code (your time, about a week of waiting)

- Send the email. Do not build until Junction confirms Garmin in writing.
- Open the free Junction sandbox and pick the EU region. The region cannot be changed later [S10].
- Check on a phone that the in-app sign-in sheet works (ISSUE-284). The Junction connect screen uses the same sheet (src/data/oauth-native.ts:60).

## Step 1. Activities only (the version to launch)

| # | Piece | Hours | Where in the code |
|---|---|---|---|
| 1 | New table for connections, a raw-data table, and the per-user key fix from the data-isolation audit. Scoped SQL only, never `supabase db push`. | 4-8 | supabase/migrations/20260602000000_enable_rls_garmin_activities.sql; docs/DATA_ISOLATION_AUDIT.md (P1-1) |
| 2 | Webhook that receives Junction data, checks the signature over the raw body and refuses anything unsigned. Today's Garmin webhook lets calls through when its secret is missing, so do not copy that part. | 8-12 | model on supabase/functions/garmin-webhook/index.ts (lets calls through at :55-71); supabase/config.toml |
| 3 | Connect button: the server starts a Junction session, the phone opens it in the sign-in sheet, and our callback returns to the app. Account row and onboarding card for Garmin. | 8-12, plus a TestFlight test | src/data/garminOAuth.ts:21-39 (template); supabase/functions/garmin-auth-callback/index.ts:20-51; src/ui/wizard/steps/connect-data.ts:202-350; src/ui/account-view.ts:2256-2297 |
| 4 | Turn Junction streams into Mosaic activities: route, per-km splits, HR zones, load, laps, activity name. Save the finished row back. | 16-24 (8-12 if Junction sends FIT files) | src/data/fitImport.ts:501-631 (streamsToActivityRow); src/data/activityEnrichment.ts:295; src/calculations/stream-processor.ts:174; src/calculations/rep-detection.ts:141; src/data/appleActivityUpload.ts:125-185 (save-back pattern); supabase/functions/sync-activities/index.ts:36, :51 |
| 5 | Which copy wins. Turn Apple Health workouts off when Junction is connected (as already done for Strava), so the thinner Apple copy cannot replace the Junction one. Fix the clean-up that could delete a Junction row. Label badges by brand and show Garmin's name where Garmin data appears [S41, S42]. | 6-10 | src/data/sources.ts:57-59; src/calculations/activity-matcher.ts:482-512; src/data/stravaSync.ts:1239-1253; src/ui/renderer.ts:1336-1341 |
| 6 | History on first connect: request Junction's backfill, then build the training baseline and PBs from it, with an "importing your history" state in onboarding. | 10-16 | supabase/functions/garmin-backfill/index.ts; src/main.ts:1639-1653; src/data/appleHealthSync.ts:2066-2200; src/ui/wizard/steps/review.ts:157-170 |
| 8 | Disconnect and deletion: revoke at Junction, delete that brand's data, add new tables to account deletion and export, and name Junction in the privacy policy (both repos). Built generically, it also closes ISSUE-253 for Strava (about 4 more hours). | 8-12 | src/ui/account-view.ts:2281-2297; supabase/functions/delete-account/index.ts; supabase/functions/purge-deleted-accounts/index.ts:37-48; supabase/functions/export-user-data/index.ts:65; public/privacy.html:45-46, :73, :75-80 |
| 9 | Routing, feature flag, labels. New state fields optional only, no schema bump. | 4-8 | src/data/sources.ts; src/main.ts:1497-1555; src/types/state.ts; src/constants/feature-flags.ts |
| 10 | Tests, docs, and a check in every sport mode (running, triathlon, HYROX, cycling, just-track), then a TestFlight test. | 8-12 | docs/WEBHOOKS.md; docs/DEVICE_TESTS.md |

**Step 1 total: about 72 to 114 hours, or 64 to 102 if Junction sends FIT files.** That is roughly 2 to 3 weeks of agent work. (The codebase lane's headline of 55 to 85 hours is lower than the sum of its own pieces, so I use the piece sum.)

Order: pieces 1 to 5 can only be tested together. Pieces 5 and 9 touch shared files (main.ts, sources.ts, activity-matcher.ts, state.ts), so run them one at a time, not in parallel agents.

## Step 2. Later

| # | Piece | Hours | Where |
|---|---|---|---|
| 7 | Sleep, HRV and resting HR from Junction. Mainly helps web users, since iPhone users already get these from Garmin via Apple Health. | 6-10 | supabase/functions/sync-physiology-snapshot/index.ts; src/data/physiologySync.ts; src/main.ts:1572-1622 |

## Fallback build (only if no aggregator confirms Garmin)

- Finish iOS "Share to Mosaic" so a Garmin file can be sent to the app from the share sheet. The app side is written (src/data/shared-file-intake.ts). The iOS part (file types in Info.plist and an open-file handler) is not. My estimate: 4 to 8 hours plus a TestFlight test.

## Defaults I have chosen for you (say if you disagree)

- Strava still wins for the 10 beta athletes. No change to the current rule.
- Apple Health workouts switch off when Junction is connected. Apple still supplies sleep and HRV.
- On your own account, the direct Garmin activity feed switches off when Junction is connected, so runs are not counted twice. Your Garmin recovery data stays.
- Disconnecting a brand deletes that brand's data. This matches what Strava requires and keeps the privacy story simple.
- Version 1 is activities only.
