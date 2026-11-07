import { describe, it, expect } from "vitest";
import { dateFromRecency, withinHours } from "../../src/core/jobs/dates.js";

const NOW = new Date("2026-11-06T10:00:00");

describe("post dates", () => {
  it.each([
    ["Posted today", "2026-11-06"], ["2 hours ago", "2026-11-06"], ["yesterday", "2026-11-05"],
    ["3 days ago", "2026-11-03"], ["1 week ago", "2026-10-30"], ["30+ days ago", "2026-10-07"],
    ["2026-11-04T08:00:00Z", "2026-11-04"],
  ])("%s -> %s", (text, want) => expect(dateFromRecency(text, NOW)).toBe(want));
  it("unreadable text gives no date", () => { expect(dateFromRecency("", NOW)).toBeUndefined(); expect(dateFromRecency("Easy apply", NOW)).toBeUndefined(); });
  it("withinHours keeps recent and unknown dates, drops old ones", () => {
    expect(withinHours("2026-11-04", 72, NOW)).toBe(true);
    expect(withinHours("2026-10-20", 72, NOW)).toBe(false);
    expect(withinHours(undefined, 72, NOW)).toBe(true);
  });
});
