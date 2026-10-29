---
id: player-feedback-showcase
version: 2
name: Player and user feedback showcase
summary: Showcase real reviews, fan art and shipped feature requests, with permission and credit, so the community sees itself in the app.
goal: engagement
platforms: [microblog, instagram, instagram_standalone, tiktok, facebook, reddit]
formats: [text, thread, image, carousel, video]
tags: [mobile-app, game, community, reviews, ugc, social-proof]
inputs: [app or game name, the review or fan art or request being shown, where it came from, the creator's handle and permission status, what changed because of it, screenshots]
---

## When to use
Use when a user said something specific and kind, made fan art, found a creative use for the app, or asked for a feature you have now shipped. These posts show that people are heard, and they double as social proof for newcomers: in Spiegel Research Center data, a product with five reviews was 270% more likely to be bought than one with none. Good cadence: once a week or less (unverified: test it); a feed that is only reviews reads as an ad. Never use reviews you can't verify, and never post negative reviews to mock them.

## Structure
1. **Get permission first** for anything that identifies a person: fan art, social posts, emails, Discord messages, TestFlight feedback. App Store and Google Play reviews are public, but still blur or omit the reviewer's nickname unless they agreed, and never show their avatar or real name. Show the review text unedited; the FTC treats a marketer's misleading edits to a review as the marketer's responsibility.
2. **Choose the type:**
   - *Review spotlight:* one specific review (specific beats "5 stars great app"). Don't present a hand-picked review as what most users think.
   - *Fan art / UGC:* the creation as the main visual, credited.
   - *You asked, we shipped:* the original request, then the shipped feature.
3. **Line 1: the human part**, ≤ 70 characters, no emoji at the start. Quote a line from the user or name the request.
4. **The visual:** a clean screenshot of the review (crop to the review card; App Store screenshots should show the stars and text, not your whole phone), the fan art at full quality, or a split image request/shipped.
5. **Credit clearly:** "Art by @handle" in the caption and tag them where the platform allows. For reviews without permission: "from an App Store review".
6. **Your response in 1–2 sentences:** what it meant, what changed.
7. **Open the door:** ask for the next request, the next piece of art, or a story, specifically.

## Platform notes
- **X:** 280 chars. Tag the creator in the post itself (mentions notify them and invite a quote-post). Thread follow-ups for the original request + the shipped result. Keep the store link out of the main post so the post stays about them; via the X API any post with a URL costs $0.20 vs $0.015.
- **Bluesky:** 300 graphemes; mention the creator with their handle. Alt text describing fan art matters here.
- **Threads:** 500 chars, exactly one topic tag per post ("Fan Art" or the game's name).
- **Mastodon:** 500 chars by default, CamelCase hashtags (#FanArt, #IndieGame) for screen readers. Ask before boosting someone's art into a promotional context; many artists state their terms in their profile (unverified: test it).
- **Instagram:** carousel: frame 1 the art or quote, frame 2 the shipped result or more art (up to 10 items via the publishing API). Tag the creator in the image and in the caption. Caption truncates after roughly 125 chars. Max 5 hashtags. Alt text.
- **TikTok:** 9:16 video: show the review or request as on-screen text for the first 2 seconds, then the feature in action. Duet/Stitch for responding to a creator's TikTok, only if they have it enabled and you asked first.
- **Facebook:** works well for community-heavy games; tag the person if they're in your group. Links in comments.
- **Reddit:** in your own subreddit, a "you asked, we shipped" post with the original thread linked works well; credit the redditor by username only if they're fine with it.
- **Store rules:** Apple can expel developers who inflate rankings with paid or incentivized feedback, apps can't force a rating to unlock anything (3.2.2), and ratings must be requested with Apple's provided API, not custom prompts (5.6.1). Google Play bans "asking users to rate your app while offering an incentive". The FTC's 2024 rule bans incentives conditioned on positive reviews. Never trade rewards for reviews in a showcase post; collect ratings with the in-app prompt (StoreKit on iOS, the In-App Review API on Android).

## Hooks
- **Their words first:** "\"{Short quote from user}\"" — people trust other people's recommendations above any ad channel (Nielsen 2021), so a real voice reads as more credible than the developer.
- **You asked, we shipped:** "{Name or 'You'} asked for {feature} in {month}. It's live today." — shows the loop closing, which invites the next request.
- **Fan art drop:** "{Handle} drew {character/thing} and we can't stop looking at it." — celebrates the artist; their followers share it.
- **Unexpected use:** "Someone is using {app name} to {surprising use}." — curiosity plus social proof.

## Examples
### X (post + follow-up)
```
In March, @mira_grows asked if Pocket Plants could track plants by room.

Room view shipped today. Thank you, Mira, for the idea and the very detailed sketch.

[images: her original message, the new Room view]
```
(Post: 158 characters)
```
Follow-up: What should we build next? Reply with the one thing you keep wishing the app did.
```

### Instagram (fan art carousel caption)
```
@pixelpebble drew the Tiny Tower Defense gate guard and now it's our favorite version of him.

Swipe for the sketch stages. Pebble said yes to us sharing it, and their shop is linked in their bio.

Drawn something from the game? Tag us, we look at everything.
#fanart #indiegame #pixelart
```
(Caption: 288 characters)

## Avoid
- Posting fan art, DMs, emails or social posts without asking.
- Showing reviewer avatars, real names or full-phone screenshots with notifications.
- Editing review text or stitching together several reviews into one "quote".
- Fake or friend-written reviews.
- Offering rewards for reviews or ratings (against App Store and Google Play rules).
- Mocking negative reviews or arguing with critics publicly.
- Engagement bait like "comment your rating below".
- Posting only 5-star walls with no story; it reads as an ad, shoppers find perfect scores "too good to be true" (purchase likelihood peaks at 4.0–4.7 stars), and the FTC warns selective review displays can mislead.

## Checklist
- [ ] Permission is confirmed for any identifiable person's content (art, posts, DMs, beta feedback).
- [ ] The creator is credited by handle and tagged where the platform supports it.
- [ ] Review text is unedited; reviewer identity is hidden unless they agreed.
- [ ] Screenshots are cropped to the content, with no unrelated personal data.
- [ ] Alt text describes the art or the review text.
- [ ] The post says what changed or what it meant, not just "thanks".
- [ ] It ends with a specific invitation (next request, next art, a story).
- [ ] No incentive for reviews or ratings is offered anywhere.
- [ ] A hand-picked review is not presented as typical of all users.

## Sources
- [FTC's Endorsement Guides: What People Are Asking — FTC, 2023](https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking) — edited reviews, selective review displays and incentives can mislead.
- [FTC Announces Final Rule Banning Fake Reviews and Testimonials — FTC, 2024](https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials) — bans fake reviews and sentiment-conditioned incentives.
- [App Review Guidelines — Apple Developer, 2026](https://developer.apple.com/app-store/review/guidelines/) — no incentivized feedback, 3.2.2(x) no forced ratings, 5.6.1 use the provided review API.
- [Ratings, Reviews, and Installs policy — Google Play Console Help, n.d.](https://support.google.com/googleplay/android-developer/answer/9898684) — no incentives for ratings or reviews.
- [How Online Reviews Influence Sales — Spiegel Research Center, 2017](https://spiegel.medill.northwestern.edu/How-Online-Reviews-Influence-Sales) — five reviews lift purchase likelihood 270%; 4.0–4.7 stars beats a perfect 5.
- [Trust in Advertising U.S. sell sheet — Nielsen, 2021](https://develop.nielsen.com/wp-content/uploads/sites/2/2022/02/2021-Nielsen-Trust-In-Advertising-U.S.-sell-sheet.pdf) — recommendations from people they know are the most trusted channel (89%).
- [Instagram will now let you share 20 photos per post — 9to5Mac, 2024](https://9to5mac.com/2024/08/08/instagram-will-now-let-you-share-20-photos-per-post/) — carousel limit raised from 10 to 20.
- [Instagram implements new limits on hashtag use — Social Media Today, 2025](https://www.socialmediatoday.com/news/instagram-implements-new-limits-on-hashtag-use/808309/) — 5 hashtags per post.
