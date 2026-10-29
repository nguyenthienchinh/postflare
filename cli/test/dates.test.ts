import { describe, expect, it } from "vitest";
import { parseClock, parseFuture, parseSpan, parseTime } from "../src/dates.js";
import { UsageError } from "../src/errors.js";

// Monday 2026-10-12 10:30 local time.
const NOW = new Date(2026, 9, 12, 10, 30, 0, 0);
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const p = (s: string, extra = {}) => parseTime(s, { now: NOW, ...extra });

describe("parseClock", () => {
  it("reads 24h and am/pm clocks", () => {
    expect(parseClock("9:00")).toEqual([9, 0]);
    expect(parseClock("09:30")).toEqual([9, 30]);
    expect(parseClock("21:15")).toEqual([21, 15]);
    expect(parseClock("9am")).toEqual([9, 0]);
    expect(parseClock("12am")).toEqual([0, 0]);
    expect(parseClock("12pm")).toEqual([12, 0]);
    expect(parseClock("6:45 pm")).toEqual([18, 45]);
    expect(parseClock("9")).toBeNull();
    expect(parseClock("25:00")).toBeNull();
    expect(parseClock("13pm")).toBeNull();
  });
});

describe("parseTime", () => {
  it("now and relative times", () => {
    expect(p("now")).toBe(NOW.getTime());
    expect(p("in 30m")).toBe(NOW.getTime() + 30 * 60_000);
    expect(p("in 2h")).toBe(NOW.getTime() + 2 * 3_600_000);
    expect(p("in 3d")).toBe(NOW.getTime() + 3 * 86_400_000);
    expect(p("in 2 hours")).toBe(NOW.getTime() + 2 * 3_600_000);
    expect(p("+90min")).toBe(NOW.getTime() + 90 * 60_000);
    expect(p("2h ago")).toBe(NOW.getTime() - 2 * 3_600_000);
  });

  it("bare spans are past only for ranges", () => {
    expect(() => p("7d")).toThrow(UsageError);
    expect(p("7d", { relativePast: true })).toBe(NOW.getTime() - 7 * 86_400_000);
    expect(p("-12h")).toBe(NOW.getTime() - 12 * 3_600_000);
  });

  it("today / tomorrow / yesterday", () => {
    expect(p("tomorrow 9:00")).toBe(local(2026, 10, 13, 9, 0));
    expect(p("tomorrow 9am")).toBe(local(2026, 10, 13, 9, 0));
    expect(p("tomorrow at 18:30")).toBe(local(2026, 10, 13, 18, 30));
    expect(p("tomorrow")).toBe(local(2026, 10, 13, 9, 0)); // default clock
    expect(p("today 18:00")).toBe(local(2026, 10, 12, 18, 0));
    expect(p("yesterday", { relativePast: true })).toBe(local(2026, 10, 11));
  });

  it("weekdays: the next occurrence in the future", () => {
    expect(p("mon 18:00")).toBe(local(2026, 10, 12, 18, 0)); // today, still ahead
    expect(p("mon 9:00")).toBe(local(2026, 10, 19, 9, 0)); // today but past: next week
    expect(p("next mon 18:00")).toBe(local(2026, 10, 19, 18, 0));
    expect(p("fri 18:00")).toBe(local(2026, 10, 16, 18, 0));
    expect(p("Friday 6pm")).toBe(local(2026, 10, 16, 18, 0));
    expect(p("sun")).toBe(local(2026, 10, 18, 9, 0));
    expect(() => p("someday 9:00")).toThrow(UsageError);
  });

  it("clock only: today, or tomorrow when past", () => {
    expect(p("18:00")).toBe(local(2026, 10, 12, 18, 0));
    expect(p("8:00")).toBe(local(2026, 10, 13, 8, 0));
  });

  it("local dates and ISO", () => {
    expect(p("2026-10-14 09:00")).toBe(local(2026, 10, 14, 9, 0));
    expect(p("2026-10-14T09:00")).toBe(local(2026, 10, 14, 9, 0));
    expect(p("2026-10-14 9:00pm")).toBe(local(2026, 10, 14, 21, 0));
    expect(p("2026-10-14")).toBe(local(2026, 10, 14, 9, 0));
    expect(p("2026-10-14", { relativePast: true })).toBe(local(2026, 10, 14));
    expect(p("2026-10-14T09:00:00Z")).toBe(Date.UTC(2026, 9, 14, 9, 0));
    expect(p("2026-10-14T09:00:00+02:00")).toBe(Date.UTC(2026, 9, 14, 7, 0));
    expect(p("1791968400000")).toBe(1791968400000);
    expect(() => p("2026-02-30 10:00")).toThrow(/no such day/);
    expect(() => p("next tuesday-ish")).toThrow(UsageError);
    expect(() => p("")).toThrow(UsageError);
  });
});

describe("parseFuture / parseSpan", () => {
  it("rejects past times for --at", () => {
    expect(() => parseFuture("2026-10-01 09:00", { now: NOW })).toThrow(/in the past/);
    expect(parseFuture("in 1h", { now: NOW })).toBe(NOW.getTime() + 3_600_000);
  });

  it("parses ranges", () => {
    expect(parseSpan("7d")).toBe(7 * 86_400_000);
    expect(parseSpan("12h")).toBe(12 * 3_600_000);
    expect(parseSpan("2w")).toBe(14 * 86_400_000);
    expect(() => parseSpan("7x")).toThrow(UsageError);
    expect(() => parseSpan("constructor")).toThrow(UsageError);
  });
});
