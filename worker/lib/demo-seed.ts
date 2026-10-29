// Seed content of the public demo workspace (worker/lib/demo.ts): a fictional indie app studio, "Acme Studio",
// with two apps (Tempo, a focus timer, and Pocket Plants, a plant care app). Times are relative to the reset.

import type { PostStatus, ThreadItem } from "../../shared/types";
import { getProvider } from "../providers/registry";

export interface DemoAccount {
  id: string;
  provider: string;
  externalId: string;
  name: string;
  username: string | null;
  profileUrl: string | null;
}

const acc = (key: string, provider: string, name: string, username: string | null): DemoAccount => ({
  id: `acc_demo_${key}`,
  provider,
  externalId: `demo-${key}`,
  name,
  username,
  profileUrl: `https://example.com/demo/${provider}/${username ?? key}`,
});

export const DEMO_ACCOUNTS = {
  ig: acc("ig", "instagram_standalone", "Acme Studio", "acmestudio.apps"),
  tt: acc("tt", "tiktok", "Pocket Plants", "pocketplants"),
  yt: acc("yt", "youtube", "Acme Studio", "AcmeStudioDev"),
  x: acc("x", "x", "Tempo: focus timer", "tempoapp"),
  li: acc("li", "linkedin_page", "Acme Studio", null),
  th: acc("th", "threads", "Acme Studio", "acmestudio.apps"),
  bs: acc("bs", "bluesky", "Acme Studio", "acmestudio.bsky.social"),
  pin: acc("pin", "pinterest", "Acme Studio", "acmestudioapps"),
} satisfies Record<string, DemoAccount>;

type AccountKey = keyof typeof DEMO_ACCOUNTS;

/** Account groups of the demo (one per app, plus the studio). Threads stays ungrouped to show that section too. */
export const DEMO_ACCOUNT_GROUPS: Array<{ id: string; name: string; color: string; accounts: AccountKey[] }> = [
  { id: "agr_demo_tempo", name: "Tempo", color: "violet", accounts: ["x"] },
  { id: "agr_demo_plants", name: "Pocket Plants", color: "green", accounts: ["tt", "pin"] },
  { id: "agr_demo_acme", name: "Acme Studio", color: "orange", accounts: ["ig", "yt", "li", "bs"] },
];

/** Demo account id → its group id. */
export const demoAccountGroup = (accountId: string): string | null =>
  DEMO_ACCOUNT_GROUPS.find((g) => g.accounts.some((k) => DEMO_ACCOUNTS[k].id === accountId))?.id ?? null;

export interface DemoMedia {
  id: string;
  /** File in public/demo/ (static asset), copied to R2 under `demo/<file>`. */
  file: string;
  size: number;
  width: number;
  height: number;
  alt: string;
  /** Days before the reset it was "uploaded". */
  age: number;
}

const media = (key: string, file: string, size: number, width: number, height: number, age: number, alt: string): DemoMedia => ({
  id: `med_demo_${key}`,
  file,
  size,
  width,
  height,
  alt,
  age,
});

export const DEMO_MEDIA = {
  launch: media("launch", "tempo-launch.jpg", 121448, 1080, 1080, 11, "Tempo 2.0 launch graphic: “Focus, made calm.” next to the timer screen"),
  widgets: media("widgets", "tempo-widgets.jpg", 112788, 1080, 1350, 10, "Tempo home screen widgets: focus timer, a 12-day streak and a weekly chart"),
  plants: media("plants", "plants-launch.jpg", 134050, 1080, 1350, 9, "Pocket Plants app: “Never forget to water again” with a list of thirsty plants"),
  dark: media("dark", "plants-dark-mode.jpg", 106840, 1080, 1080, 7, "Two phones showing Pocket Plants in light and dark mode"),
  studio: media("studio", "acme-studio.jpg", 80761, 1080, 1080, 5, "“3 people. 2 apps. 1 tiny studio.” over colorful shapes"),
  review: media("review", "tempo-review.jpg", 126628, 1080, 1080, 4, "Five-star App Store review of Tempo by Maya K."),
  sale: media("sale", "tempo-pro-sale.jpg", 112247, 1080, 1080, 3, "Tempo Pro: 40% off this week"),
  devlog: media("devlog", "devlog-thumbnail.jpg", 103250, 1280, 720, 6, "Devlog #12 thumbnail: How we built Tempo 2.0 in 6 weeks"),
} satisfies Record<string, DemoMedia>;

type MediaKey = keyof typeof DEMO_MEDIA;

interface PostDef {
  acc: AccountKey;
  /** Day relative to today (instance timezone) and local time; `later` = a few hours from now instead. */
  day?: number;
  at?: [number, number];
  later?: number;
  status: Extract<PostStatus, "published" | "scheduled" | "draft" | "failed">;
  content: string;
  media?: MediaKey[];
  settings?: Record<string, unknown>;
  thread?: Array<{ content: string; media?: MediaKey[] }>;
  /** Posts with the same group are one multi-account post. */
  group?: string;
  error?: string;
  /** Built-in playbook the post was written with (version 1), and its A/B variant. */
  playbook?: string;
  variant?: string;
}

const tiktok = (title?: string) => ({
  postMode: "direct",
  privacy_level: "PUBLIC_TO_EVERYONE",
  allowComment: true,
  allowDuet: false,
  allowStitch: false,
  autoAddMusic: true,
  ...(title ? { title } : {}),
});
const ig = { post_type: "post", share_to_feed: true };

const POSTS: PostDef[] = [
  // ---- Published (last 10 days)
  {
    group: "launch",
    playbook: "launch-announcement",
    acc: "x",
    day: -9,
    at: [10, 0],
    status: "published",
    content: "Tempo 2.0 is live 🎉\n\nHome screen widgets, streaks that actually stick, and a calmer timer.\n\nFree on iPhone → https://example.com/tempo",
    media: ["launch"],
    settings: { replySettings: "everyone" },
  },
  {
    group: "launch",
    playbook: "launch-announcement",
    acc: "li",
    day: -9,
    at: [10, 0],
    status: "published",
    content:
      "Today we're launching Tempo 2.0, the biggest update since we started Acme Studio.\n\nWhat's new:\n• Home screen widgets\n• Streaks and weekly focus reports\n• A redesigned, calmer timer\n\nBuilt by a team of three in six weeks. Thank you to the 400+ beta testers who shaped it.",
    media: ["launch"],
    settings: { disableReshare: false },
  },
  {
    group: "launch",
    playbook: "launch-announcement",
    acc: "th",
    day: -9,
    at: [10, 0],
    status: "published",
    content: "Tempo 2.0 is out! Widgets, streaks and a calmer timer. Go focus 🧘",
    media: ["launch"],
    settings: { reply_control: "everyone", topic_tag: "IndieDev" },
  },
  {
    group: "launch",
    playbook: "launch-announcement",
    acc: "bs",
    day: -9,
    at: [10, 0],
    status: "published",
    content: "Tempo 2.0 just shipped: widgets, streaks and a calmer timer. Made by 3 humans, no VC 🫶 https://example.com/tempo",
    settings: { lang: "en", linkCard: true, label: "none" },
  },
  {
    group: "launch",
    playbook: "launch-announcement",
    acc: "ig",
    day: -9,
    at: [10, 0],
    status: "published",
    content: "Focus, made calm. ✨ Tempo 2.0 is here with home screen widgets, streaks and a brand new timer. Link in bio.",
    media: ["launch"],
    settings: ig,
    thread: [{ content: "#productivity #focus #pomodoro #iosapp #indiedev #appstore" }],
  },
  {
    acc: "tt",
    day: -7,
    at: [18, 30],
    status: "published",
    playbook: "app-feature-spotlight",
    content: "POV: your plants finally stop dying 🌿 Pocket Plants tells you exactly when and how much to water. #planttok #plantcare #houseplants",
    media: ["plants"],
    settings: tiktok("Never forget to water again"),
  },
  {
    acc: "x",
    day: -6,
    at: [9, 15],
    status: "published",
    playbook: "text-thread",
    content: "We built and shipped Tempo 2.0 in 6 weeks with a team of 3. Here's what worked (and what didn't) 🧵",
    settings: { replySettings: "everyone" },
    thread: [
      { content: "1/ Scope ruthlessly. We cut 11 of the 18 features on our list. Widgets and streaks made it, everything else waits for 2.1." },
      { content: "2/ Ship betas weekly. 400 TestFlight testers caught bugs we'd never have found, and told us which features they'd actually miss." },
      { content: "3/ Design the empty states first. They're the first thing new users see, and they shaped the whole flow.\n\nFull devlog → https://example.com/devlog-12" },
    ],
  },
  {
    acc: "pin",
    day: -5,
    at: [17, 0],
    status: "published",
    content: "Light or dark? Pocket Plants 1.8 brings a gorgeous dark mode for late-night plant parents 🌙🪴",
    media: ["dark"],
    settings: {
      board: "demo-board-1",
      title: "Pocket Plants dark mode",
      link: "https://example.com/pocket-plants",
      altText: "Two phones showing the Pocket Plants app in light and dark mode",
    },
  },
  {
    acc: "yt",
    day: -4,
    at: [16, 0],
    status: "published",
    playbook: "indie-dev-behind-the-scenes",
    content:
      "Six weeks, three people, one big update. In this devlog we walk through how we planned, designed and shipped Tempo 2.0.\n\n00:00 Intro\n01:12 Scoping the release\n04:30 Designing widgets\n09:05 Streaks without the guilt\n13:40 Launch day",
    media: ["devlog"],
    settings: {
      title: "How we built Tempo 2.0 in 6 weeks | Devlog #12",
      privacy: "public",
      category: "28",
      playlist: "demo-playlist-1",
      tags: ["indie dev", "ios development", "devlog", "swiftui"],
      madeForKids: false,
      notifySubscribers: true,
      embeddable: true,
      license: "youtube",
    },
    thread: [{ content: "What should we build into Tempo 2.1? Drop your ideas below 👇" }],
  },
  {
    acc: "ig",
    day: -3,
    at: [12, 30],
    status: "published",
    playbook: "player-feedback-showcase",
    content: "Reviews like this keep a tiny studio going 🥹 Thank you, Maya!",
    media: ["review"],
    settings: ig,
  },
  {
    acc: "li",
    day: -2,
    at: [8, 45],
    status: "published",
    playbook: "milestone-celebration",
    content:
      "3 people. 2 apps. 1 tiny studio.\n\nAcme Studio turns two this month. We've shipped Tempo and Pocket Plants to 120,000 people without a single ad campaign, mostly by sharing what we build, every week.\n\nHere's to year three 🥂",
    media: ["studio"],
    settings: { disableReshare: false },
  },
  {
    acc: "x",
    day: -1,
    at: [9, 0],
    status: "failed",
    content: "Tempo Pro is 40% off this week 🔥 Unlimited presets, iCloud sync and weekly focus reports.",
    media: ["sale"],
    settings: { replySettings: "everyone" },
    error: "X: You are not allowed to create a Tweet with duplicate content. (403 Forbidden)",
  },
  {
    group: "dark",
    acc: "bs",
    day: -1,
    at: [19, 0],
    status: "published",
    playbook: "app-update-notes-to-social",
    content: "Pocket Plants 1.8 is out with dark mode 🌙 Your plants won't notice, your eyes will.",
    media: ["dark"],
    settings: { lang: "en", linkCard: true, label: "none" },
  },
  {
    group: "dark",
    acc: "th",
    day: -1,
    at: [19, 0],
    status: "published",
    playbook: "app-update-notes-to-social",
    content: "Pocket Plants 1.8 is out with dark mode 🌙 Your plants won't notice, your eyes will.",
    media: ["dark"],
    settings: { reply_control: "everyone", topic_tag: "PlantTok" },
  },

  // ---- Drafts
  {
    acc: "li",
    status: "draft",
    content: "Behind the scenes: how we design a new feature at Acme Studio, from a sticky note to the App Store.\n\n(TODO: add the whiteboard photos)",
    settings: { disableReshare: false },
  },
  {
    acc: "ig",
    status: "draft",
    content: "Swipe → to see every widget size in Tempo 2.0",
    media: ["widgets", "launch"],
    settings: ig,
  },

  // ---- Scheduled (next 14 days)
  {
    group: "sale",
    acc: "ig",
    later: 3,
    status: "scheduled",
    content: "Tempo Pro is 40% off this week only 🔥 Unlimited presets, iCloud sync and weekly focus reports. Link in bio.",
    media: ["sale"],
    settings: ig,
    thread: [{ content: "#productivity #focus #appsale #iosapp" }],
  },
  {
    group: "sale",
    acc: "th",
    later: 3,
    status: "scheduled",
    content: "Tempo Pro is 40% off this week only 🔥 Unlimited presets, iCloud sync and weekly focus reports.",
    media: ["sale"],
    settings: { reply_control: "everyone" },
  },
  {
    acc: "pin",
    day: 1,
    at: [17, 30],
    status: "scheduled",
    content: "Home screen widgets for focus 📱 Start a session without even opening the app.",
    media: ["widgets"],
    settings: { board: "demo-board-2", title: "Tempo focus widgets", link: "https://example.com/tempo" },
  },
  {
    acc: "tt",
    day: 2,
    at: [9, 0],
    status: "scheduled",
    playbook: "short-video-hook-script",
    variant: "A",
    content: "3 widgets that made me actually focus 📱⏱️ #productivity #studytok #focus",
    media: ["widgets"],
    settings: tiktok("Widgets that help you focus"),
  },
  {
    acc: "li",
    day: 3,
    at: [10, 0],
    status: "scheduled",
    playbook: "linkedin-story-post",
    content:
      "Two years of running an indie app studio, in five lessons:\n\n1. Ship small, ship weekly\n2. Your changelog is marketing\n3. Support emails are product research\n4. Say no to most feature requests\n5. Rest is part of the roadmap",
    settings: { disableReshare: false },
    thread: [{ content: "Which one resonates most with you? We'd love to hear from other small teams." }],
  },
  {
    acc: "tt",
    day: 4,
    at: [18, 0],
    status: "scheduled",
    content: "Dark mode for your plant app? Say less 🌙🌿 #planttok #darkmode #plantparent",
    media: ["dark"],
    settings: tiktok(),
  },
  {
    acc: "bs",
    day: 5,
    at: [9, 30],
    status: "scheduled",
    content: "We're open-sourcing the design tokens behind Tempo and Pocket Plants: colors, type scale, spacing. All MIT. Repo drops Friday 👀",
    settings: { lang: "en", linkCard: true, label: "none" },
  },
  {
    acc: "yt",
    day: 6,
    at: [12, 0],
    status: "scheduled",
    content: "A quick tour of dark mode in Pocket Plants 1.8, and how we picked colors that keep your plant photos looking natural.",
    media: ["dark"],
    settings: {
      title: "Pocket Plants 1.8: dark mode tour",
      privacy: "public",
      category: "28",
      playlist: "demo-playlist-2",
      tags: ["pocket plants", "dark mode", "app design"],
      madeForKids: false,
      notifySubscribers: true,
      embeddable: true,
      license: "youtube",
    },
  },
  {
    acc: "x",
    day: 7,
    at: [11, 0],
    status: "scheduled",
    content: "AMA time 🎙️ We're three people running two apps with 120k users. Ask us anything about indie life, SwiftUI or App Store marketing. We'll answer all day.",
    settings: { replySettings: "everyone" },
  },
  {
    acc: "th",
    day: 8,
    at: [16, 0],
    status: "scheduled",
    playbook: "poll-question",
    content: "What's one app you open every single day? Ours is (obviously) Tempo ⏱️",
    settings: { reply_control: "everyone" },
  },
  {
    acc: "ig",
    day: 10,
    at: [9, 0],
    status: "scheduled",
    content: "Meet the team behind Acme Studio 👋 Three people, two apps, one shared love for calm software.",
    media: ["studio"],
    settings: ig,
    thread: [{ content: "#indiedev #appdeveloper #smallbusiness #buildinpublic" }],
  },
  {
    group: "beta",
    acc: "x",
    day: 12,
    at: [14, 0],
    status: "scheduled",
    content: "Tempo 2.1 beta testers wanted 🙋 Help us test focus playlists and Apple Watch support → https://example.com/beta",
    settings: { replySettings: "everyone" },
  },
  {
    group: "beta",
    acc: "li",
    day: 12,
    at: [14, 0],
    status: "scheduled",
    content:
      "We're looking for beta testers for Tempo 2.1: focus playlists and Apple Watch support. If you live in your calendar and want fewer distractions, we'd love your feedback: https://example.com/beta",
    settings: { disableReshare: false },
  },
  {
    acc: "tt",
    day: 13,
    at: [18, 30],
    status: "scheduled",
    content: "Day 30 of focusing with Tempo every day. Here's what changed 👇 #studywithme #productivity",
    media: ["launch"],
    settings: tiktok("30 days of focus"),
  },
];

/**
 * Older published posts (11 to 80 days ago), many written with playbooks (some as A/B variants), so the demo's
 * analytics and playbook ranking have history. [account, playbook, variant, content, media].
 */
const ARCHIVE: Array<[AccountKey, string | null, string | null, string, MediaKey[]]> = [
  ["tt", "short-video-hook-script", "A", "Your monstera is not dramatic, it's thirsty 💧 3 signs it needs water today #planttok #monstera", ["plants"]],
  ["tt", "short-video-hook-script", "B", "Stop watering your plants every Sunday. Here's why 👇 #planttok #plantcare", ["plants"]],
  ["tt", "app-feature-spotlight", null, "This button saved 14 of my plants 🌿 Pocket Plants photo diagnosis in 5 seconds #planttok", ["plants"]],
  ["tt", null, null, "Plant shelf tour, autumn edition 🍂🪴 #plantshelf #houseplants", ["dark"]],
  ["tt", "short-video-hook-script", "A", "If your pothos has yellow leaves, watch this before you repot 🪴 #pothos #planttok", ["plants"]],
  ["tt", "short-video-hook-script", "B", "Nobody tells you this about fiddle leaf figs 😬 #fiddleleaffig #planttok", ["plants"]],
  ["tt", null, null, "Morning routine with my 32 plants ☀️ #plantparent", ["plants"]],
  ["tt", "app-feature-spotlight", null, "The watering reminder that adapts to the weather ☔ Pocket Plants knows it rained #plantcare", ["dark"]],
  ["ig", "listicle-carousel", null, "5 plants that survive a dark apartment (swipe →) Save this for your next plant shop trip 🪴", ["plants", "dark"]],
  ["ig", null, null, "Studio Friday ☕ What are you working on this weekend?", ["studio"]],
  ["ig", "player-feedback-showcase", null, "Your reviews made our week 🥹 Thank you, Jonas, for the kind words about Tempo's widgets", ["review"]],
  ["ig", "listicle-carousel", null, "4 focus habits we built into Tempo (swipe →) Which one do you need most?", ["widgets", "launch"]],
  ["ig", null, null, "New wallpaper drop for Tempo users 🎨 Link in bio", ["launch"]],
  ["ig", "app-feature-spotlight", null, "One tap, 25 minutes, zero distractions. Tempo's focus widget in action ⏱️", ["widgets"]],
  ["x", "text-thread", "A", "We grew Tempo from 0 to 50k users without ads. Here's the playbook, step by step 🧵", []],
  ["x", "text-thread", "B", "7 things we learned shipping 40 app updates in 2 years 🧵", []],
  ["x", null, null, "Shipping a small fix today: widgets now refresh at midnight in every timezone 🌍", []],
  ["x", "download-cta-without-spam", null, "Tempo is free on iPhone. If you've been meaning to try a calmer focus timer, today's a good day → https://example.com/tempo", ["launch"]],
  ["x", "indie-dev-behind-the-scenes", null, "Spent 3 days on a bug that turned out to be one missing `await`. Indie dev life 🙃", []],
  ["x", null, null, "Weekend reading: our favorite essays on calm software, linked below 📚", []],
  ["x", "text-thread", "A", "How we price a subscription app as a 3-person studio (with real numbers) 🧵", []],
  ["th", "poll-question", null, "Morning focus or late-night focus? We're settling a team debate ☕🌙", []],
  ["th", null, null, "Little Tempo tip: long-press the timer to change the session length ⏱️", ["widgets"]],
  ["th", "indie-dev-behind-the-scenes", null, "Our whiteboard right now: 23 sticky notes, 2 good ideas. Guess which ones 👀", ["studio"]],
  ["th", "poll-question", null, "Be honest: how many plants have you lost this year? 🪦🌿", ["plants"]],
  ["bs", "indie-dev-behind-the-scenes", null, "Swapped our analytics for a privacy-friendly setup this week. Here's what we gave up and why", []],
  ["bs", null, null, "Tempo 2.0.3 is out: smoother widgets and fewer notifications 🙏", []],
  ["bs", "text-thread", "B", "A short thread on designing streaks that don't make people feel guilty 🧵", []],
  ["li", "linkedin-story-post", null, "Two years ago we almost shut down Acme Studio.\n\nRevenue was flat, we were tired, and the roadmap was a wish list.\n\nWhat changed: we stopped building for everyone and listened to 40 support emails a week.", []],
  ["li", null, null, "We're hiring a part-time iOS contractor for Tempo 2.2. Remote, async, calm. Details in the comments.", ["studio"]],
  ["li", "linkedin-story-post", null, "The best feature we ever shipped came from a one-line support email.\n\n“Can the timer just… not ring?”\n\nSilent mode is now used in 60% of Tempo sessions.", []],
  ["li", "milestone-celebration", null, "Pocket Plants just passed 50,000 downloads 🌿\n\nNo ads, no growth hacks: just plant people telling plant people. Thank you.", ["plants"]],
  ["yt", "indie-dev-behind-the-scenes", null, "Devlog #10: designing the Pocket Plants watering algorithm, and why weather data made it 3x better.", ["devlog"]],
  ["yt", null, null, "Tempo in 60 seconds: a quick tour of the timer, presets and widgets.", ["devlog"]],
  ["yt", "indie-dev-behind-the-scenes", null, "Devlog #11: we rewrote our widgets in a weekend (and what broke on Monday).", ["devlog"]],
  ["pin", "listicle-carousel", null, "7 low-light houseplants for small apartments 🪴 Save for later", ["plants"]],
  ["pin", null, null, "Minimal focus desk setup ideas ✨", ["widgets"]],
  ["tt", null, null, "Repotting day 🪴 Before and after of my calathea rescue #plantcare", ["plants"]],
  ["tt", null, null, "Answering your plant questions: why are my leaves curling? 🌿", ["dark"]],
  ["tt", "short-video-hook-script", "B", "Your snake plant can survive this. You can't 😅 #snakeplant #planttok", ["plants"]],
  ["tt", "app-feature-spotlight", null, "Scan a leaf, get a diagnosis. That's it. That's the feature 🔍🌿 #plantcare", ["plants"]],
  ["tt", "short-video-hook-script", "A", "3 watering mistakes I made for 5 years 💧 #plantparent #planttok", ["plants"]],
  ["ig", null, null, "A calm desk for a calm mind ✨ Tempo on the home screen, coffee on the left", ["widgets"]],
  ["ig", null, null, "Behind our app icons: 40 sketches, 1 winner 🎨", ["studio"]],
  ["ig", "listicle-carousel", null, "6 tiny habits for a focused morning (swipe →) Save it for Monday", ["widgets", "launch"]],
  ["ig", "player-feedback-showcase", null, "Fan art Friday 🖍️ Thank you, Lena, for drawing our little timer mascot", ["review"]],
  ["ig", "app-feature-spotlight", null, "Your streak, right on your lock screen 🔥 Tempo's new widget", ["widgets"]],
  ["x", null, null, "Small update: Tempo now remembers your last session length ⏱️", []],
  ["x", null, null, "What we're reading this week: three essays on calm technology 📚", []],
  ["x", "text-thread", "B", "We tried 5 onboarding flows for Pocket Plants. Here's the one that doubled day-7 retention 🧵", []],
  ["x", "text-thread", "A", "The 4 App Store screenshots that doubled our conversion rate (with before/afters) 🧵", []],
  ["x", "indie-dev-behind-the-scenes", null, "Today's commit message: “fix the fix that fixed the widget fix”. Send help 🙃", []],
  ["th", null, null, "Coffee, plants, SwiftUI. A typical Tuesday at the studio ☕🪴", ["studio"]],
  ["th", "text-thread", "A", "How we answer 200 support emails a week as a team of 3 🧵", []],
  ["th", "indie-dev-behind-the-scenes", null, "We almost shipped this bug to 50k people. Here's how TestFlight caught it 🐛", []],
  ["bs", null, null, "Pocket Plants now supports 1,200 plant species 🌱", []],
  ["bs", "indie-dev-behind-the-scenes", null, "Our entire analytics stack costs $0 a month. Here's what's in it", []],
  ["li", null, null, "We're giving a talk on calm software at IndieConf next month. Come say hi 👋", ["studio"]],
  ["li", "linkedin-story-post", null, "Our worst launch taught us more than our best one.\n\nZero downloads on day one. Here's what we changed for the next launch.", []],
  ["yt", null, null, "Pocket Plants tutorial: setting up your first plant in 2 minutes.", ["devlog"]],
  ["yt", "indie-dev-behind-the-scenes", null, "Devlog #9: the month we deleted half our code.", ["devlog"]],
];

/** Archive posts as PostDefs: spread over days -12 to -80, alternating morning and evening slots. */
function archiveDefs(): PostDef[] {
  return ARCHIVE.map(([acc, playbook, variant, content, media], i) => ({
    acc,
    day: -12 - Math.round((i * 68) / ARCHIVE.length),
    at: [i % 2 ? 18 : 9, (i * 17) % 60] as [number, number],
    status: "published" as const,
    content,
    media,
    settings: acc === "tt" ? tiktok() : acc === "ig" ? ig : acc === "x" ? { replySettings: "everyone" } : acc === "yt" ? { title: content.slice(0, 90), privacy: "public", category: "28" } : {},
    ...(playbook ? { playbook } : {}),
    ...(variant ? { variant } : {}),
  }));
}

export interface SeedPost {
  id: string;
  group_id: string;
  account_id: string;
  status: PostStatus;
  scheduled_at: number | null;
  content: string;
  media: string;
  settings: string;
  thread: string;
  external_id: string | null;
  external_url: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  playbook_id: string | null;
  playbook_version: number | null;
  variant: string | null;
}

/** [post id, level, message, created_at] */
export type SeedLog = [string, "info" | "warn" | "error", string, number];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Returns `(day, hour, minute) => ms` for wall-clock times in `tz` relative to the day of `t0`. */
function wallClock(tz: string, t0: number) {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  }
  const parts = (t: number) => {
    const o: Record<string, number> = {};
    for (const p of fmt.formatToParts(t)) if (p.type !== "literal") o[p.type] = Number(p.value);
    return o;
  };
  const offset = (t: number) => {
    const p = parts(t);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  };
  const today = parts(t0);
  return (day: number, hour: number, minute: number) => {
    const guess = Date.UTC(today.year, today.month - 1, today.day + day, hour, minute);
    return guess - offset(guess);
  };
}

export const fakeExternalId = () => String(1_800_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e15)) * 1000n + BigInt(Math.floor(Math.random() * 1000)));

export const fakePostUrl = (provider: string, externalId: string) => `https://example.com/demo/${provider}/${externalId}`;

export const SIMULATED_LOG = (providerName: string) => `Simulated publish — demo workspace, nothing was sent to ${providerName}`;

const providerName = (id: string) => getProvider(id)?.name ?? id;

/** Posts and their logs, with times relative to `t0` (wall-clock hours in `tz`). */
export function seedPosts(t0: number, tz: string, newId: (prefix: string) => string): { posts: SeedPost[]; logs: SeedLog[] } {
  const clock = wallClock(tz, t0);
  const groups = new Map<string, string>();
  const posts: SeedPost[] = [];
  const logs: SeedLog[] = [];
  // "Later today": a round half hour a few hours from now.
  const later = (h: number) => Math.ceil((t0 + h * HOUR) / (30 * 60 * 1000)) * 30 * 60 * 1000;

  [...POSTS, ...archiveDefs()].forEach((d, i) => {
    const account = DEMO_ACCOUNTS[d.acc];
    const id = newId("pst_");
    const groupId = d.group ? (groups.get(d.group) ?? groups.set(d.group, newId("grp_")).get(d.group)!) : newId("grp_");
    const at = d.status === "draft" ? null : d.later ? later(d.later) : clock(d.day ?? 1, d.at?.[0] ?? 9, d.at?.[1] ?? 0);
    // Written a day or two before going out (drafts: yesterday); never in the future.
    const created = Math.min(at !== null ? at - (1 + (i % 3)) * DAY + (i % 5) * 7 * 60 * 1000 : t0 - DAY - i * 37 * 60 * 1000, t0 - (i + 1) * 60 * 1000);
    const thread: ThreadItem[] = (d.thread ?? []).map((t) => ({ content: t.content, media: (t.media ?? []).map((m) => DEMO_MEDIA[m].id) }));
    const name = providerName(account.provider);
    let external: string | null = null;
    let url: string | null = null;
    let updated = created;
    let published: number | null = null;
    let attempts = 0;

    if (at !== null) logs.push([id, "info", `Scheduled for ${new Date(at).toISOString()}`, created]);
    if (d.status === "published" && at !== null) {
      external = fakeExternalId();
      url = fakePostUrl(account.provider, external);
      published = at + 2000 + (i % 4) * 1500;
      updated = published;
      attempts = 1;
      logs.push([id, "info", SIMULATED_LOG(name), at + 800]);
      logs.push([id, "info", `Published: ${url}`, published]);
      thread.forEach((t, n) => {
        if (t.content.trim() || t.media.length) logs.push([id, "info", `Follow-up ${n + 1} published: ${url}/r${n + 1}`, published! + (n + 1) * 1200]);
      });
    } else if (d.status === "failed" && at !== null) {
      attempts = 2;
      updated = at + 95_000;
      logs.push([id, "warn", `${name}: Service Unavailable (503), retrying`, at + 1500]);
      logs.push([id, "error", d.error ?? "Publishing failed", at + 94_000]);
      logs.push([id, "error", `Publishing failed: ${d.error ?? "unknown error"}`, updated]);
    }

    posts.push({
      id,
      group_id: groupId,
      account_id: account.id,
      status: d.status,
      scheduled_at: at,
      content: d.content,
      media: JSON.stringify((d.media ?? []).map((m) => DEMO_MEDIA[m].id)),
      settings: JSON.stringify(d.settings ?? {}),
      thread: JSON.stringify(thread),
      external_id: external,
      external_url: url,
      error: d.status === "failed" ? (d.error ?? null) : null,
      attempts,
      created_at: created,
      updated_at: updated,
      published_at: published,
      playbook_id: d.playbook ?? null,
      playbook_version: d.playbook ? 1 : null,
      variant: d.variant ?? null,
    });
  });
  return { posts, logs };
}

// ---------------------------------------------------------------------------------------------------------------
// App Store campaign links (worker/lib/campaigns.ts): two apps, tracked links on the published posts of clickable
// platforms, bio links for Instagram and TikTok, clicks and sample App Analytics numbers. Never from Revflare.

export const DEMO_PROVIDER_TOKEN = "123456";
export const DEMO_APPS = {
  tempo: { id: "app_demo_tempo", appStoreId: "6450000001", name: "Tempo: Focus Timer" },
  plants: { id: "app_demo_plants", appStoreId: "6450000002", name: "Pocket Plants" },
} as const;

export interface SeedCampaigns {
  /** [post id, app id] */
  postApps: Array<[string, string]>;
  links: Array<{ code: string; kind: "post" | "bio"; post_id: string | null; account_id: string; provider: string; app_id: string; app_store_id: string; ct: string; url: string; created_at: number }>;
  /** [code, day, clicks] */
  clicks: Array<[string, string, number]>;
  stats: Array<{ app_store_id: string; ct: string; downloads: number; redownloads: number; purchases: number; proceeds: number; sales: number; first_day: string; last_day: string }>;
}

/** Deterministic pseudo-random 0..1 from a string (stable numbers per post across renders of one reset). */
function unit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return (h % 10_000) / 10_000;
}

export function seedCampaigns(
  posts: SeedPost[],
  t0: number,
  helpers: {
    token: (provider: string, postId: string) => string;
    bioToken: (provider: string) => string;
    url: (appStoreId: string, ct: string) => string;
    code: () => string;
    clickable: (provider: string) => boolean;
  },
): SeedCampaigns {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const accountById = new Map(Object.values(DEMO_ACCOUNTS).map((a) => [a.id, a]));
  const out: SeedCampaigns = { postApps: [], links: [], clicks: [], stats: [] };
  const addResults = (code: string, ct: string, appStoreId: string, from: number, scale: number) => {
    // Clicks per day since `from`; Apple's numbers only for days at least 3 days old (reports lag 2-3 days).
    let total = 0;
    for (let d = from; d < t0; d += DAY) {
      const age = Math.floor((d - from) / DAY);
      const n = Math.max(0, Math.round(scale * (age === 0 ? 1 : 1 / (1 + age * 0.6)) * (0.6 + unit(`${code}${age}`))));
      if (!n) continue;
      out.clicks.push([code, day(d), n]);
      if (d < t0 - 3 * DAY) total += n;
    }
    if (total < 3) return;
    const downloads = Math.round(total * (0.18 + unit(`${ct}d`) * 0.2));
    const purchases = Math.round(downloads * (0.05 + unit(`${ct}p`) * 0.08));
    const sales = Math.round(purchases * 9.99 * 100) / 100;
    out.stats.push({
      app_store_id: appStoreId,
      ct,
      downloads,
      redownloads: Math.round(downloads * 0.12),
      purchases,
      proceeds: Math.round(sales * 0.85 * 100) / 100,
      sales,
      first_day: day(from),
      last_day: day(t0 - 3 * DAY),
    });
  };
  for (const p of posts) {
    const account = accountById.get(p.account_id);
    if (!account) continue;
    const app = /pocket plants|plant/i.test(p.content) || account.provider === "tiktok" ? DEMO_APPS.plants : /tempo|focus/i.test(p.content) ? DEMO_APPS.tempo : null;
    if (!app) continue;
    out.postApps.push([p.id, app.id]);
    if (p.status !== "published" || !p.published_at || !helpers.clickable(account.provider)) continue;
    const ct = helpers.token(account.provider, p.id);
    const code = helpers.code();
    out.links.push({ code, kind: "post", post_id: p.id, account_id: account.id, provider: account.provider, app_id: app.id, app_store_id: app.appStoreId, ct, url: helpers.url(app.appStoreId, ct), created_at: p.created_at });
    addResults(code, ct, app.appStoreId, p.published_at, 8 + unit(p.id) * 40);
  }
  // Bio links: Instagram (Tempo) and TikTok (Pocket Plants), 30 days of clicks.
  for (const [account, app] of [
    [DEMO_ACCOUNTS.ig, DEMO_APPS.tempo],
    [DEMO_ACCOUNTS.tt, DEMO_APPS.plants],
  ] as const) {
    const ct = helpers.bioToken(account.provider);
    const code = helpers.code();
    out.links.push({ code, kind: "bio", post_id: null, account_id: account.id, provider: account.provider, app_id: app.id, app_store_id: app.appStoreId, ct, url: helpers.url(app.appStoreId, ct), created_at: t0 - 30 * DAY });
    addResults(code, ct, app.appStoreId, t0 - 30 * DAY, 12);
  }
  return out;
}
