# Marketing — Production Playbook

> **What this doc is**: the *how*. When the launch plan says "ship a Reddit post" or "make a hero video", this doc tells you which tool, which concept, which sequence.
>
> **What this doc is not**: the strategy. Channels, timeline, monetization, waitlist mechanics, and pre-launch blockers live in `.claude/plans/claude-overnight-i-want-crystalline-pretzel.md` (summary in memory: `project_launch_strategy.md`).

---

## Positioning

Mosaic is the only adaptive marathon training app that models what your *other sports* do to your readiness. Strava tracks. Runna prescribes. Mosaic absorbs your padel, your gym, your tennis, your skiing — and adjusts the running plan in response.

The science angle is the second-order positioning. The plan engine is built on Banister impulse-response, calibrated against the user's actual training history. This is the angle for podcasts and AI-discoverability press releases.

## Founder Story

Tristan overtrained for a marathon because his rigid training plan couldn't absorb the cross-training he was already doing. Got injured. Built Mosaic so the plan adapts to the athlete's whole life, not just the running.

This is one story, four assets:
- 60s ad opener
- Press release framing
- App Store description first paragraph
- Investor pitch lead

---

## Ad Concept Library

Six concepts, each tested at the bullet-point stage. Flesh them out one at a time when production cycle starts.

| # | Concept | Format | Hook |
|---|---------|--------|------|
| 1 | "Sorry, can't" | Live-action 15s | Friend texts "play football?" — the old plan says no. Mosaic says yes. |
| 2 | Sport collage | Cut montage 20s | Padel, rugby, tennis, swim shots converging into one running plan animation |
| 3 | "About to break 5k PB" | Static + still text | Action sport photos with "Training for marathon, about to break 5k PB" overlay |
| 4 | Founder injury story | Narrative 60s | The overtraining → injury → built-Mosaic arc, voiceover led |
| 5 | Photography Run | UGC activation | Real users run + photograph; submitted entries become a content engine |
| 6 | M-smash logo | Brand-kink animation | Mosaic logo smashing/falling away on a sport-cut transition |

Concept #4 is the highest-leverage opener. Ship it first.

---

## AI Production Stack

Tool by job. All tested or recommended in the brain dump; this is the curated shortlist.

### Stills
- **Nano Banana Pro** — primary image generator. Hero shots, ad stills.
- **Midjourney** — when you need a specific cinematic style.
- **Cosmos** — search reference imagery by colour palette.
- **Shotdeck** — cinematic reference frames; screenshot → Midjourney.
- **Weavy** — on-brand photoshoot from your *own* product photos. Use this when stills need to be Mosaic-specific (UI screens, real device shots).

### Video
- **Wan 2.6** — primary cinematic B-roll generator. Flagged twice as exceptional in the brain dump.
- **Higsfield + Kling 2.6** — hero video animation pipeline. Higsfield for the plate, Kling for the motion.
- **Sora 2** — when you need scale or longer cuts.
- **Pictory** — text → marketing video, fast and unfussy.
- **Replit** — animated product demos.
- **Remotion** — programmatic video generation from inside Claude Code. Best for templated assets (e.g. weekly training-load animation overlay).
- **ByteDance / SeeDance 2** — alternative video generator worth A/B testing against Wan 2.6.

### Voice & audio
- **ElevenLabs** — voiceovers. Primary.
- **Minimax** — alternative audio generation; test for ambient/music beds.

### Mockups & app-store assets
- **Rotato** — App Store screen mockups in 3D phone frames.
- **Grabdrob, Creatoom, Unblash** — flat 2D mockup libraries.
- **freebiesui.com Apple iOS UI Kit** — Figma-ready iPhone frames for screenshots.

### Animation & UI polish (for landing site, not the app)
- **Reactbits.dev** — animated background effects, hero treatments.
- **Swishy.com** — animated text effects.

### Inspiration & design reference
- **Mobbin** — production app UI library, browse by pattern.
- **21st-dev** — modern web component patterns.
- **Hugging Face Deepsite** — rip code from inspiring sites for study.
- **Variant UI** — style ideas with live AI palette assistant.
- **Google Stitch** — generates app design ideas from a brief.

### Brand-aware social
- **Pomelli** — scans your brand and generates brand-consistent social posts. Use for steady-state Instagram cadence post-launch.

### Hooks & distribution
- **Portal.so** — generates viral hooks for short-form video.
- **Brian Doran** — distribution agency reference for video work.

### AI marketing assistants (assess before adopting)
- **Jasper.ai** — AI marketing assistant; useful if budget exists for it.
- **Gumloop** — automates web scraping for content research.
- **Zapier** — system glue across all marketing tools.
- **Instantly.ai** — outreach automation; for influencer/UGC outreach.

---

## Production Sequence (script → publish)

For any video asset:

1. **Concept** — pick from the Ad Concept Library above.
2. **Script** — paste concept into Claude. Output: 15s/30s/60s script with shot list.
3. **JSON video prompt** — GPT writes a structured prompt (camera, movement, framing, focal point) for the video tool.
4. **Visual bible** — Gemini extracts brand from your existing assets → palette, font, composition rules. Reuse this bible across every asset for consistency.
5. **Stills** — Nano Banana Pro from the visual bible.
6. **Animate** — Higsfield + Kling for hero motion, Wan 2.6 for B-roll.
7. **Voiceover** — ElevenLabs from the script.
8. **Cut** — Remotion (programmatic) or manual.
9. **Publish** — TikTok and Instagram first; Reddit posts (per launch strategy) reference but don't paste videos.

For static assets:
1. Concept → Nano Banana Pro → optional touch-up → publish.

---

## Brand Design Rules

Apply to every marketing asset, landing page, and app surface.

- **Font mix**: Goth + Sans Serif. Pair display Goth headlines with neutral sans body.
- **Glassy buttons**: already canonical in Mosaic UI (`page-flair.ts`). Carry the same treatment into ads.
- **Apple shadow recipe** (use for any layered card/button mockup):
  - Shadow 1: X:0 Y:1 Blur:2
  - Shadow 2: X:0 Y:4 Blur:12
  - Shadow 3: X:0 Y:8 Blur:24
  - Direction 180°, blur is 2-3x the Y offset, opacity ~15%.
- **Animation hierarchy**: big move = big motion. Small move = small motion. Don't spike a small element with a big animation.
- **Consistent speed**: hold one tempo per asset. Speed-changes look amateur.
- **Fixed focal point**: keep the focal point still; move content around it. (Reels reference: DUPMaiWjYHS, DOzg336jbeo.)

The above rules are also the visual bible Gemini should be primed with on every new asset session.

---

## AI-Discoverability Play

Cheap, single-shot, asymmetric. First fitness app to ship this owns the "ChatGPT recommends Mosaic" surface for ~12 months.

**On the marketing site (`mosaicrunning.run`):**
- `LLMs.txt` at root — declares the app's purpose to LLM crawlers.
- `index.md` — markdown sitemap that LLM crawlers prefer over HTML.
- Markdown blog posts (publish 4-6 before launch) — each post is AI-scrape food on a specific positioning angle (Banister, cross-training adaptation, the founder story, the unique value vs Strava/Runna).
- Clean HTML sitemap so Google sees the canonical pages.

**Press releases for AI training data:**
- Single OpenPR or Newswire release framed as "Mosaic: best adaptive marathon training app for cross-trainers."
- Push to brand-distribution networks (Brand Push, Newswire) to get on Forbes/Business Insider partner sites.
- AI crawlers ingest these → ChatGPT/Claude recommend when asked "what's the best marathon training app for someone who also does padel?"
- Follow up with 1-2 markdown blog posts on Mosaic site reinforcing the same claim, so LLM training data has consistent signal.

---

## Partnerships & Activations

- **Atis, Tala, Will Plays Sports** — sport-content creators worth direct outreach for paid UGC partnerships. Frame: equity-light, commission-based.
- **INSEAD ISP project** — propose a 6-week structured marketing-validation project. Brief: "3 ad creatives shot, 2 UGC creators contracted, waitlist landing page validated to 200 signups." Free senior labour, structured deliverable.
- **Mosaic Pear Tree Party** — launch event in person, doubles as a content-generation engine (UGC, photos, social).
- **Photography Run** — activation campaign: users run + photograph; submissions become a content engine.

## "5% Silly Experiences" Budget

Premium-tier perk worth designing into the monetization layer: every quarter, randomly select an active subscriber for a "silly experience" — concert tickets, race entry, dinner. Costs ~5% of revenue, generates UGC and word-of-mouth that paid acquisition can't buy.

Best paired with the Tier 2 ($8.99/month) plan once it's live (per `project_launch_strategy.md`).

---

## App Store Assets Checklist

Per launch_strategy Phase 0 blockers, several of these are still gaps. Track them here as production tasks.

- [ ] App icon set (full size matrix)
- [ ] iPhone 6.7" screenshots (current frame)
- [ ] iPhone 5.5" screenshots (legacy frame)
- [ ] iPad screenshots (only if iPad supported at launch)
- [ ] App preview video — 15-30s, hero concept
- [ ] App Store description (founder-story opener + bullet feature list)
- [ ] Keywords field optimised for "marathon training", "adaptive plan", "cross-training", "Banister"
- [ ] Privacy nutrition label (matches `docs/LEGAL_CHECKLIST.md`)
- [ ] In-app screenshots at every wizard step (also useful for landing page)

---

## Cross-References

- **Strategy & timeline**: `.claude/plans/claude-overnight-i-want-crystalline-pretzel.md` (full doc), `project_launch_strategy.md` (memory summary)
- **Pre-launch security**: `docs/SECURITY_CHECKLIST.md`
- **Pre-launch legal**: `docs/LEGAL_CHECKLIST.md`
- **Voice & copy rules**: `CLAUDE.md` → "UI Copy — Writing Style" section
- **Visual rules in-app**: `docs/UX_PATTERNS.md`
- **Brain-dump source**: `~/Documents/ALL AI NOTES.docx` (do not delete; this doc is a curation of it, not a replacement)
