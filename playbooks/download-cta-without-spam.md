---
id: download-cta-without-spam
version: 2
name: Download CTA without the spam
summary: Ask for the install after giving value first, with one CTA, the right link placement per platform and trackable store links.
goal: conversions
platforms: [all]
formats: [text, thread, image, carousel, video]
tags: [mobile-app, game, cta, conversion, store-links]
inputs: [app or game name, the value the post gives on its own, iOS and Android store links, price model, App Store campaign provider token or UTM scheme, whether the app is live or in pre-registration or TestFlight]
---

## When to use
Use whenever a post includes an ask to download, install, pre-register or join a beta. This playbook is a layer on top of other content: write the post with another playbook (feature spotlight, game clip, update notes), then apply these rules to the CTA. Rule of thumb for an account's feed: most posts give something (a tip, a laugh, a behind-the-scenes look) with no hard CTA; roughly one post in four or five asks directly (unverified: test it). An account that asks every time trains its followers to scroll past.

## Structure
1. **Value first.** The post must be worth reading for someone who never installs: a useful tip, a satisfying clip, a story. If you delete the CTA and the post is empty, rewrite it.
2. **Choose soft or hard CTA.**
   - *Soft:* names the app and where it lives, no imperative. "Tempo is free on iPhone." Use for most posts.
   - *Hard:* direct ask with a reason and the link. "Try the 7-day challenge in Tempo: {link}". Use for launches, big updates, sales that are real.
3. **One CTA per post.** Not "download, follow, share and leave a review".
4. **Make the CTA specific:** what they get, what it costs, which platforms. "Free, no account needed, iPhone and Android" answers the obvious questions up front (unverified: test it).
5. **Place the link where it's clickable and doesn't cost reach** (see notes). In Postflare, use a follow-up item for links on X and on Bluesky/Threads posts with video, and as the first comment on Facebook and LinkedIn company pages.
6. **Make the link measurable.** App Store: `https://apps.apple.com/app/apple-store/id{appId}?pt={providerToken}&ct={campaign}&mt=8`. The provider token comes from generating a campaign link in App Store Connect (available once the app has analytics data); `ct` is up to 30 characters; App Store Connect shows impressions, product page views, downloads and sales per `ct` after 24 hours, last-click, minimum 5. Google Play: `https://play.google.com/store/apps/details?id={package}&referrer=utm_source%3D{platform}%26utm_campaign%3D{campaign}` (referrer URL-encoded, ≤ 512 chars); Play Console reports these as "Tracked channels (UTM)" for visits in the Play Store app (web play.google.com visits aren't counted). One smart link that detects the device is fine if it forwards these parameters; test both iOS and Android before posting.

## Platform notes
- **X:** 280 chars; any URL counts as 23. Buffer's 2025 analysis found near-zero median engagement on link posts from non-Premium accounts; X's head of product says links aren't deboosted (Apr 2026). Default to the store link in a follow-up reply. The X API bills every post with a URL $0.20 vs $0.015, reply or not, so one link per thread.
- **Bluesky:** 300 graphemes. A link card with the store page preview is fine in the main post if there's no video. No documented link penalty (unverified: test it).
- **Threads:** 500 chars, one topic tag, up to 5 links. Meta says link posts have ranked normally since mid-2025, so a link in the post is fine.
- **Mastodon:** 500 chars default; links count as 23 and are fine in the post. Audiences there dislike marketing tone; a soft CTA fits best.
- **Instagram:** caption links aren't clickable (Meta is only testing clickable caption links for Meta Verified). "Link in bio" plus the store name. Max 5 hashtags.
- **TikTok:** no clickable caption links; a clickable bio link needs a business account or enough followers (unverified: check in-app). "Search {app name} on the App Store / Google Play" works without one. Turn on commercial content disclosure and pick "Your brand".
- **YouTube Shorts:** URLs in Shorts descriptions and comments are not clickable. Use the channel's profile links ("link on my channel") or a Related Video link to a long-form video whose description holds the store link.
- **LinkedIn:** 3,000 chars; the preview cuts after 2–3 lines. Third-party data shows link penalties mainly on company pages; there, use the first comment. On personal profiles a body link costs little reach (unverified: test it).
- **Facebook:** link in the first comment. Meta has tested capping link posts for Pages and professional-mode profiles without Meta Verified (Dec 2025); links in comments aren't capped.
- **Pinterest:** the pin's destination link is the CTA itself; point it at the store or a landing page.
- **Reddit:** read the subreddit rules; many ban direct store links or limit self-promotion, and moderators check whether your account does anything besides promote. Disclose you're the developer.
- **Store badges:** in images, use Apple's official "Download on the App Store" badge and Google's "Get it on Google Play" badge unmodified (no recoloring, angling, animating, cropping or rearranging), one App Store badge per layout or video, clear space of a quarter of the badge height, Google Play badge at least as large as other store badges. Don't use the standalone Apple logo, "iPhone {app name}" naming (say "{app name} for iPhone"), the word "iOS" in marketing, or wording that suggests Apple or Google endorses the app.

## Hooks
- **Value then name:** "{Useful tip}. (I built {app name} to do this automatically.)" — the tip carries the post; the app is the obvious next step.
- **Objection killer:** "Free, no sign-up, works offline: {what it does}." — answers why-not before they ask.
- **Real reason to act now:** "{App name} is {price/free} until {real date}." — urgency only when the deadline is real.
- **Pre-launch:** "Pre-register on Google Play and it can install itself on {launch date}." — tells them exactly what happens next. Auto-install only happens for users who opted in, on eligible devices, and for apps under 200MB on mobile data (up to 2GB on Wi-Fi).

## Examples
### Threads (post + follow-up)
```
Water plants by the soil, not the calendar. Push a finger 2 cm in: dry means water, damp means wait. Pots without drainage holes need half as much.

I made Pocket Plants so I'd stop forgetting the finger test. Free on iPhone and Android.
```
(Post: 237 characters)
```
Follow-up: https://pocketplants.example/get?utm_source=threads&utm_campaign=soil-tip
```

### X (hard CTA, launch day)
```
Tiny Tower Defense is out today.

30 waves, no energy timers, no ads between levels. One-time unlock after wave 10 if you like it.

Free to start on iPhone and Android.
```
(Post: 168 characters)
```
Follow-up: App Store: https://apps.apple.com/app/apple-store/id123456789?pt=000000&ct=x-launch&mt=8
Google Play: https://play.google.com/store/apps/details?id=com.example.tinytd&referrer=utm_source%3Dx%26utm_campaign%3Dlaunch
```

## Avoid
- "Download now!!!" with nothing else in the post.
- Several CTAs in one post (download + follow + rate + share).
- Fake urgency: "last chance", countdowns to nothing, "limited spots" for an app anyone can install.
- URLs in Shorts descriptions or TikTok/Instagram captions where they can't be tapped; "link in bio" on Bluesky, Threads or Mastodon where links work.
- Modified store badges, the Apple logo used decoratively, or "approved by Apple/Google" wording.
- Untracked bare links, so you can't tell which platform drove installs.
- Promising "free" when core features are behind a paywall without saying so.
- Linking to a TestFlight or pre-registration page without saying it's a beta or not yet released.
- Promoting the app on TikTok without the commercial content disclosure.

## Checklist
- [ ] The post is still worth reading with the CTA removed.
- [ ] Exactly one CTA, soft or hard chosen on purpose.
- [ ] Price model, platforms and availability are stated accurately.
- [ ] Link placement matches the platform (follow-up on X, first comment on Facebook and LinkedIn pages, bio on Instagram/TikTok, profile or Related Video on Shorts).
- [ ] Every store link carries a campaign token (`pt` + `ct`) or Play referrer UTM, unique per platform.
- [ ] Both iOS and Android links (or the smart link) were opened and land on the right store page.
- [ ] Store badges, if shown, are official and unmodified.
- [ ] Any urgency refers to a real date or real offer.
- [ ] TikTok commercial content disclosure is on ("Your brand").
- [ ] Recent posts on this account weren't all hard CTAs too.

## Sources
- [Campaign links — App Store Connect Analytics Help, Apple, 2026](https://developer.apple.com/help/app-store-connect-analytics/acquisition/campaign-links) — pt/ct/mt link format, metrics, 24h delay, threshold, last-click.
- [User Acquisition for Google Play Games on PC — Android Developers, 2026](https://developer.android.com/games/playgames/user-acquisition) — Play URL with URL-encoded UTM referrer, 512-char limit.
- [Measure your app's acquisition and retention — Play Console Help, Google, 2026](https://support.google.com/googleplay/android-developer/answer/6263332?hl=en) — "Tracked channels (UTM)", web visits not tracked.
- [Marketing Resources and Identity Guidelines — Apple Developer, 2026](https://developer.apple.com/app-store/marketing/guidelines/) — badge rules, Apple logo, product naming, no "iOS".
- [Lockups, icons, and badges: Google Play — Google Partner Marketing Hub, 2026](https://partnermarketinghub.withgoogle.com/brands/google-play/google-play/lockups-icons-badges/#badges) — badge must not be altered; size relative to other badges.
- [Build awareness for your apps with pre-registration — Play Console Help, Google, 2026](https://support.google.com/googleplay/android-developer/answer/9859047?hl=en) — auto-install for opted-in users, size limits.
- [Sharing links with your audiences — YouTube Help, 2026](https://support.google.com/youtube/answer/13748639?hl=en) — Shorts URLs not clickable; profile and Related Video links are.
- [Facebook is testing a link posting limit for professional accounts and pages — TechCrunch, 2025](https://techcrunch.com/2025/12/17/facebook-is-testing-a-link-posting-limit-for-professional-accounts-and-pages) — link-post cap test; comments exempt.
- [Do Posts with Links Affect Content Performance on X? — Buffer, 2025](https://buffer.com/resources/links-on-x/) — link posts underperform on X.
- [X API pay-per-usage pricing — X Developer Platform, 2026](https://docs.x.com/x-api/getting-started/pricing) — $0.20 per post with URL vs $0.015.
