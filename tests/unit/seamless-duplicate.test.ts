import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSavedContactsCache,
  findSavedContact,
  seamlessFindRecruiter,
  type LookupOutcome,
} from "../../src/core/sources/seamless-finder.js";

/** A fake Seamless: answers by path. `saved` is the account's saved-contacts list; `pollStatus` the research status. */
function fakeSeamless(opts: { pollStatus: string; saved?: unknown; savedStatus?: number; searchIds?: string[] }) {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.includes("/search/contacts")) return json({ data: (opts.searchIds ?? ["s-1"]).map((searchResultId) => ({ searchResultId })) });
    if (u.endsWith("/contacts/research")) return json({ success: true, requestIds: ["req-1"] });
    if (u.includes("/contacts/research/poll")) return json({ success: true, data: [{ requestId: "req-1", status: opts.pollStatus }] });
    if (u.includes("/contacts?")) return json(opts.saved ?? { data: [] }, opts.savedStatus ?? 200);
    return json({}, 404);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const savedRows = {
  data: [
    { name: "Pat Buyer", title: "Purchasing Manager", companyName: "US Foods", companyDomain: "usfoods.com", email: "pat@usfoods.com", createdAt: "2026-10-01" },
    { name: "Rae Hire", title: "Talent Acquisition Partner", companyName: "US Foods", companyDomain: "usfoods.com", email: "rae@usfoods.com", createdAt: "2026-09-01" },
    { name: "Other", title: "Recruiter", companyName: "Grainger", email: "o@grainger.com", createdAt: "2026-10-02" },
  ],
};

const poll = { pollMs: 0, maxWaitMs: 50, savedDays: 30 };

describe("Seamless 'duplicate' research status", () => {
  beforeEach(() => clearSavedContactsCache());

  it("reads the email from saved contacts and prefers a recruiter title", async () => {
    const { fetchFn, calls } = fakeSeamless({ pollStatus: "duplicate", saved: savedRows });
    let o: LookupOutcome | undefined;
    const hit = await seamlessFindRecruiter({ name: "US Foods", domain: "usfoods.com" }, "key", fetchFn, poll, (x) => { o = x; });
    expect(hit?.email).toBe("rae@usfoods.com");
    expect(o).toBe("found");
    expect(calls.some((c) => c.includes("/contacts?"))).toBe(true);
  });

  it("also accepts 'contact-already-researched' and matches by company name when there is no domain", async () => {
    const { fetchFn } = fakeSeamless({ pollStatus: "contact-already-researched", saved: savedRows });
    const hit = await seamlessFindRecruiter({ name: "Grainger" }, "key", fetchFn, poll);
    expect(hit?.email).toBe("o@grainger.com");
  });

  it("is an error (retry later), not 'no one there', when the saved contact cannot be found", async () => {
    const { fetchFn } = fakeSeamless({ pollStatus: "duplicate", saved: { data: [] } });
    let o: LookupOutcome | undefined;
    expect(await seamlessFindRecruiter({ name: "Keen Footwear" }, "key", fetchFn, poll, (x) => { o = x; })).toBeUndefined();
    expect(o).toBe("error");
  });

  it("is an error when the saved-contacts list cannot be read", async () => {
    const { fetchFn } = fakeSeamless({ pollStatus: "duplicate", savedStatus: 404 });
    let o: LookupOutcome | undefined;
    expect(await seamlessFindRecruiter({ name: "US Foods" }, "key", fetchFn, poll, (x) => { o = x; })).toBeUndefined();
    expect(o).toBe("error");
  });

  it("'not found' is a real 'no one there'", async () => {
    const { fetchFn } = fakeSeamless({ pollStatus: "not found" });
    let o: LookupOutcome | undefined;
    await seamlessFindRecruiter({ name: "Red Bull" }, "key", fetchFn, poll, (x) => { o = x; });
    expect(o).toBe("none");
  });

  it("no search result is 'none'", async () => {
    const { fetchFn } = fakeSeamless({ pollStatus: "done", searchIds: [] });
    let o: LookupOutcome | undefined;
    await seamlessFindRecruiter({ name: "SEMS" }, "key", fetchFn, poll, (x) => { o = x; });
    expect(o).toBe("none");
  });

  it("reads the saved list once for several duplicates (cache)", async () => {
    const { fetchFn, calls } = fakeSeamless({ pollStatus: "duplicate", saved: savedRows });
    await seamlessFindRecruiter({ name: "US Foods" }, "key", fetchFn, poll);
    await seamlessFindRecruiter({ name: "Grainger" }, "key", fetchFn, poll);
    expect(calls.filter((c) => c.includes("/contacts?")).length).toBe(1);
  });

  it("finds a named poster by person name", async () => {
    const { fetchFn } = fakeSeamless({ pollStatus: "duplicate", saved: savedRows });
    const c = await findSavedContact("key", fetchFn, { companyName: "US Foods", personName: "Pat Buyer" }, poll);
    expect(c?.email).toBe("pat@usfoods.com");
  });

  it("accepts a bare array and a { results } body", async () => {
    for (const saved of [savedRows.data, { results: savedRows.data }]) {
      clearSavedContactsCache();
      const { fetchFn } = fakeSeamless({ pollStatus: "duplicate", saved });
      expect((await findSavedContact("key", fetchFn, { domain: "usfoods.com" }, poll))?.email).toBe("pat@usfoods.com");
    }
  });
});
