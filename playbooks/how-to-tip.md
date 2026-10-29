---
id: how-to-tip
version: 2
name: How-to tip
summary: One actionable tip in a single post, outcome first, with specific steps a reader can do in under five minutes.
goal: reach
platforms: [microblog, professional, instagram, instagram_standalone, short-video, pinterest, facebook]
formats: [text, image, video]
tags: [how-to, tip, educational, tutorial, mobile-app, game, saas]
inputs: [the outcome the tip delivers, the exact steps, the tool or app involved, who it is for, a screenshot or screen recording, product name if relevant]
---

## When to use
Use for a single, self-contained tip that gives a concrete result fast: a setting, a shortcut, a technique, a hidden feature. Shares are a top reach signal (Instagram names sends among its top three ranking signals, weighted most for non-followers), and people share tips that make them look helpful. If the tip needs more than 5 steps or a lot of context, use text-thread or listicle-carousel instead. The tip should work even for people who never use your product, or clearly be about your product's feature for existing users.

## Structure
1. **Line 1, the outcome (≤ 70 characters, no emoji first):** what the reader gets, not what the tip is called. "Stop your phone buzzing during focus blocks, automatically."
2. **Line 2, who/when (optional):** one line of context ("If you use Focus modes on iPhone:").
3. **Steps (2–5 lines):** numbered, each starting with a verb, using the exact menu names in the order they appear. "1. Settings > Focus > Work".
4. **The result (1 line):** what happens now, so the reader knows it worked.
5. **Optional extra (1 line):** a variation or pro tip.
6. **Visual:** a screenshot with the tapped element highlighted, or a 10–20 second screen recording with burned-in captions (many people watch muted).
7. Product link, if any, in a `thread` follow-up (first reply / first comment).

## Platform notes
- **X:** 280 chars, URLs count as 23 (Premium allows longer posts). Outcome plus 3 short steps usually fits. X says links are not deboosted, but Buffer's 2025 data showed near-zero engagement on non-Premium link posts, so keep the link in the first reply (unverified: test it). Via the API any post with a URL, reply included, costs $0.20 vs $0.015, so post the link once.
- **Bluesky:** 300 graphemes, up to 4 images. Every image carries an alt field; put the steps in it for screen-reader users.
- **Threads:** 500 chars, room for steps plus the extra. One topic tag per post.
- **Mastodon:** 500 chars by default (instances can raise it; links count as 23). Use CamelCase hashtags (#iOSTips) so screen readers say the words separately. Alt text (media description) on every image is the norm.
- **LinkedIn:** 3,000 chars. Put the outcome and first step in the opening line or two; the "…see more" cut is observed around 140 chars on mobile and 210 on desktop (unverified: test it). Metricool's 577K-post study found posts with links got 13.57% more interactions, so a link in the body is fine.
- **Instagram:** only the first line or so of the caption shows before "more" (~125 chars rule of thumb; unverified: test it), so the outcome is line 1. Single image, carousel or Reel. Max 5 hashtags, alt text, no clickable links.
- **TikTok / Reels / Shorts:** show the end result in the first 3 seconds, then the taps. On-screen text with each step, inside the safe zone. Vertical 9:16. TikTok captions via the API max 2,200 chars; hashtags 3–5 is common practice (unverified: test it). Shorts title ≤ 100 chars; URLs in Shorts descriptions and comments are not clickable, so name the app on screen or use a Related Video link.
- **Pinterest:** vertical 2:3 image (1000×1500) with the steps; title ≤ 100 chars stating the outcome (about 40 show in feed), description ≤ 800 chars, the destination link is the pin's link.
- **Facebook:** fine as text plus image; link posts had the lowest median engagement of Facebook formats in Buffer's data, so put links in the first comment (unverified: test it).

## Hooks
- **Outcome-first:** "{Desired result} in {short time}:" — the reader knows the payoff before investing.
- **Hidden setting:** "{App or device} has a setting that {benefit}. It's off by default." — novelty plus a concrete action.
- **Replace a habit:** "Stop {tedious manual task}. Do this once instead:" — names the pain and promises a one-time fix.
- **Exact number:** "{N} taps to {result}." — specificity signals it's genuinely quick.

## Examples
### X (single post)
```
Silence every app except your calendar during focus, automatically:

1. Settings > Focus > Work
2. Allowed Apps: add only Calendar
3. Add Schedule: weekdays 9-11am

Your phone goes quiet at 9 without you touching it.
```
(216 chars)

### Instagram (image + caption)
```
Water your plants by light, not by calendar, in 3 taps.

1. Open the plant in Pocket Plants
2. Tap Location > choose the window direction
3. Turn on Seasonal adjust

Reminders now stretch out in winter and tighten in summer, so you stop overwatering in the dark months.

#plantcare #houseplants #planttips
```
(first line about 55 chars, above the fold)

### TikTok (on-screen text + caption)
```
On-screen 0-2s: tower placed in the wrong spot, then it vanishes and refunds
On-screen 3-10s: "Long-press any tower > Undo (works for 5 seconds)"
Caption: You can undo a tower in Tiny Tower Defense 2.0. Long-press it within 5 seconds of placing. #towerdefense #mobilegames #gamingtips
```

## Avoid
- Titles instead of outcomes ("Focus mode tip #12").
- Steps with vague verbs ("configure your settings") instead of exact menu paths.
- More than 5 steps in a single post; split it into a thread or carousel.
- Tips that only work on an old version or a paid tier without saying so.
- Clickbait hooks the tip does not deliver ("this changes everything").
- "Save this or you'll regret it" style bait.
- Links in the main post on X, or a URL in a Shorts description or comment.
- Images without alt text.

## Checklist
- [ ] Line 1 states the outcome in ≤ 70 characters.
- [ ] Steps are numbered, start with verbs and use exact menu names.
- [ ] Steps were checked against the current app or OS version.
- [ ] The result line says what changes for the reader.
- [ ] The post fits the platform limit and the outcome is above the fold.
- [ ] Screenshot or video shows the result early and has alt text.
- [ ] Any link sits in a `thread` follow-up on X, Instagram and Facebook (body is fine on LinkedIn; pin link on Pinterest).
- [ ] Hashtags: at most 5 on Instagram, 3–5 on TikTok, one topic tag on Threads, CamelCase everywhere.

## Sources
- [Instagram shares algorithm insights for 2025 — Social Media Today, 2025](https://www.socialmediatoday.com/news/instagram-shares-algorithm-insights-2025/738034/) — sends among the top three signals, weighted more for non-followers.
- [Instagram is implementing new limits on hashtag use — Social Media Today, 2025](https://www.socialmediatoday.com/news/instagrams-implementing-new-limits-on-hashtag-use/808309/) — 5-hashtag cap on posts and Reels.
- [Counting characters — X Developer Platform, 2026](https://docs.x.com/fundamentals/counting-characters) — 280 chars, URLs count 23.
- [X API pay-per-usage pricing — X Developer Platform, 2026](https://docs.x.com/x-api/getting-started/pricing) — $0.20 per post with URL vs $0.015.
- [Do posts with links affect content performance on X? — Buffer, 2025](https://buffer.com/resources/links-on-x/) — near-zero engagement on non-Premium link posts.
- [Publishing posts — Mastodon documentation, 2026](https://docs.joinmastodon.org/user/posting/) — 500-char default, links count 23, media descriptions.
- [Social media accessibility guidelines — American Foundation for the Blind, 2026](https://www.afb.org/digital-inclusion/accessibility-resources/social-media-accessibility-guidelines) — CamelCase hashtags, own alt text, open captions.
- [Threads API: Posts — Meta for Developers, 2026](https://developers.facebook.com/docs/threads/posts) — 500 chars, one topic tag per post.
- [LinkedIn study finds adding links boosts engagement by 13% — Search Engine Journal, 2025](https://www.searchenginejournal.com/linkedin-study-finds-adding-links-boosts-engagement-by-13/544524/) — Metricool: link posts +13.57% interactions.
- [Pinterest product specs — Pinterest Business Help, 2026](https://help.pinterest.com/en/business/article/pinterest-product-specs) — 2:3, title 100, description 800.
- [Sharing links with your audiences — YouTube Help, 2026](https://support.google.com/youtube/answer/13748639?hl=en) — Shorts description/comment URLs not clickable.
- [The State of Social Media Engagement in 2026 — Buffer, 2026](https://buffer.com/resources/state-of-social-media-engagement-2026/) — link posts lowest median engagement on Facebook.
