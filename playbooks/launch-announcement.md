---
id: launch-announcement
version: 2
name: Launch announcement
summary: Announce a new product or major version on launch day, adapted per platform, with the link placed where each platform makes it clickable.
goal: clicks
platforms: [x, bluesky, threads, mastodon, linkedin, linkedin_page, instagram, instagram_standalone, short-video, reddit]
formats: [text, image, carousel, video]
tags: [launch, product, announcement, mobile-app, game, saas]
inputs: [product name, what it does in one sentence, who it is for, the one standout feature, price or free tier, launch link, a demo video or screenshots, launch date and timezone]
---

## When to use
Use on the day a new product, app, game or major version (2.0, a redesign, a new platform) goes live and there is a link people can act on right now. Not for small updates. The goal is clicks, so every version must answer "what is it, who is it for, why now" before asking for the click.

## Structure
1. **Line 1, the hook (≤ 70 characters, no emoji first):** what it is plus who it is for, or the problem it ends. Name the product.
2. **Line 2–3, the proof:** the one standout feature, shown concretely (a number, a before/after, a 5-second demo).
3. **Line 4, the offer:** price, free tier or launch discount with a real end date, platforms (iPhone, Android, web).
4. **Line 5, the soft ask:** "Link below" on platforms where the link goes in a reply or first comment.
5. **Follow-up (`thread` item in Postflare):** the link, plus one line of context (a launch code, or "feedback welcome"). On X/Bluesky/Threads/Mastodon this becomes the first reply; on LinkedIn/Facebook it becomes the first comment. Instagram captions/comments, TikTok captions and Shorts comments don't make links clickable, so there the link lives in the bio or channel profile.
6. **Sequencing on launch day:** post the X/Bluesky/Threads version first (morning in the audience's timezone), LinkedIn 1–2 hours later, Instagram/TikTok short video around lunch or evening (timing unverified: test it), Reddit only where self-promotion is allowed. Space them so you can answer replies.
7. **If you also launch on Product Hunt:** Product Hunt recommends going live at 12:01 am Pacific when you can plan ahead. Share the launch link anywhere, but ask people to visit and comment, never to upvote; makers may not ask for upvotes directly.

## Platform notes
- **X:** 280 chars (Premium 25,000); any URL counts as 23. Buffer's analysis of 18.8M posts found link posts from non-Premium accounts got near-zero median engagement in 2025; X's head of product calls the link penalty "fake news" and suggests links in the body with context (Apr 2026). Default for non-Premium accounts: demo video or screenshot in the main post, link in the first reply. Via the X API, any post containing a URL (main post or reply) costs $0.20 vs $0.015.
- **Bluesky:** 300 graphemes. Links render as cards; a reply link keeps the main post clean, either works.
- **Threads:** 500 chars, one topic tag per post (e.g. the category, "Indie Dev"), up to 5 links. Meta says link posts have ranked properly since mid-2025, so the link can go in the post; a reply keeps a video post focused.
- **Mastodon:** 500 chars default; links count as 23 and are fine in the body. CamelCase hashtags (#IndieDev, #iOSApps) so screen readers read the words. Lead with what it does, not an ad.
- **LinkedIn:** 3,000 chars; the preview cuts after the first 2–3 lines (often cited as ~210 chars, unverified: check on mobile), so the hook and who-it-is-for must land above "…see more". Third-party data shows body links cost company pages much more reach than personal profiles; on a page, put the link in the first comment.
- **Instagram:** caption 2,200 chars; the "more" fold is around 125 chars (approximate). No clickable caption links, so say "link in bio" and update the bio link before posting. Carousel (up to 10 frames via the publishing API) or Reel; max 5 hashtags since Dec 2025; alt text on every image.
- **TikTok / Reels / Shorts:** vertical 9:16; show the product doing its thing in the first seconds with on-screen text naming the problem (TikTok advises the value proposition within 3 seconds). TikTok captions via the API max 2,200 chars; turn on commercial content disclosure ("Your brand"). Shorts title ≤ 100 chars; links in Shorts descriptions and comments aren't clickable, so point to the channel's profile link or a Related Video.
- **Reddit:** title-first, read the subreddit rules, only post where launches are allowed (some subs have a weekly self-promo thread), keep most of your activity non-promotional, disclose you're the maker, write as a person, not a brand.

## Hooks
- **For-who-plus-what:** "{Product} is a {category} for {specific audience} who {pain}." — the right person self-selects in one line.
- **The thing it ends:** "No more {annoying ritual}. {Product} is live." — names the pain the click resolves.
- **Shipped-after-time:** "{N} months of nights and weekends. {Product} is out today." — the maker story earns attention; follow with what it does.
- **Version jump:** "{Product} {version} is out: {biggest change in 6 words}." — for existing users, the change is the news.

## Examples
### X (main post + first reply)
```
Pocket Plants is out: a plant-care app that tells you when to water based on your actual window light, not a generic schedule.

Snap a photo, it IDs the plant and sets reminders.

Free for 5 plants, $2.99/mo after. iPhone + Android.

Link below.
```
(245 chars)

Reply:
```
App Store + Google Play: pocketplants.app
Launch week: first month free with code SPROUT (ends Oct 20).
```

### LinkedIn (personal profile)
```
I spent 8 months building a plant-care app because I killed three fiddle-leaf figs in a row.

Today Pocket Plants is live on iPhone and Android.

The problem: every watering app uses a fixed schedule. Plants don't care about schedules; they care about light.

What it does:
- Identifies the plant from a photo
- Asks which window it sits by
- Adjusts watering reminders to the season and the light

Free for up to 5 plants. Link in the first comment.

If you try it, I'd love to hear which plant it got wrong.
```

### Threads
```
Tiny Tower Defense 2.0 is out: endless mode, 12 new towers, and you can finally undo a misplaced tower.

Built solo, no ads, one-time $3.99.

Link in the reply. #IndieGames
```
(172 chars, one topic tag)

## Avoid
- A bare link in the X main post from a non-Premium account, or in the body of a LinkedIn company page post.
- One identical caption pasted to every platform; rewrite the hook and length per platform.
- Fake urgency ("only today!") without a real deadline.
- Leading with "I'm so excited to announce" instead of what the product does.
- Hashtag stuffing and emoji walls (Instagram caps hashtags at 5; Threads uses one topic).
- Saying "link in bio" on X, Bluesky, Threads, Mastodon or LinkedIn, where a link works; pasting URLs into Shorts or TikTok captions where they can't be tapped.
- Asking for Product Hunt upvotes.
- Launching on Reddit in subs that ban self-promotion, or posting from a fresh account.

## Checklist
- [ ] The hook names the product and says what it does or who it is for in ≤ 70 characters.
- [ ] One concrete standout feature or proof point is in the first three lines.
- [ ] Price, free tier and platforms are stated; any deadline is real.
- [ ] On X and LinkedIn pages the link is in a `thread` follow-up, not the main post.
- [ ] Instagram and TikTok bio links (and the YouTube channel link) are updated if the post points there.
- [ ] TikTok commercial content disclosure is on ("Your brand").
- [ ] Each platform has its own version within its character limit, fold and hashtag cap.
- [ ] Demo video or screenshot attached, with alt text on images.
- [ ] Posts are spaced across launch day so replies can be answered.
- [ ] Reddit target subreddits allow launch posts; Product Hunt copy doesn't ask for upvotes.

## Sources
- [Product Hunt Launch Guide — Product Hunt, 2026](https://www.producthunt.com/launch/guide) — 12:01 am PT launch time; don't ask for upvotes.
- [Do Posts with Links Affect Content Performance on X? — Buffer, 2025](https://buffer.com/resources/links-on-x/) — near-zero engagement on non-Premium link posts.
- [X says link deboosting is a myth — Roboin, 2026](https://roboin.io/article/en/2026/04/13/x-denies-link-deboost-recommends-in-post-links/) — Nikita Bier's Apr 2026 denial and in-body link advice.
- [X API pay-per-usage pricing — X Developer Platform, 2026](https://docs.x.com/x-api/getting-started/pricing) — $0.20 per post with URL vs $0.015.
- [Meta says link posts are being ranked properly in Threads — Social Media Today, 2025](https://www.socialmediatoday.com/news/meta-says-link-posts-ranked-properly-threads-reach/750126/) — Mosseri on links working better on Threads.
- [LinkedIn Link Penalties: Does Posting with Links Hurt Reach? — Ordinal, 2026](https://www.tryordinal.com/blog/linkedin-link-penalty-study) — link penalty mostly on company pages.
- [Instagram implements new limits on hashtag use — Social Media Today, 2025](https://www.socialmediatoday.com/news/instagram-implements-new-limits-on-hashtag-use/808309/) — 5-hashtag cap per post/Reel.
- [Sharing links with your audiences — YouTube Help, 2026](https://support.google.com/youtube/answer/13748639?hl=en) — Shorts description/comment URLs not clickable.
- [How to turn on the Commercial Content Disclosure setting in TikTok — TikTok for Business, 2026](https://ads.tiktok.com/help/article/how-to-turn-on-the-commercial-content-disclosure-setting-in-tiktok) — disclosure required when promoting a product or brand.
