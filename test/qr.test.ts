import { describe, expect, it } from "vitest";
import { qrMatrix } from "../src/lib/qr";

// The vendored QR encoder (src/lib/qr.ts, pairing and web sign-in codes of the iOS app). Fixtures: modules of the
// same texts from the reference encoder qrcode-generator (MIT), rows as base-36 bit strings; it picks its own mask, so
// one of ours must match it exactly (version, codewords, interleaving, format and version information).

const FIXTURES = [
  { s: "HELLO", n: 21, rows: ["18m0v", "murl", "wsil", "wrx9", "wspp", "mzpd", "18prz", "4qo", "xe9o", "j83w", "azce", "ici4", "grvp", "46g", "18oeu", "mxq6", "wsye", "wt7s", "wspw", "mwv0", "18qhi"] },
  {
    // Version 8: two block groups and the version information blocks.
    s: `postflare://web-login?s=https%3A%2F%2Fpostflare.ferdi.app&r=wl_AbCdEfGhIjKlMnOp&k=QrStUvWxYz0123456789ab-${"q".repeat(30)}`,
    n: 49,
    rows: [
      "5ip6vhwdj3", "2tswr3c8xt", "40zya1w21p", "41k1utt1lp", "419q6w6l3x", "2tdlg0wq4h", "5iicojrr7j", "hn6h9hc0", "3yuje2e8uj", "2fx7p6qbxg",
      "3q1fwb16j8", "3nowcean6k", "axrwla2q1", "m5birozs3", "2ywldy8vy", "5be0hkynbl", "2wry6vk532", "deo1h6e2j", "4u88madb8n", "37nzyp8x1k",
      "4l54gnjxc8", "1ocawzs05w", "2rgipmojr0", "3njfkcin1a", "3033c7qxxy", "j6d567kf1", "3st2kpgjju", "2zh0j240kg", "4dv995160c", "17xjcd5qbr",
      "3v4q3uidpf", "54qv8hm8gp", "13qsgv18oq", "ai619s5pm", "53t4d4yi30", "n2sqez4cu", "1wfrwlir11", "3wjlbnwd9u", "1j5bs5xw2y", "2fhp5ntktd",
      "4wsozskef1", "pjqi8zro", "5ikgn8vqsb", "2tz79rfvo3", "411kif0nhs", "41ej4xc5sp", "41fbivocvv", "2te1m62vu4", "5inbh4lm07",
    ],
  },
];

const decode = (rows: string[], n: number) =>
  rows.map((r) => {
    let v = 0n;
    for (const ch of r) v = v * 36n + BigInt(parseInt(ch, 36));
    return v.toString(2).padStart(n, "0");
  });
const encode = (m: boolean[][]) => m.map((row) => row.map((d) => (d ? "1" : "0")).join(""));

describe("QR encoder", () => {
  for (const f of FIXTURES) {
    it(`matches the reference encoder (${f.n}×${f.n})`, () => {
      const expected = decode(f.rows, f.n);
      const masks = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => encode(qrMatrix(f.s, m)));
      expect(masks.some((m) => m.join() === expected.join())).toBe(true);
      // The automatic choice is one of the valid masked symbols.
      expect(masks.map((m) => m.join())).toContain(encode(qrMatrix(f.s)).join());
    });
  }

  it("grows the version with the text and refuses texts over version 15", () => {
    expect(qrMatrix("x".repeat(14)).length).toBe(21);
    expect(qrMatrix("x".repeat(15)).length).toBe(25);
    expect(qrMatrix("x".repeat(412)).length).toBe(77);
    expect(() => qrMatrix("x".repeat(413))).toThrow(/too long/);
  });
});
