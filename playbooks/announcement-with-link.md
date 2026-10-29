---
id: announcement-with-link
version: 2
name: Announcement with a link
summary: Announce a blog post, sale, event or release where the goal is a click, with the link placed where each platform rewards it.
goal: clicks
platforms: [all]
formats: [text, image, video]
tags: [mobile-app, game, announcement, link, launch, sale, event]
inputs: [what is being announced, the URL with UTM tags per platform, the one reason to click, deadline or date if real, an image or short video, platforms to post on]
---

## When to use
- A new blog post, devlog, changelog, case study or newsletter issue.
- A sale or price change with a real end date.
- An event: a livestream, a launch on a directory, a meetup, a beta signup.
- Any post where success is measured in clicks, not likes.

If the goal is awareness of a feature, use a feature or video playbook instead; a link post is the wrong tool for reach.

## Structure
1. **Line 1: the reason to click, ≤ 80 characters.** What the reader gets, not what you did. "How we cut our app's size from 180 MB to 42 MB" beats "New blog post!".
2. **Lines 2–3: one or two specifics** that make the click feel worth it (a number, a list of what's inside, the date and time of the event).
3. **The ask.** A plain call to action naming the place: "Read it in the reply below", "Link in bio", "Tap the card".
4. **The link, placed per platform** (see Platform notes). Add UTM parameters (`utm_source=x`, `utm_source=linkedin`…) so clicks can be compared, and so you can test link-in-post against link-in-reply on your own account.
5. **Media.** An image or short video that previews the content (a chart from the post, the sale price, the event speaker). On platforms with link cards, check the page's Open Graph image looks right.
6. **Follow-up items.** In Postflare, follow-ups are thread replies on X/Bluesky/Threads/Mastodon and the first comment on YouTube/Instagram/Facebook/LinkedIn. Use them for the link where the main post should stay link-free.

## Platform notes
- **X:** 280 characters (Premium up to 25,000); a URL counts as 23. Evidence on link reach is mixed: Buffer's 2025 study of 18.8M posts found link posts from non-Premium accounts got near-zero engagement, while X's head of product said in July 2026 that links no longer need to go in replies. Default to the link in the first reply (follow-up) and say so in the post, then A/B test with UTMs. Via the X API, any post with a URL costs $0.20 vs $0.015 for one without (since April 2026), and that applies to a reply carrying the link too.
- **Bluesky:** 300 graphemes, and the full URL text counts. A post has one embed: a link card or images, not both. Bluesky leadership has said it does not downrank links.
- **Threads:** 500 characters, one topic tag, up to 5 links per post. Instagram/Threads head Adam Mosseri has said Threads does not penalize link posts; put the link in the post or in a reply.
- **Mastodon:** 500 characters by default (varies by server); a URL counts as 23. Links are normal and expected; CamelCase hashtags for screen readers. Add a content warning if the topic calls for it (e.g. layoffs).
- **LinkedIn:** 3,000 characters; the "see more" fold sits around 140–200 characters. LinkedIn has never said it demotes links, but third-party data is mixed: Ordinal measured ~26% less reach for link posts on average, Metricool (2026) found links cut impressions on personal profiles but not on company pages, and links in comments get far fewer clicks than links in the body. Personal profile: link in the first comment (follow-up) with "link in the first comment". Company page: a body link is reasonable; test both.
- **Facebook:** long text is fine; a body link generates a preview card. Since December 2025 Meta has been testing a cap of two organic link posts per month for some Pages and professional profiles without Meta Verified; links in comments are not capped. If the account hits the cap, move the link to the first comment. Whether a comment link keeps more reach is unproven (unverified: test it).
- **Instagram:** captions are not clickable (a 2026 test gives some Meta Verified subscribers caption links). Say "link in bio" and make sure the bio link (or link page) is updated before the post goes live. Story link stickers are posted by hand.
- **TikTok / Shorts:** TikTok captions are not clickable; point to the profile link (the bio website field needs 1,000+ followers or a verified business account). YouTube Shorts: links in Shorts descriptions and comments have not been clickable since August 2023; point viewers to the channel's header links instead. On long-form YouTube videos, a pinned first comment link works.
- **Pinterest:** title ≤ 100 characters (the first ~40 show in feeds), description up to 800. The link is the pin's destination URL, so set it; no "link in bio" needed. Image at 2:3 (1000×1500).
- **Reddit:** check the subreddit rules on self-promotion first. Title states the value; for link posts, the URL is the post. Many subs prefer a text post with context and the link inside.

## Hooks
- **What you get:** "{Specific outcome} — {how} ({format/length})." — the click has a clear payoff.
- **Number inside:** "We {did thing}: {number} {result}. Full breakdown inside." — specificity earns the click.
- **Deadline (real only):** "{Offer} until {date, time, timezone}." — urgency is fine when it is true.
- **The question the link answers:** "Why does {surprising thing} happen? We dug into {source}." — curiosity with a promised answer.

## Examples
### X (main post 157 characters + reply)
```
How we got Tiny Tower Defense from 180 MB to 42 MB without cutting a single level.

Texture packing, audio streaming, one dropped SDK. Write-up in the reply.
```
Reply (follow-up): "https://tinytower.example/blog/42mb?utm_source=x"

### LinkedIn personal profile (link in first comment)
```
Pocket Plants is 50% off yearly until Sunday, Oct 18, 23:59 CET.

It's our first sale in two years. The price goes back to normal Monday.

What's in it: weather-aware watering reminders, photo plant ID and a shared list for households.

Link in the first comment.
```
First comment (follow-up): "https://pocketplants.example/sale?utm_source=linkedin"

### Bluesky (link card, 182 graphemes)
```
Tempo devlog #12 is out: we tried 5 ways to block notifications on Android and only 2 survived Play review. Here's what worked and what got rejected.

https://tempo.example/devlog/12
```

### Instagram (caption, link in bio)
```
Live on Thursday, Oct 15, 18:00 UTC: we build a new Tiny Tower Defense level from scratch, and you vote on the boss.

Link in bio to set a reminder.

#IndieGame #GameDev #Devlog
```

## Avoid
- A URL in the body of a LinkedIn personal-profile post, or in the main X post before you have tested it on that account.
- "Link in bio" on Bluesky, Mastodon, Threads or Pinterest, where links work.
- "Link in the comments" on YouTube Shorts, where comment links are not clickable.
- Forgetting to update the Instagram bio link before the post publishes.
- "New blog post!" with no reason to click; vague teasers that hide what the link is.
- Fake urgency ("last chance!" with no end date, or a sale that never ends).
- Shortened links that hide the domain; use the real domain with UTMs.
- The same caption and link placement copied to every platform.

## Checklist
- [ ] Line 1 says what the reader gets, ≤ 80 characters.
- [ ] Link placement matches each platform (X reply by default, LinkedIn profile first comment, Instagram/TikTok bio, Shorts channel links, Bluesky card, Pinterest destination).
- [ ] The post text tells people where the link is.
- [ ] URLs carry per-platform UTM tags and the page loads.
- [ ] The link card or Open Graph image renders correctly where cards appear.
- [ ] Any deadline is real and includes date, time and timezone.
- [ ] Instagram bio link is updated (or the user is told to).
- [ ] Length fits each platform (X 280 with URLs at 23, Bluesky 300 with the full URL, Threads/Mastodon 500, Pinterest title 100).

## Sources
- [X API pay-per-usage pricing and credits — X Developer Platform, 2026](https://docs.x.com/x-api/getting-started/pricing) — creating a post costs $0.015, a post with a URL $0.20.
- [Counting characters — X Developer Platform, 2026](https://docs.x.com/fundamentals/counting-characters) — 280-character limit; every URL counts as 23.
- [Do Posts with Links Affect Content Performance on X? — Buffer, 2025](https://buffer.com/resources/links-on-x/) — 18.8M posts: non-Premium link posts got ~0% engagement; links in replies suggested.
- [X product head Nikita Bier confirms link penalty removed — Free Press Journal, 2026](https://freepressjournal.in/tech/x-product-head-nikita-bier-confirms-link-penalty-removed-over-a-year-ago-tells-mark-zuckerberg-he-can-post-them-directly) — X says links no longer need to go in replies.
- [Here's where each of the big social platforms stands on external links — Social Media Today, 2024](https://www.socialmediatoday.com/news/heres-where-each-of-the-big-social-platform-stands-on-external-links/733946/) — Threads says no link penalty; Bluesky "loves links"; LinkedIn has no official restriction.
- [LinkedIn Link Penalties: Does Posting with Links Hurt Reach? — Ordinal, 2026](https://www.tryordinal.com/blog/linkedin-link-penalty-study) — ~26.5% average reach loss for link posts; comment links get fewer clicks.
- [LinkedIn engagement shifts toward clicks as visible metrics decline — Net Influencer, 2026](https://www.netinfluencer.com/linkedin-engagement-shifts-toward-clicks-as-visible-metrics-decline-study-finds/) — Metricool: links lowered personal-profile impressions, raised company-page impressions.
- [Paid vs. organic link-shares: Facebook limits unverified to two per month — MediaPost, 2025](https://www.mediapost.com/publications/article/411459/) — Meta test caps organic link posts; comment links unlimited.
- [YouTube's banning clickable links from Shorts descriptions and comments — Tubefilter, 2023](https://tubefilter.com/2023/08/10/youtube-shorts-comments-spam/) — Shorts description and comment links not clickable since Aug 31, 2023.
- [Instagram tests clickable links in post captions for Meta Verified users — PPC Land, 2026](https://ppc.land/instagram-tests-clickable-links-in-post-captions-for-meta-verified-users/) — captions otherwise have no clickable links; limited 2026 test.
- [Review Pin specs — Pinterest Help, 2026](https://help.pinterest.com/en/article/review-pin-specs) — Pin title max 100 characters, description up to 800.
- [Threads Posts — Meta for Developers, 2026](https://developers.facebook.com/documentation/threads/posts) — 500-character posts, max 5 links, one topic tag.
- [app.bsky.feed.post lexicon — Bluesky/AT Protocol, 2026](https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/app/bsky/feed/post.json) — 300-grapheme text; a single embed per post.
