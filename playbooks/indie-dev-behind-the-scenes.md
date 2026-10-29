---
id: indie-dev-behind-the-scenes
version: 2
name: Indie dev behind the scenes
summary: Share work-in-progress, bugs, design decisions and tools so people follow the person building the app, not just the app.
goal: followers
platforms: [microblog, short-video, linkedin, instagram, instagram_standalone, reddit]
formats: [text, thread, image, carousel, video]
tags: [mobile-app, game, indie-dev, build-in-public, behind-the-scenes, wip]
inputs: [app or game name, the specific thing being worked on, a WIP screenshot or recording or before and after, the decision or problem and how it was resolved, tools used, what the dev is willing to share publicly]
---

## When to use
Use for the steady, everyday posts between launches: a work-in-progress screen, a bug that turned out funny, a design choice with trade-offs, the tool stack, a before/after of a redesign. People follow people: consumers rank authenticity and relatability as the brand traits they value most (Sprout Social Index 2025), and candid self-disclosure tends to make people more liked. An account that shows the work can earn an audience that later installs, beta-tests and shares. Good cadence: 2–3 per week (unverified: test it). Skip anything under NDA, unreleased platform features covered by Apple/Google beta terms (check the current developer agreement), and any user data.

## Structure
1. **Pick one moment**, not a weekly recap: one bug, one decision, one before/after.
2. **Line 1: the tension**, ≤ 70 characters, no emoji at the start. "Spent 2 days on a bug caused by one emoji." "Which one would you ship?"
3. **The visual:** WIP screenshot, a screen recording with dev overlays, a before/after pair, a Figma frame, or a gif of the bug. Unpolished is the point, but crop out API keys, emails, analytics dashboards with user data, and TestFlight tester names.
4. **The why in 1–3 sentences:** what you tried, what you chose, what it cost.
5. **Invite expertise or opinion**, specific: "Would you keep the haptic on every tap or only on completion?" Not "thoughts?".
6. **No download CTA** in most of these. Mention the app name naturally; a pinned post or bio does the selling.

## Platform notes
- **X:** 280 chars; the dev community uses #indiedev, #gamedev, #buildinpublic, #iOSDev (one or two, not all). Use a Postflare thread for the longer story: post 1 is the hook + visual, follow-ups carry the details. #ScreenshotSaturday is a long-running weekly hashtag where indie game devs share progress. Links (devlog, TestFlight) go in a reply to keep the hook clean; X says links are not deboosted (company claim, unverified: test it), and via the API any post with a URL costs $0.20 vs $0.015.
- **Bluesky:** 300 graphemes; an active gamedev and indie-app community (unverified: test it). Threads of 2–4 posts work well. Alt text matters to this audience.
- **Mastodon:** 500 chars by default; use CamelCase hashtags (#IndieDev, #GameDev, #SwiftUI) so screen readers can split the words; use a content warning (it collapses the post) for flashing visuals. Devs there value technical detail over marketing tone.
- **Threads:** 500 chars, exactly one topic tag per post ("Indie Dev" or "Game Dev").
- **TikTok / Reels / Shorts:** 9:16. Hook on screen in the first 1–2 seconds ("This bug made my plants fly"). Face-to-camera with screen-recording cutaways; 15–45 seconds (unverified: test it). A few specific hashtags; Instagram caps posts and Reels at 5.
- **LinkedIn:** 3,000 chars; the "…see more" fold lands around 140–210 chars depending on device. Lessons learned and decision trade-offs fit here; first 2 lines must stand alone. Links in the first comment via a follow-up (common practice, unverified: test it).
- **Instagram:** carousel "before / after / why" (up to 10 frames via the publishing API). Caption truncates after roughly 125 chars. Max 5 hashtags. Alt text on every frame.
- **Reddit:** r/gamedev, r/iOSProgramming, r/indiegames, r/SideProject each have their own rules; some confine self-promotion to weekly threads, and r/gamedev is an audience of developers, not players. Read the sidebar and wiki before posting. Title-first, give the technical detail, disclose it's your app, and reply to comments.
- **TestFlight / beta:** a public TestFlight link is a good occasional follow-up ("want to try the WIP? 200 spots"). Apple allows up to 10,000 external testers, public links included; the build must pass TestFlight App Review first, and beta access can't be given in exchange for any compensation (App Review Guideline 2.2). State that it's a beta.

## Hooks
- **The dumb bug:** "Spent {time} fixing a bug caused by {tiny cause}." — relatable to every developer, and funny to non-developers.
- **Help me choose:** "Option A or B for {screen/feature}?" with two images — a cheap decision to weigh in on, and people follow to see the result.
- **Before / after:** "{Thing} {months} ago vs today." — progress is satisfying and shows commitment.
- **Why I didn't:** "Why {app name} will never have {common feature}." — a stated principle attracts the people who share it.

## Examples
### X (thread)
```
Spent two days on a bug where plants watered themselves at 3am.

Cause: the reminder used the phone's time zone, the watering log used UTC.

[image: bug report screenshot, before/after timeline]
```
(Post: 139 characters)
```
Follow-up 1: Fix: store everything in UTC, convert only when showing it. Obvious in hindsight, invisible in testing because I never left my time zone.
```
```
Follow-up 2: If you're building anything with reminders: test with your simulator set to a different time zone. Took me 30 seconds once I knew. #iOSDev
```

### Bluesky (two-option poll-style post)
```
Game over screen for Tiny Tower Defense: A shows your best wave, B shows how close the last enemy got to the gate.

A feels fair, B makes me want one more try. Which would make you hit retry?

[images: A, B]
```
(Post: 191 graphemes)

## Avoid
- "Working on something exciting, stay tuned" with nothing shown.
- Weekly recaps with eight bullet points; nobody engages with a changelog of your week.
- Fake vulnerability or manufactured drama ("I almost gave up…") for engagement.
- "Follow for more" or follow-for-follow requests.
- Hashtag walls (#indiedev #gamedev #buildinpublic #coding #developer #100daysofcode…).
- Screens that leak keys, user emails, revenue dashboards you didn't mean to share, or tester names.
- Showing Apple/Google beta OS features that are still under NDA.
- Turning every BTS post into a download pitch.

## Checklist
- [ ] One moment, with a concrete detail (the bug, the decision, the number).
- [ ] Line 1 carries the tension and works without the image.
- [ ] Visual attached and checked for secrets, personal data and NDA material.
- [ ] Alt text written for every image.
- [ ] Ends with a specific question or a takeaway others can use.
- [ ] No hard download CTA; any link (devlog, TestFlight) sits in a follow-up, at most one per post.
- [ ] At most 1–2 community hashtags on X, CamelCase on Mastodon.
- [ ] Subreddit rules read before any Reddit post, and the dev role disclosed.

## Sources
- [The days of trend chasing are over (Sprout Social Index 2025) — Sprout Social, 2025](https://sproutsocial.com/insights/press/the-days-of-trend-chasing-are-over-new-research-from-sprout-social-reveals-a-third-of-consumers-think-jumping-on-viral-trends-is-embarrassing-for-brands/) — authenticity and relatability are the brand traits consumers value most.
- [Self-Disclosure and Liking: A Meta-Analytic Review — Collins & Miller, Psychological Bulletin, 1994](https://labs.psych.ucsb.edu/collins/nancy/UCSB_Close_Relationships_Lab/Publications_files/Collins%20and%20Miller,%201994.pdf) — people who disclose more tend to be liked more.
- [TestFlight — Apple Developer, n.d.](https://developer.apple.com/testflight/) — up to 10,000 external testers, public links, App Review for external builds.
- [App Review Guidelines — Apple Developer, 2026](https://developer.apple.com/app-store/review/guidelines/) — guideline 2.2: no compensation for TestFlight access.
- [Screenshot Saturday — GameLuster, 2021](https://gameluster.com/tag/screenshot-saturday/) — indie devs share weekly progress under #ScreenshotSaturday.
- [Publishing posts — Mastodon documentation, n.d.](https://docs.joinmastodon.org/user/posting/) — default 500-character limit, content warnings collapse posts.
- [Accessible hashtags — CUNY Accessibility Guide, n.d.](https://guides.cuny.edu/accessibility/hashtags) — screen readers need CamelCase to separate hashtag words.
- [Instagram will now let you share 20 photos per post — 9to5Mac, 2024](https://9to5mac.com/2024/08/08/instagram-will-now-let-you-share-20-photos-per-post/) — carousel limit raised from 10 to 20.
- [Instagram implements new limits on hashtag use — Social Media Today, 2025](https://www.socialmediatoday.com/news/instagram-implements-new-limits-on-hashtag-use/808309/) — 5 hashtags per post and Reel.
