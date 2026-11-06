import { describe, expect, it, vi } from "vitest";

import { ApifyMonsterSetupError, postDate, rowsFromApify, searchApifyMonster, type ApifyFetch } from "../../src/core/jobs/apify-monster.js";
import { runJobSpy, type JobSpyOptions, type RunCommand } from "../../src/core/jobs/jobspy.js";

const NOW = new Date("2026-11-06T12:00:00Z");

// blackfalcondata~monster-scraper style
const itemsA = [
  { title: "Java Developer", company: "Acme Corp", companyWebsite: "https://www.acme.com", url: "https://www.monster.com/job-openings/a", postedDate: "2026-11-05T10:00:00Z", location: "Dayton, OH", description: "Build  things." },
  { title: "Old Post", company: "Old Co", url: "https://www.monster.com/job-openings/old", postedDate: "2026-09-01" },
  { title: "", company: "No Title", url: "https://www.monster.com/job-openings/x" },
];
// thirdwatch~monster-jobs-scraper style
const itemsB = [{ title: "QA Engineer", company: "Beta LLC", url: "https://www.monster.com/job-openings/b", posted_date: "2 days ago", location: "Remote" }];

const OPTS = { token: "t", actor: "blackfalcondata/monster-scraper", location: "United States", hoursOld: 72, timeoutMs: 60_000 };

/** A fake Apify: POST /runs starts a run, GET /actor-runs answers RUNNING once then `final`, GET /datasets gives `items`. */
function fakeFetch(status: number, items: unknown, final = "SUCCEEDED") {
  const calls: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }> = [];
  let polls = 0;
  const reply = (st: number, b: unknown) => ({ ok: st >= 200 && st < 300, status: st, json: async () => b, text: async () => JSON.stringify(b) });
  const f: ApifyFetch = async (url, init) => {
    calls.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}), headers: init.headers });
    if (url.includes("/runs?")) return status === 201 ? reply(201, { data: { id: "run1", status: "READY", defaultDatasetId: "ds1" } }) : reply(status, items);
    if (url.includes("/actor-runs/run1")) return reply(200, { data: { id: "run1", status: polls++ ? final : "RUNNING", defaultDatasetId: "ds1" } });
    if (url.includes("/datasets/ds1/items")) return reply(200, items);
    return reply(404, {});
  };
  return { f, calls };
}

describe("rowsFromApify", () => {
  it("maps both common actor shapes and drops items with no title", () => {
    const rows = rowsFromApify([...itemsA, ...itemsB], NOW);
    expect(rows.map((r) => r.company)).toEqual(["Acme Corp", "Old Co", "Beta LLC"]);
    expect(rows[0]).toMatchObject({ site: "monster", company_url_direct: "https://www.acme.com", date_posted: "2026-11-05", description: "Build things." });
    expect(rows[2]!.date_posted).toBe("2026-11-04");
  });
  it("is empty for a non-array", () => expect(rowsFromApify({ error: "x" })).toEqual([]));
  it("postDate reads ISO dates and 'ago' text", () => {
    expect(postDate("2026-11-01", NOW)).toBe("2026-11-01");
    expect(postDate("", NOW)).toBe("");
  });
});

describe("searchApifyMonster", () => {
  it("starts one run, waits with short requests, keeps fresh posts only", async () => {
    const { f, calls } = fakeFetch(201, itemsA);
    const r = await searchApifyMonster("java developer", 10, OPTS, f, NOW);
    expect(r.rows.map((x) => x.company)).toEqual(["Acme Corp"]);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "GET", "GET"]);
    expect(calls[0]!.url).toContain("/v2/acts/blackfalcondata~monster-scraper/runs?");
    expect(calls[3]!.url).toContain("/v2/datasets/ds1/items?");
    expect(calls[0]!.headers.authorization).toBe("Bearer t");
    const input = JSON.parse(calls[0]!.body!);
    expect(input).toMatchObject({ query: "java developer", queries: ["java developer"], location: "", maxResults: 10 });
  });
  it("no token or a bad token or a wrong actor stops the run", async () => {
    await expect(searchApifyMonster("x", 10, { ...OPTS, token: "" })).rejects.toBeInstanceOf(ApifyMonsterSetupError);
    await expect(searchApifyMonster("x", 10, OPTS, fakeFetch(401, {}).f, NOW)).rejects.toThrow(/APIFY_TOKEN/);
    await expect(searchApifyMonster("x", 10, OPTS, fakeFetch(404, {}).f, NOW)).rejects.toThrow(/APIFY_MONSTER_ACTOR/);
  });
  it("a failed run is a board error", async () => {
    const r = await searchApifyMonster("x", 10, OPTS, fakeFetch(201, [], "FAILED").f, NOW);
    expect(r.error).toMatch(/failed/);
  });
  it("a dropped connection while waiting is tried again once", async () => {
    const { f } = fakeFetch(201, itemsA);
    let dropped = false;
    const flaky: ApifyFetch = async (url, init) => {
      if (url.includes("/actor-runs/") && !dropped) { dropped = true; throw new TypeError("fetch failed"); }
      return f(url, init);
    };
    const r = await searchApifyMonster("x", 10, OPTS, flaky, NOW);
    expect(r.rows).toHaveLength(1);
  });
  it("a usage limit is a board error, not a crash", async () => {
    const r = await searchApifyMonster("x", 10, OPTS, fakeFetch(402, { error: { message: "Monthly usage limit exceeded" } }).f, NOW);
    expect(r.rows).toEqual([]);
    expect(r.error).toMatch(/usage limit/);
  });
});

describe("monster_apify inside runJobSpy", () => {
  const base: JobSpyOptions = { python: "python3", script: "scripts/jobspy_search.py", sites: ["indeed", "monster_apify"], location: "Ohio", hoursOld: 72, countryIndeed: "USA", proxies: [], timeoutMs: 60_000 };
  const spyOut = { jobs: [{ site: "indeed", title: "Dev", company: "Indeed Co", job_url: "https://www.indeed.com/viewjob?jk=1", date_posted: "2026-11-05" }], errors: {} };
  it("merges Apify rows, Python gets only its own boards, and the company website becomes the domain", async () => {
    const run: RunCommand = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(spyOut), stderr: "" }));
    const ap = vi.fn(async () => ({ rows: rowsFromApify(itemsA, NOW).slice(0, 1) }));
    const r = await runJobSpy("java", 10, base, run, { searchApifyMonster: ap });
    expect(r.hits.map((h) => h.company_name).sort()).toEqual(["Acme Corp", "Indeed Co"]);
    expect(r.hits.find((h) => h.company_name === "Acme Corp")).toMatchObject({ company_domain: "acme.com", board: "monster" });
    expect(JSON.parse((run as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1][1]).sites).toEqual(["indeed"]);
    expect(ap).toHaveBeenCalledWith("java", 10, expect.objectContaining({ location: "Ohio", hoursOld: 72 }));
  });
  it("a board error keeps the other jobs; a setup error stops the run", async () => {
    const run: RunCommand = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(spyOut), stderr: "" }));
    const r = await runJobSpy("java", 10, base, run, { searchApifyMonster: vi.fn(async () => ({ rows: [], error: "Apify Monster: HTTP 402" })) });
    expect(r.hits).toHaveLength(1);
    expect(r.boardErrors.monster_apify).toMatch(/402/);
    await expect(runJobSpy("java", 10, base, run, { searchApifyMonster: vi.fn(async () => { throw new ApifyMonsterSetupError("APIFY_TOKEN is not set"); }) })).rejects.toThrow(/APIFY_TOKEN/);
  });
});
