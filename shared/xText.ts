// X weighted character counting (twitter-text v3 config), shared by the worker and the web previews.

/** Code point ranges that weigh 1; everything else weighs 2. */
const LIGHT_RANGES: Array<[number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];
const URL_LENGTH = 23;
const BARE_TLDS =
  "com|net|org|io|co|app|dev|ai|me|ly|gg|tv|xyz|info|biz|edu|gov|us|uk|de|fr|es|it|nl|ca|au|in|jp|ru|br|eu|tr|link|site|online|store|blog|news|page|so|sh";
/** URLs and bare domains (X auto-links them). Also used by lib/usage.ts (`has_url`). */
export const URL_RE = new RegExp(
  `(?<![@\\w.])(?:https?:\\/\\/[^\\s]+|(?:[a-z0-9-]+\\.)+(?:${BARE_TLDS})\\b(?:\\/[^\\s]*)?)`,
  "gi",
);
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Regional_Indicator}|\uFE0F|\u20E3|\u200D/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const weighSegment = (segment: string): number => {
  if (EMOJI_RE.test(segment)) return 2;
  let w = 0;
  for (const ch of segment) {
    const cp = ch.codePointAt(0)!;
    w += LIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return w;
};

/** Pieces of the text with their weight: a URL is one piece of 23, everything else one piece per grapheme. */
function pieces(input: string): Array<{ text: string; weight: number }> {
  const text = input.normalize("NFC");
  const out: Array<{ text: string; weight: number }> = [];
  const plain = (s: string) => {
    for (const { segment } of segmenter.segment(s)) out.push({ text: segment, weight: weighSegment(segment) });
  };
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    // Trailing punctuation is not part of the URL.
    const url = m[0].replace(/[.,!?;:'")\]]+$/, "");
    plain(text.slice(last, m.index));
    out.push({ text: url, weight: URL_LENGTH });
    last = m.index! + url.length;
  }
  plain(text.slice(last));
  return out;
}

/** X's weighted length: URLs count 23, CJK/emoji count 2, most Latin text 1. */
export function xWeightedLength(input: string): number {
  return pieces(input).reduce((sum, p) => sum + p.weight, 0);
}

/** The text split where it goes over `limit` (weighted): [fits, over]. */
export function xSplitAtLimit(input: string, limit: number): [string, string] {
  let total = 0;
  const all = pieces(input);
  for (let i = 0; i < all.length; i++) {
    total += all[i].weight;
    if (total > limit) return [all.slice(0, i).map((p) => p.text).join(""), all.slice(i).map((p) => p.text).join("")];
  }
  return [input.normalize("NFC"), ""];
}
