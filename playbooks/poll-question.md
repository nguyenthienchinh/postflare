---
id: poll-question
version: 2
name: Poll or genuine question
summary: A specific, easy-to-answer question you answer first yourself, so replies come from real opinions and not from bait.
goal: engagement
platforms: [microblog, linkedin, linkedin_page, instagram, instagram_standalone, facebook, reddit]
formats: [text, image]
tags: [mobile-app, game, community, question, poll, research]
inputs: [the decision or topic you want opinions on, 2-4 concrete answer options, your own answer and the reason, what you will do with the answers]
---

## When to use
- You are actually deciding something (next feature, default setting, pricing tier name, level difficulty) and real opinions would change the outcome.
- You want to learn how your audience works (when they use the app, what they tried before) in a format that costs them five seconds.
- The account has been quiet and you want a low-stakes post that invites replies without selling anything. Questions reliably pull comments: a 2012 study of brand posts found a question increased comments, and Metricool's 2026 LinkedIn data shows 77% more comments on posts with a question.

Do not use it when you have already decided, or when the only reason is "the algorithm likes comments". People can tell, and the answers you get will be worthless.

## Structure
1. **Line 1 — the question, ≤ 90 characters.** One question, not two. Concrete nouns ("dark mode or sepia?"), not abstractions ("what do you value in an app?").
2. **Options.** 2–4 labelled choices (A/B/C or numbered) so answering is one character. Native polls on X, Threads and Mastodon cap each option at 25 characters, so write short labels if a native poll might be used. Include an "other — tell me" escape hatch only if it is a real possibility.
3. **Your answer first.** One or two lines: what you would pick and why. This models the reply format and shows you are not fishing (unverified that it raises reply rate: test it).
4. **Why you are asking.** One line of context: "We ship one of these in November." Stakes make the answer feel worth giving.
5. **Close the loop.** Afterwards, post the result and what you did with it (a follow-up reply or a new post). This builds trust for the next poll (unverified: test it).

### Native polls vs text polls
Postflare does not create native polls on every platform. Native polls exist on X (2–4 options, 5 minutes to 7 days), LinkedIn (2–4 options, 1 day to 2 weeks), Threads (2–4 options, text-only posts), Mastodon (up to 4 options, 5 minutes to 7 days), Facebook Groups and Pages, many subreddits, and as an Instagram Stories sticker. Bluesky has no native polls in the official app as of this writing. When Postflare cannot attach one, write a **text poll**: numbered options in the body and "reply with the number". If the user wants a native poll on a platform Postflare does not support for it, schedule the post as a draft and tell them to add the poll by hand in the native app. Text polls have one advantage: replies carry reasons, not just a tap, and on X a reply is weighted far more than a like in the ranking.

## Platform notes
- **X:** 280 characters (Premium up to 25,000). Keep question + options + your answer under 280 so it is one post. Native poll options are 25 characters max. Put "why we're asking" or the result recap in a follow-up (thread reply).
- **Bluesky:** 300 graphemes, no native polls; a text poll with numbered options works.
- **Threads:** 500 characters, one topic tag per post that matches the community (e.g. "IndieDev"). Native polls take 2–4 options of up to 25 characters and only attach to text-only posts.
- **Mastodon:** 500 characters by default (varies by server); native polls take up to 4 options of 25 characters each, single or multiple choice. For text polls ask people to reply. CamelCase hashtags (#IndieDev) so screen readers can split the words.
- **LinkedIn:** 3,000 characters; the "see more" fold sits around 140–200 characters, so the question must be in line 1. Native polls run 1 day, 3 days, 1 week (default) or 2 weeks, and the author can see who voted for what. Frame it as a professional decision, not trivia. In Metricool's 2026 data, company page polls averaged about 3× the impressions of other page formats.
- **Instagram:** the caption shows about 125 characters before "more"; put the question before the fold. An image with the options written large is worth testing against a caption-only question (unverified: test it). Stories have a native poll sticker, but that is posted by hand.
- **Facebook:** long text is fine; native polls are available in Groups and, depending on the account, Pages. Facebook demotes "like/comment/share if…" bait but exempts posts asking for help, advice or recommendations, so a genuine question is safe.
- **Reddit:** title is the question. Read the subreddit rules; some ban polls or self-promotion. Do not link your app in the body unless the rules allow it.

## Hooks
- **Forced choice:** "{option A} or {option B} for {specific situation}?" — two concrete options are faster to answer than an open question.
- **Behaviour question:** "When do you actually {use case}? 1) {time} 2) {time} 3) {time}" — people enjoy describing their own habits.
- **Decision we're stuck on:** "We can only ship one of these in {month}. Which one?" — real stakes plus a deadline makes the answer feel useful.
- **Before you {action}, do you {habit}?** — "Before you water a plant, do you check the soil?" Easy yes/no with a story behind it.

## Examples
### X (text poll, 254 characters)
```
Tempo users: which should we build first?

1) Focus sessions that sync with your calendar
2) A "do not disturb" that blocks chat apps
3) Weekly focus report by email

I'd pick 2, my focus dies on Slack pings. Reply with a number, we ship one in November.
```

### LinkedIn (text poll)
```
We can build exactly one feature for Pocket Plants this quarter. Which one would you use?

A) Photo-based diagnosis of yellow leaves
B) Watering reminders that adjust to the weather
C) A shared plant list for households

My vote is B. Half our support emails are "I watered it on schedule and it still died", and the schedule ignores a week of rain.

Reply with A, B or C. I'll post the result and what we decided next Friday.
```

### Bluesky (text poll, 189 graphemes)
```
Tiny Tower Defense question for people who play on the train:

1) 3-minute levels
2) 10-minute levels
3) Pause anywhere, length doesn't matter

I play 3 myself. Which one fits your commute?
```

## Avoid
- Engagement bait: "Comment YES if…", "Like for A, retweet for B", "Type 1 if you agree". Facebook and LinkedIn both say they reduce the reach of this, and it attracts bots, not users.
- Questions you already know the answer to, or rhetorical ones ("Who else hates bad apps?").
- Vague open questions ("Thoughts?", "What do you think about productivity?"). Effort kills replies.
- Too many options (more than 4) or two questions in one post; native polls cap at 4 anyway.
- Option labels over 25 characters when the post will become a native poll.
- Asking and then never reporting the result.
- Hashtag stuffing to "boost" the poll; one or two relevant tags at most.

## Checklist
- [ ] The question is in the first line and before the platform's fold.
- [ ] One question, 2–4 concrete options, answerable with one character or word.
- [ ] Native poll options are ≤ 25 characters each.
- [ ] Your own answer and reason are in the post.
- [ ] There is a real reason to ask, and it is stated.
- [ ] No "comment YES/like if" phrasing anywhere.
- [ ] Text fits the platform limit (X 280, Bluesky 300, Threads/Mastodon 500).
- [ ] If a native poll is needed where Postflare cannot create one, the user knows to add it by hand.
- [ ] A follow-up to share the result is planned or scheduled.

## Sources
- [Popularity of brand posts on brand fan pages — Journal of Interactive Marketing (de Vries, Gensler, Leeflang), 2012](https://research.rug.nl/en/publications/popularity-of-brand-posts-on-brand-fan-pages-an-investigation-of-/) — asking a question increased the number of comments.
- [What works on LinkedIn in 2026 — Metricool, 2026](https://metricool.com/linkedin-trends-study/) — posts with a question get 77% more comments.
- [LinkedIn engagement shifts toward clicks as visible metrics decline — Net Influencer, 2026](https://www.netinfluencer.com/linkedin-engagement-shifts-toward-clicks-as-visible-metrics-decline-study-finds/) — Metricool: company page polls averaged ~3× other formats' impressions.
- [Create a post (poll object) — X Developer Platform, 2026](https://docs.x.com/x-api/posts/create-post) — X polls: 2–4 options, 25 characters each, 5 to 10,080 minutes.
- [Create LinkedIn polls — LinkedIn Help, 2026](https://www.linkedin.com/help/linkedin/answer/a522948) — 2–4 options; Pages and groups can post polls.
- [LinkedIn polls — LinkedIn Help, 2026](https://www.linkedin.com/help/linkedin/answer/a527273) — durations of 1 day, 3 days, 1 week or 2 weeks; author sees votes.
- [Polls — Threads API, Meta for Developers, 2026](https://developers.facebook.com/documentation/threads/create-posts/polls) — 2–4 options of 1–25 characters, text-only posts.
- [Posting toots — Mastodon documentation, 2026](https://docs.joinmastodon.org/user/posting/) — 500-character default; polls up to 4 choices of 25 characters, 5 minutes to 7 days.
- [Fighting engagement bait on Facebook — Meta Newsroom, 2017](https://about.fb.com/news/2017/12/news-feed-fyi-fighting-engagement-bait-on-facebook/) — bait is demoted; posts asking for help or advice are exempt.
- [x-algorithm: home-mixer/params/param.rs — xAI on GitHub, 2026](https://github.com/xai-org/x-algorithm/blob/main/home-mixer/params/param.rs) — reply weight 5.0 vs like 0.6.
- [Social media caption preview — Hootsuite, 2026](https://www.hootsuite.com/social-media-tools/social-media-caption-preview) — Instagram shows ~125 caption characters; LinkedIn ~140 before the fold.
