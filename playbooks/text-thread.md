---
id: text-thread
version: 2
name: Text thread
summary: A multi-post thread on X, Bluesky, Threads or Mastodon with a standalone first post, one idea per post and the link in the last reply.
goal: reach
platforms: [microblog]
formats: [thread, text, image]
tags: [thread, long-form, educational, storytelling, mobile-app, game, saas]
inputs: [topic, the one promise of the thread, 4-10 key points, supporting numbers or examples, product name if relevant, link for the last reply]
---

## When to use
Use when an idea needs more than one post: a story, a breakdown, a step-by-step, lessons from a launch. On X, threads had the highest engagement rate of any format (1.89% vs 0.68% for single text posts) in Ordinal's analysis of 87,528 posts from 2024–2026. Most of the reach still rides on the first post, so it has to work on its own, and each later post must reward the reader for continuing. If the content fits in one post, write one post (see how-to-tip). Keep it to 4–10 posts (unverified: no public data on ideal thread length; test it).

## Structure
1. **Post 1, standalone hook:** makes a complete promise or claim that is worth reading even if nobody expands the thread. 100–200 characters is ideal: in Ordinal's X data, posts of that length had the highest engagement rate. End with a pointer like "Here's how:" or a numbering cue. No link.
2. **Numbering:** "1/" style or "1/7" at the start or end of each post. Use a total only if it is final; Postflare publishes the thread as written, so the number must match.
3. **Posts 2 to N-1, one idea each:** one point, one example or number, ≤ 3 short paragraphs. Each post should make sense if quoted alone.
4. **Pacing:** alternate claim posts with proof posts (a screenshot, a number, a before/after). An image every 3–4 posts helps hold scrollers (unverified: test it).
5. **Second-to-last, the summary:** the key takeaway in one or two lines.
6. **Last post, the link and CTA:** the link plus one line of why to click. In Postflare, each post after the first is a `thread` item; put the link only here.

## Platform notes
- **X:** 280 characters per post (Premium up to 25,000, but threads of short posts read better than one long post). A URL counts as 23 characters. Up to 4 images per post. X's ranking down-weights each extra post from the same author in a feed and weights replies far above likes, so post 1 carries the reach and replies to it carry the most signal. Whether links still cut reach is disputed (Buffer 2025 measured near-zero engagement on non-Premium link posts; X said in 2026 it no longer penalizes them), so keep the link in the last reply. Via the X API every post with a URL costs $0.20 vs $0.015, wherever it sits in the thread.
- **Bluesky:** 300 graphemes per post. A post has one embed, so the last post carries either the link card or images, not both. Name the topic plainly in post 1 so keyword-based custom feeds can pick it up (unverified: test it).
- **Threads:** 500 characters per post, one topic tag per post; put it on post 1. Fewer, fuller posts (4–6) fit the longer limit (unverified: test it).
- **Mastodon:** 500 characters by default (varies by server); a URL counts as 23. CamelCase hashtags (#IndieDev) on post 1 only, so screen readers can split the words. Setting the replies to "Quiet public" keeps them out of live feeds, explore and search, but followers still see them in their home feed. Use content warnings for topics like burnout or money if that is the norm on the server.
- Write a separate version per platform when limits differ; do not split a 500-character Threads post mid-sentence for X.

## Hooks
- **Outcome + receipt:** "{Product} went from {A} to {B} in {time}. Everything that worked, and what didn't:" — a concrete result earns the click to expand.
- **Teardown:** "I studied {N} {examples}. {M} patterns kept showing up:" — signals research and promises a list.
- **Step-by-step:** "How to {specific outcome} without {common cost}, step by step:" — clear promise and structure.
- **Story:** "{Unexpected event} happened to {product} last {time}. Here's what we learned." — a narrative pulls readers forward.

## Examples
### X (6 posts)
```
1/ Tiny Tower Defense made $0 for 5 months, then $2,100 in one week after a single change to the first 60 seconds.

Here's what we changed and why it worked:
```
(157 chars)
```
2/ Our data: 70% of players quit before wave 3. Not because it was hard. Because nothing happened. Wave 1 was 40 seconds of slow enemies walking.
```
```
3/ Fix one: wave 1 now ends in 15 seconds with a boss you can't lose to. Players see the payoff (explosions, upgrades) before they decide to stay.
```
```
4/ Fix two: we moved the first tower upgrade from wave 5 to wave 2. The core loop is "place, upgrade, watch it pop". Players need to feel it in the first minute.
```
```
5/ Result: wave 3 retention went from 30% to 64%. Same game, same art, same price. Only the first minute changed.

Lesson: your first minute is your real store page.
```
```
6/ If you want to see the new first minute, it's free to try: tinytowerdefense.com
```

### Threads (4 posts, post 1)
```
Tempo hit 1,000 paying users. I made almost every pricing mistake on the way there, so here are the four that cost the most, one per post. #IndieDev
```
(148 chars; posts 2-4 cover one mistake each, link in post 4)

## Avoid
- A first post that only teases ("A thread, read on") with no standalone value.
- A link in the first post on X; it may cost reach and, via the API, costs $0.20 per post anyway.
- Numbering totals that do not match the actual thread length.
- Two ideas crammed into one post, or one idea stretched over three.
- Filler posts ("Let's dive in", "Buckle up").
- "Retweet the first post if this helped" and similar engagement bait.
- Copying an X thread unchanged to Threads or Mastodon where the limits differ.
- Hashtags on every post; only the first, and only where the platform uses them.

## Checklist
- [ ] Post 1 stands alone, has no link, and promises one clear outcome in about 100–200 characters.
- [ ] Every post holds one idea and fits the platform limit.
- [ ] Numbering is consistent and any total matches the thread length.
- [ ] At least one post carries proof (number, screenshot or example).
- [ ] The link appears only in the last `thread` item.
- [ ] Thread length is 4–10 posts.
- [ ] Each platform has its own split, not a copy of the X version.
- [ ] Images have alt text; X posts have at most 4 images.

## Sources
- [Twitter Analytics: What 87,000 Posts Reveal — Ordinal, 2026](https://www.tryordinal.com/blog/twitter-analytics) — threads had the highest X engagement rate (1.89%); 100–200 character posts did best.
- [x-algorithm — xAI on GitHub, 2026](https://github.com/xai-org/x-algorithm) — repeat posts from one author are down-weighted by a decaying factor.
- [x-algorithm: home-mixer/params/param.rs — xAI on GitHub, 2026](https://github.com/xai-org/x-algorithm/blob/main/home-mixer/params/param.rs) — reply weight 5.0 vs like 0.6.
- [Counting characters — X Developer Platform, 2026](https://docs.x.com/fundamentals/counting-characters) — 280-character limit; URLs count as 23.
- [Create a post — X Developer Platform, 2026](https://docs.x.com/x-api/posts/create-post) — up to 4 photos per post.
- [X API pay-per-usage pricing and credits — X Developer Platform, 2026](https://docs.x.com/x-api/getting-started/pricing) — posts with a URL cost $0.20 vs $0.015.
- [Do Posts with Links Affect Content Performance on X? — Buffer, 2025](https://buffer.com/resources/links-on-x/) — non-Premium link posts got near-zero engagement in 2025.
- [X product head Nikita Bier confirms link penalty removed — Free Press Journal, 2026](https://freepressjournal.in/tech/x-product-head-nikita-bier-confirms-link-penalty-removed-over-a-year-ago-tells-mark-zuckerberg-he-can-post-them-directly) — X says links no longer need to go in replies.
- [app.bsky.feed.post lexicon — Bluesky/AT Protocol, 2026](https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/app/bsky/feed/post.json) — 300-grapheme text; a single embed per post.
- [Threads Posts — Meta for Developers, 2026](https://developers.facebook.com/documentation/threads/posts) — 500-character posts, one topic tag per post.
- [Posting toots — Mastodon documentation, 2026](https://docs.joinmastodon.org/user/posting/) — 500-character default, URLs count as 23, "Quiet public" visibility.
- [Hashtag accessibility — CUNY Office of Library Services, 2026](https://guides.cuny.edu/accessibility/hashtags) — screen readers need CamelCase to split hashtag words.
