---
id: short-video-hook-script
version: 2
name: Short video hook and script
summary: A beat-by-beat script for a 15-45 second vertical video, built around the first 3 seconds and an ending that loops.
goal: reach
platforms: [short-video]
formats: [video]
tags: [mobile-app, game, video, script, hook, short-form]
inputs: [app or game name, the single idea of the video, footage available or who will film, target length in seconds, the payoff moment, voiceover or text-only]
---

## When to use
- You need a TikTok, Reel or Short and want a script the user (or a screen recorder) can shoot in one go.
- There is one clear payoff to show: a feature that saves time, a satisfying game moment, a surprising result.
- You are planning a batch of videos and want consistent, testable hooks.

One video, one idea. If you need two ideas, write two scripts.

## Structure
Write the script as timed beats. Each beat: time range, what is on screen, on-screen text, voiceover (if any).

1. **0:00–0:03 Hook.** Movement in the first frame (no logo, no intro, no "hey guys"). State the tension or promise in the first 3 seconds: Instagram's view rate counts who stays past 3 s, and TikTok's ad guidance says to land the proposition in 3 s and the hook within 6 s. On-screen text ≤ 7 words (TikTok suggests 5–10 words per second of text at most). The visual must match the text, so viewers do not feel tricked.
2. **0:03–0:06 Context.** Why it matters: the problem in one sentence, shown not described.
3. **0:06–0:25 Payoff steps.** 2–4 quick beats, each 2–5 seconds, each with a new visual (cut, zoom, new screen). Every beat answers "and then?".
4. **0:25–0:35 Result.** The moment the hook promised. Hold it a beat longer than feels natural.
5. **Loop ending.** The last frame or sentence leads back into the first ("…which is why I start every day with" → video restarts on the app open). No "thanks for watching", no end card. Watching to the end is a strong ranking signal on TikTok and Instagram; that a seamless loop adds replays is a creator heuristic (unverified: test it).
6. **Caption.** 1–2 lines that add context the video does not say, then up to 5 specific hashtags.
7. **Captions/subtitles.** Burned-in or auto-captions on; a lot of mobile video is watched muted, and Meta found captions raised view time of video ads by 12% on average. Keep text in the center of the frame, away from the top bar, the bottom caption/CTA area and the right-side buttons (check each platform's safe-zone template).

Target 15–45 seconds total (an editorial starting point, not a platform rule). Shorter is better if the payoff lands; cut any beat that does not move toward it.

## Platform notes
- **TikTok:** 9:16, 1080×1920. Captions posted through the Content Posting API (what schedulers use) max out at 2,200 characters; keep it to 1–2 lines. Hashtags help TikTok classify the video; 3–5 specific ones is common practice (unverified: test it). Use trending sounds only if they fit; a voiceover works without them.
- **Instagram Reels:** same 9:16 file; Reels can run up to 3 minutes in the app. The profile grid now crops covers to a taller rectangle, so pick a cover frame with the text centered. Only the first line or so of the caption shows before "more" (~125 characters is the common rule of thumb; unverified: test it). Instagram caps captions at 5 hashtags and says hashtags do not increase reach, so skip the first-comment hashtag trick. Reels that are watermarked, low-res, mostly text or already posted are less likely to be recommended.
- **YouTube Shorts:** square or vertical, up to 3 minutes, but this playbook stays ≤ 45 s. Title ≤ 100 characters and it is searchable, so put the plain keyword in it. URLs in Shorts descriptions and comments are not clickable: point to the store with on-screen text ("Search {app name} on the App Store"), the channel's profile links, or a Related Video link to a longer video that holds the link.
- Upload the same clean video file, but rewrite the caption for each platform; do not cross-post a TikTok with its watermark to Reels or Shorts.

## Hooks
- **Visual contradiction:** text "{unexpected claim}" over a frame that seems to contradict it — curiosity holds the swipe.
- **Pain in their words:** "POV: you {specific frustrating moment}" — instant recognition.
- **Countdown result:** "{result} in {n} seconds" with a visible timer — promises a payoff and a short wait.
- **Wrong way / right way:** "Stop {common habit}. Do this." — only if the "this" is genuinely better and shown.

## Examples
### TikTok, Tempo (focus timer), 28 seconds, voiceover
```
0:00–0:03  Phone buzzing with 14 notifications, hand slams it face down.
           On-screen: "I lost 3 hours to this yesterday"
0:03–0:06  Desk wide shot, half-finished doc.
           VO: "Every ping costs me ten minutes of getting back in."
0:06–0:12  Screen rec: open Tempo, tap "Deep work 50".
           On-screen: "1 tap"
0:12–0:18  Screen rec: Slack and Mail icons grey out.
           On-screen: "chat apps muted until it ends"
0:18–0:24  Timelapse of typing, timer ticking down.
           VO: "Fifty minutes. No pings."
0:24–0:28  Timer hits 0:00, doc finished.
           VO: "So now every morning I start by..." (cut back to 0:00 buzzing phone)

Caption (96 characters):
The ping tax is real. Tempo mutes chat apps while you focus. #Productivity #DeepWork #FocusTimer
```

### YouTube Short, Tiny Tower Defense, 18 seconds, text only
```
Title: One tower placement that beats level 40 in Tiny Tower Defense

0:00–0:02  Level 40 wave already flooding the path.
           On-screen: "Level 40 with ONE tower?"
0:02–0:06  Zoom on the corner tile. On-screen: "This corner hits 3 paths"
0:06–0:12  Place frost tower, upgrade twice, waves freeze at the corner.
           On-screen: "Frost x2 = everything stalls"
0:12–0:16  Wave counter hits 20/20. On-screen: "Cleared."
0:16–0:18  Cut to the start of the level, same flooding path (loops to 0:00).
           On-screen (small, centered): "Tiny Tower Defense, free on iOS and Android"

Related video: full level 40 walkthrough (its description holds the store link)
```

## Avoid
- Logos, intros, greetings or a black frame in the first second.
- A hook the video does not pay off. Viewers swipe away and retention drops, which hurts reach more than a weak hook.
- Text near the edges, where the username, caption, progress bar and buttons cover it.
- No captions. Muted viewers leave.
- "Follow for more" or "like if…" end cards instead of a loop.
- Hashtag stuffing (#fyp #viral #foryou walls); Instagram rejects more than 5 anyway.
- Watermarked re-uploads across platforms; Instagram down-ranks them.
- A store URL in a Shorts description or comment; it will not be clickable.

## Checklist
- [ ] The first frame has motion and the hook lands within 3 seconds in ≤ 7 words.
- [ ] Every beat has a time range, a visual and on-screen text or VO.
- [ ] The video pays off the hook before the end.
- [ ] Total length is 15–45 seconds.
- [ ] The last beat loops into the first.
- [ ] Captions are on and text sits inside each platform's safe zone.
- [ ] Caption written for each platform: TikTok ≤ 2,200 chars, Instagram ≤ 5 hashtags, Shorts title ≤ 100 chars with a keyword.
- [ ] Store link via Instagram bio, Shorts Related Video or channel links, never a spoken or typed URL in a Short.
- [ ] The uploaded file has no other platform's watermark.

## Sources
- [How TikTok recommends videos #ForYou — TikTok Newsroom, 2020](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you) — finishing a video is a strong signal; captions, sounds, hashtags are inputs.
- [Creative best practices for performance ads — TikTok for Business, 2025](https://ads.tiktok.com/resources/help/article/creative-best-practices) — proposition in 3 s, hook in 6 s, 9:16, safe zone, 5–10 words/s.
- [Content Posting API: Direct Post — TikTok for Developers, 2026](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post) — 2,200-character caption limit via API.
- [Helping creators of all sizes break through — Instagram Creators, 2025](https://creators.instagram.com/blog/helping-creators-of-all-sizes-break-through) — hook in the first 3 s, view rate past 3 s.
- [Instagram Ranking Explained — Instagram, 2023](https://about.instagram.com/blog/announcements/instagram-ranking-explained) — watch-through, sends, likes; watermarked/reposted reels down-ranked.
- [Instagram is implementing new limits on hashtag use — Social Media Today, 2025](https://www.socialmediatoday.com/news/instagrams-implementing-new-limits-on-hashtag-use/808309/) — 5-hashtag cap; Mosseri says hashtags don't add reach.
- [Instagram swoops in with 3-minute Reels and rectangular profile grids — Engadget, 2025](https://www.engadget.com/social-media/instagram-swoops-in-with-3-minute-reels-and-rectangular-profile-grids-as-the-tiktok-ban-gets-real-201316339.html) — Reels up to 3 min, taller grid.
- [Understand three-minute YouTube Shorts — YouTube Help, 2026](https://support.google.com/youtube/answer/15424877?hl=en) — square/vertical up to 3 min count as Shorts.
- [Sharing links with your audiences — YouTube Help, 2026](https://support.google.com/youtube/answer/13748639?hl=en) — Shorts description/comment URLs not clickable; Related Video and channel links are.
- [Edit video settings — YouTube Help, 2026](https://support.google.com/youtube/answer/57404?hl=en&co=GENIE.Platform%3DDesktop) — titles max 100 characters.
- [Capture attention with updated features for video ads — Meta for Business](https://www.facebook.com/business/news/updated-features-for-video-ads) — most feed video watched muted; captions +12% view time.
- [How long should a social media video be? — Hootsuite, 2026](https://blog.hootsuite.com/social-media-video-length/) — 15–45 s as an editorial starting point, no perfect length.
