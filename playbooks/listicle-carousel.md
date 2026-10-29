---
id: listicle-carousel
version: 2
name: Listicle carousel
summary: An "N things" list as an Instagram or LinkedIn carousel or a text list, built slide by slide to be saved and shared.
goal: reach
platforms: [instagram, instagram_standalone, linkedin, linkedin_page, threads, x, bluesky, facebook]
formats: [carousel, image, text, thread]
tags: [listicle, carousel, educational, save-worthy, mobile-app, game, saas]
inputs: [topic, target audience, the list items with one specific detail each, number of items, brand colors and font, product name if mentioned, slide size]
---

## When to use
Use when you have 5–10 genuinely useful, specific items on one topic: tools, mistakes, settings, tactics, examples. Carousels are the highest-engagement format on Instagram and LinkedIn in Buffer's 2026 analysis of 52M+ posts, and on Instagram sends (shares by DM) are one of the top three ranking signals, weighted more for reaching non-followers. If the list would not be worth screenshotting, it is not save-worthy. Your product can be one item, not every item.

## Structure
1. **Cover slide:** the promise in ≤ 8 words, large type, the number in it ("7 watering mistakes that kill houseplants"). Readable as a thumbnail.
2. **Slide 2, context (optional):** one line on who this is for or why it matters. Skip if the cover is clear.
3. **One item per slide:** numbered heading (≤ 6 words) plus 1–3 short lines with the specific detail, number or example. Same layout every slide.
4. **Best item early:** place the strongest item at position 2 or 3 so swipers stay (unverified: test it).
5. **Recap slide (optional):** all items as a checklist; this is the slide people screenshot.
6. **Last slide, the CTA:** one action, e.g. "Save this for your next repotting" or "More plant tips at @pocketplants". One CTA only.
7. **Caption:** first line restates the promise (≤ 125 chars before the Instagram fold), then 1–3 lines of context, then up to 5 specific hashtags.
8. **Text-list version:** title line with the number, then one line per item ("1. …"), then the closing line.

## Platform notes
- **Instagram:** the app allows up to 20 slides, but the publishing API Postflare uses caps carousels at 10 items, so plan 10 or fewer. Use 1080×1350 (4:5), the tallest ratio the API accepts (4:5 to 1.91:1); every slide is cropped to the first slide's ratio. Caption 2,200 chars; only the first line or so shows before "more" (~125 chars rule of thumb; unverified: test it). Instagram now caps captions at 5 hashtags and says hashtags do not add reach, so use 1–5 topical ones. Alt text per slide with the slide's text. No clickable links; "link in bio" only if needed.
- **LinkedIn:** upload as a document/PDF carousel or multi-image; document carousels had the highest median engagement of any LinkedIn format in Buffer's data (21.77%) and Metricool's 577K-post study. Post text up to 3,000 chars; put the promise and the number in the first line or two, since the "…see more" cut is observed around 140 chars on mobile and 210 on desktop (unverified: test it). Links: Metricool found posts with links got 13.57% more interactions, so a link in the body is fine; a first-comment link is a habit, not a rule.
- **Threads:** 500 chars per post; post the text list, or a carousel (up to 20 images) with the list in a reply. One topic tag per post.
- **X:** 280 chars (Premium allows longer posts). A short list fits one post; longer lists become a `thread`, one item per post. Up to 4 images per post. Put the link only in the last reply: non-Premium link posts drew near-zero engagement in Buffer's 2025 data (X disputes a penalty), and through the API any post with a URL costs $0.20 instead of $0.015.
- **Bluesky:** 300 graphemes, up to 4 images, each with alt text; same thread approach.
- **Facebook:** multi-image or text list; link posts had the lowest median engagement of Facebook formats in Buffer's data, so keep the list as images or text and put any link in the first comment (unverified: test it).

## Hooks
- **Number + outcome:** "{N} {things} that {specific outcome}" — the number sets an expectation and a finish line.
- **Mistakes:** "{N} {topic} mistakes {audience} make (and the fix)" — loss framing, and each fix is the payoff.
- **Tested list:** "I tried {N} {tools or methods} for {goal}. Here are the {M} that stuck." — filtering signals effort.
- **Settings/shortcuts:** "{N} {app or tool} settings you probably haven't turned on" — concrete and immediately actionable.

## Examples
### Instagram carousel (Pocket Plants)
```
Slide 1: 7 watering mistakes that kill houseplants
Slide 2: 1. Watering on a schedule. Light changes with seasons; check the top 2 cm of soil instead.
Slide 3: 2. Pots without drainage holes. Water pools at the bottom and roots rot.
Slide 4: 3. Cold tap water on tropicals. Let it sit to room temperature first.
Slide 5: 4. Misting to "water". It raises humidity for minutes, not the soil moisture.
Slide 6: 5. Same amount winter and summer. Most plants need far less in winter.
Slide 7: 6. Small sips daily. Water deeply, then let it dry out.
Slide 8: 7. Ignoring yellow lower leaves. Often the first sign of overwatering.
Slide 9: Recap checklist of all 7
Slide 10: Save this for your next watering day.
```
Caption:
```
7 watering mistakes that quietly kill houseplants (number 1 is the most common).

Swipe through and check which ones you're making. Pocket Plants adjusts reminders to light and season so you can skip mistake 1 entirely.

#houseplants #plantcare #planttips #indoorplants
```

### X (single post text list)
```
5 Tempo settings most people never turn on:

1. Auto-start breaks
2. Hide the clock during focus
3. Block notifications per session
4. Weekly focus report on Mondays
5. Long break after every 4th session

Number 2 changed my mornings.
```
(234 chars)

## Avoid
- Padding to reach a round number; 5 strong items beat 10 with filler.
- Vague items ("stay consistent"); every item needs a detail, number or example.
- Walls of text on a slide; if it needs a paragraph, it is two slides.
- Cover slides that do not say what is inside (pure clickbait hurts swipe-through).
- Multiple CTAs on the last slide, or "like and follow for more" bait.
- Hashtag stuffing; Instagram allows 5 at most, and fewer specific tags beat generic ones.
- Every item being your product; it stops being a list and becomes an ad.
- Links in the first post of an X thread.

## Checklist
- [ ] The cover states the number and promise in ≤ 8 words, readable as a thumbnail.
- [ ] Each item has a specific detail and fits one slide.
- [ ] The strongest item is at position 2 or 3.
- [ ] The last slide has exactly one CTA.
- [ ] Caption promise is in the first line: within ~125 chars (Instagram) and ~140 chars (LinkedIn mobile).
- [ ] Every slide has alt text with its text content.
- [ ] Slide count fits the platform (Instagram ≤ 10 via Postflare, Threads ≤ 20, X/Bluesky 4 images per post).
- [ ] Links, if any, sit in a `thread` follow-up on X and Bluesky.
- [ ] Hashtags are 5 or fewer and relevant.

## Sources
- [The State of Social Media Engagement in 2026 — Buffer, 2026](https://buffer.com/resources/state-of-social-media-engagement-2026/) — carousels top engagement on Instagram (6.90%) and LinkedIn (21.77%); link posts lowest on Facebook and X.
- [Instagram shares algorithm insights for 2025 — Social Media Today, 2025](https://www.socialmediatoday.com/news/instagram-shares-algorithm-insights-2025/738034/) — Mosseri: watch time, likes, sends are top signals; sends weigh more for non-followers.
- [Instagram is implementing new limits on hashtag use — Social Media Today, 2025](https://www.socialmediatoday.com/news/instagrams-implementing-new-limits-on-hashtag-use/808309/) — 5-hashtag cap; hashtags don't add reach.
- [Instagram expands carousels to 20 frames — Social Media Today, 2024](https://www.socialmediatoday.com/news/instagram-expands-carousels-to-20-frames/723792/) — up to 20 items in the app.
- [IG User Media reference — Meta for Developers, 2026](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media) — API carousels max 10, image ratio 4:5 to 1.91:1, caption 2,200 chars.
- [LinkedIn study finds adding links boosts engagement by 13% — Search Engine Journal, 2025](https://www.searchenginejournal.com/linkedin-study-finds-adding-links-boosts-engagement-by-13/544524/) — Metricool, 577K posts: carousels highest engagement, links +13.57% interactions.
- [Post and share updates — LinkedIn Help, 2026](https://www.linkedin.com/help/linkedin/answer/a528176) — 3,000-character post limit.
- [Threads API: Posts — Meta for Developers, 2026](https://developers.facebook.com/docs/threads/posts) — 500 chars, one topic tag, carousels up to 20.
- [Create Post — X Developer Platform, 2026](https://docs.x.com/x-api/posts/create-post) — up to 4 images per post.
- [Do posts with links affect content performance on X? — Buffer, 2025](https://buffer.com/resources/links-on-x/) — near-zero engagement on non-Premium link posts.
- [X API pay-per-usage pricing — X Developer Platform, 2026](https://docs.x.com/x-api/getting-started/pricing) — $0.20 per post with URL vs $0.015.
- [app.bsky.embed.images lexicon — Bluesky AT Protocol, 2026](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/images.json) — max 4 images, alt required.
