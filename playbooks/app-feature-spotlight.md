---
id: app-feature-spotlight
version: 2
name: App feature spotlight
summary: One feature, one problem, shown in the first seconds — the post that sells an app without a sales pitch.
goal: conversions
platforms: [short-video, instagram, instagram_standalone, x, threads, bluesky]
formats: [video, image, carousel]
tags: [mobile-app, product, feature, demo]
inputs: [app name, the one feature to show, the problem it solves in the user's words, a screen recording or screenshots, store link, price or free tier]
---

## When to use
Use when you want installs from people who don't know the app yet. Pick exactly one feature that solves a problem people already complain about ("I forget to water my plants", "I can't focus for more than 10 minutes"). Good for a new feature, a feature users keep praising in reviews, or an evergreen core feature you can re-spotlight every few weeks with a new angle. Not for release roundups (use app-update-notes-to-social) or for listing five features at once.

## Structure
1. **Line 1 / first second: the problem**, ≤ 70 characters, in the user's words, no emoji at the start. "I kept killing my plants" beats "Introducing Smart Reminders".
2. **The feature solving it, on screen, within 3 seconds.** TikTok's own creative guidance is to state the value proposition in the first 3 seconds and land the hook within 6. Use a real screen recording of the app (iOS Control Center screen recording or Android's built-in recorder), not polished store screenshots; TikTok recommends a DIY, not-overly-polished look that fits in with user content. Show full signal, Wi-Fi and battery icons (Apple's marketing guideline for device screens); a 9:41 clock is a common convention, not a rule. Hide notifications and use fictional account data.
3. **One concrete outcome**: a number, a before/after, or the moment of relief ("now it pings me the day the soil is dry").
4. **One CTA**, soft by default: the app name plus where to get it ("Pocket Plants, free on iPhone and Android"). Where links hurt reach or aren't clickable, put the link in a follow-up or the profile.
5. **Length: roughly 15–35 seconds.** Hootsuite's 2026 guidance puts TikTok at 20–35s and Reels/Shorts at 15–45s; a single-feature demo can be shorter if it lands (unverified: test it). Loop-friendly endings (cut back to the problem state) help replays (unverified: test it).

## Platform notes
- **TikTok / Reels / Shorts:** vertical 9:16, 1080x1920. Open on the problem as on-screen text over the app already moving; keep text inside the UI safe zone (away from the bottom caption area and right-side buttons). TikTok captions via the API (which Postflare uses) max out at 2,200 characters; 1–2 lines plus 3–5 hashtags is enough. TikTok requires the commercial content disclosure toggle when you promote a product, including your own: choose "Your brand" (label: "Promotional content"). TikTok and Instagram captions don't have clickable links: say "search {app name} on the App Store" or "link in bio".
- **YouTube Shorts:** title ≤ 100 chars. URLs in Shorts descriptions and comments are not clickable (since Aug 2023). Use the channel's profile links, or a Related Video link to a long-form demo whose description holds the store link.
- **Instagram feed:** carousel of up to 10 frames (the publishing API cap; the app allows 20): frame 1 states the problem, frames 2–4 show the feature, last frame shows the app icon and name. The "more" fold is roughly the first 125 characters (not documented by Meta), so the problem goes first. Max 5 hashtags per post since Dec 2025. Add alt text to every image.
- **X:** 280 chars; any URL counts as 23. Buffer's analysis of 18.8M posts found link posts from non-Premium accounts got near-zero median engagement in 2025, while X's head of product says links aren't deboosted (Apr 2026). Default: native video in the main post, store link in a follow-up reply. Note the X API bills any post containing a URL at $0.20 vs $0.015 without, whether it's the main post or a reply.
- **Threads:** 500 chars, one topic tag per post (e.g. "Indie Apps"). Meta says link posts have been ranked normally since mid-2025, so a link in the post is fine; with a video, put it in a follow-up reply to keep the video first.
- **Bluesky:** 300 graphemes. A link card is fine; if the post already has video, put the link in a reply. No documented link penalty (unverified: test it).
- **Measuring installs:** use an App Store Connect campaign link (`https://apps.apple.com/app/apple-store/id123456789?pt={provider-token}&ct=tiktok-spotlight&mt=8`); `ct` is up to 30 characters, App Store Connect shows impressions, product page views and downloads per campaign after 24 hours, with a minimum threshold of 5. On Google Play add `&referrer=utm_source%3Dtiktok%26utm_campaign%3Dspotlight`. A smart link (one URL that routes iOS vs Android) is fine if it preserves those parameters.

## Hooks
- **Pain in their words:** "I {failed at thing} for {time}. Then I found this." — mirrors a thought the viewer has had, so they self-select.
- **Watch it happen:** "{Task} in {seconds} seconds:" — promises a fast payoff, which keeps people watching to the end.
- **The tiny detail:** "The {feature} in {app name} nobody talks about" — curiosity about something small and specific, credible because it's shown immediately.
- **Old way vs new way:** "{Old annoying way} vs {app name}" — split screen does the persuading, no claims needed.

## Examples
### TikTok (video caption + on-screen text)
```
On-screen 0-2s: "I killed 4 plants this year"
On-screen 2-6s: [scan a plant -> Pocket Plants identifies it]
On-screen 6-10s: "now it tells me the exact day to water"
On-screen end: "Pocket Plants · App Store + Google Play"

Caption:
Scan once, get a watering schedule that adjusts to the season. Free on iPhone and Android, search Pocket Plants 🌱
#planttok #plantcare #houseplants #indieapp

Disclosure: Commercial content on, "Your brand"
```
(Caption: 157 characters)

### X (post + follow-up)
```
I kept breaking focus every 8 minutes.

Tempo's "hard mode" locks the timer: no pause button, no skipping the break. 25 minutes and it's done.

[video: 12s screen recording]
```
(Post: 142 characters)
```
Follow-up: Tempo is free on iPhone, hard mode included: https://apps.apple.com/app/apple-store/id123456789?pt=000000&ct=x-spotlight&mt=8
```

## Avoid
- Listing features ("Reminders! Widgets! Dark mode!"). One post, one feature.
- Leading with the app name or "Introducing…": nobody cares yet.
- Polished store screenshots with device frames and gradient captions on TikTok/Reels; TikTok's own guidance favors a native, DIY look.
- Fake urgency ("only today", "before it's gone") for an app that is always available.
- Store URLs in Shorts descriptions or TikTok captions (not clickable); "link in bio" on Bluesky or Threads, where links work.
- Calling the app "the best", comparing to a named competitor, or saying "iOS app" / "iPhone app {name}" (Apple's guidelines: say "{name} for iPhone" and don't refer to iOS in marketing).
- Posting promotional TikToks without the commercial content disclosure.
- The same caption pasted to every platform.

## Checklist
- [ ] Exactly one feature and one problem, and the problem is in line 1 / the first 2 seconds.
- [ ] The video or images are real in-app captures with no personal data, notifications or debug UI visible.
- [ ] Video is vertical 9:16, roughly 15–35 seconds, with text inside the safe zone.
- [ ] One CTA only, and it names the store(s) where the app is actually available.
- [ ] Links sit where they're clickable: follow-up on X, profile or Related Video on Shorts, bio on Instagram/TikTok.
- [ ] TikTok commercial content disclosure is on with "Your brand".
- [ ] The store link carries a campaign token (`pt` + `ct`) or Play referrer UTM so installs can be attributed per platform.
- [ ] Character and hashtag limits checked (X 280, Bluesky 300, Threads 500, Instagram 5 hashtags).
- [ ] Alt text added to images.
- [ ] Price claims ("free", "no ads") match the current store listing.

## Sources
- [Creative best practices for performance ads — TikTok for Business, 2025](https://ads.tiktok.com/resources/help/article/creative-best-practices) — 3s value prop / 6s hook, 9:16, safe zone, DIY style.
- [How to turn on the Commercial Content Disclosure setting in TikTok — TikTok for Business, 2026](https://ads.tiktok.com/help/article/how-to-turn-on-the-commercial-content-disclosure-setting-in-tiktok) — disclosure required when promoting a product, "Your brand" option.
- [Content Posting API: Direct Post — TikTok for Developers, 2026](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post) — 2,200-character caption limit via API.
- [How long should a social media video be? — Hootsuite, 2026](https://blog.hootsuite.com/social-media-video-length/) — TikTok 20–35s, Reels/Shorts 15–45s.
- [Sharing links with your audiences — YouTube Help, 2026](https://support.google.com/youtube/answer/13748639?hl=en) — Shorts description/comment URLs not clickable; Related Video link is.
- [Do Posts with Links Affect Content Performance on X? — Buffer, 2025](https://buffer.com/resources/links-on-x/) — near-zero engagement on non-Premium link posts.
- [X API pay-per-usage pricing — X Developer Platform, 2026](https://docs.x.com/x-api/getting-started/pricing) — $0.20 per post with URL vs $0.015 without.
- [Campaign links — App Store Connect Analytics Help, Apple, 2026](https://developer.apple.com/help/app-store-connect-analytics/acquisition/campaign-links) — pt/ct/mt format, metrics per campaign, thresholds.
- [Marketing Resources and Identity Guidelines — Apple Developer, 2026](https://developer.apple.com/app-store/marketing/guidelines/) — status bar icons, "{name} for iPhone", no "iOS" in marketing.
