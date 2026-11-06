import { describe, it, expect, vi } from "vitest";
import { createServer, type Server } from "node:http";
import {
  dateFromRecency, withinHours, rowsFromApiJson, rowsFromCards, searchMonster, MonsterSetupError,
  type BrowserLike, type PageLike, type LaunchBrowser,
} from "../../src/core/jobs/monster.js";
import { runJobSpy, type JobSpyOptions, type RunCommand } from "../../src/core/jobs/jobspy.js";

const NOW = new Date("2026-11-06T10:00:00");

describe("Monster: dates", () => {
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

const apiPayload = {
  jobResults: [
    { jobId: "abc-1", jobPosting: { title: "Senior RPG Developer", datePosted: "2026-11-05T13:00:00Z", description: "<p>Build on IBM i.</p> More.", hiringOrganization: { name: "Buckeye Logistics" }, jobLocation: [{ address: { addressLocality: "Columbus", addressRegion: "OH" } }], url: "https://www.monster.com/job-openings/senior-rpg-developer-columbus-oh--abc-1" } },
    { jobId: "abc-2", jobPosting: { title: "Data Engineer", datePosted: "2026-11-05", hiringOrganization: { name: "Miami Valley Care" }, jobLocation: { address: { addressLocality: "Dayton", addressRegion: "OH" } } } },
    { jobId: "abc-3", jobPosting: { datePosted: "2026-11-05" } }, // no title: dropped
  ],
};

describe("Monster: rows from the page's JSON and from cards", () => {
  it("maps the schema.org-style payload", () => {
    const rows = rowsFromApiJson(apiPayload);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ site: "monster", title: "Senior RPG Developer", company: "Buckeye Logistics", location: "Columbus, OH", date_posted: "2026-11-05", description: "Build on IBM i. More." });
    expect(rows[0]!.job_url).toBe("https://www.monster.com/job-openings/senior-rpg-developer-columbus-oh--abc-1");
    expect(rows[1]!.job_url).toBe("https://www.monster.com/job-openings/abc-2"); // built from the id when no url is given
  });
  it("accepts a few other spellings and ignores junk", () => {
    expect(rowsFromApiJson({ results: [{ title: "X", companyName: "Y", jobUrl: "/job-openings/x-1", postedDate: "2026-11-01" }] })[0]).toMatchObject({ company: "Y", job_url: "https://www.monster.com/job-openings/x-1", date_posted: "2026-11-01" });
    expect(rowsFromApiJson({ hello: 1 })).toEqual([]);
    expect(rowsFromApiJson(null)).toEqual([]);
  });
  it("maps on-screen cards and reads 'N days ago'", () => {
    const rows = rowsFromCards([{ title: " QA Lead ", href: "/job-openings/qa-lead--q1", company: "Acme", location: "Cincinnati, OH", recency: "2 days ago" }], NOW);
    expect(rows[0]).toMatchObject({ title: "QA Lead", company: "Acme", job_url: "https://www.monster.com/job-openings/qa-lead--q1", date_posted: "2026-11-04" });
  });
});

/** A fake browser: `goto` feeds the page's response hook with `json` (if any) and the cards come from `cards`. */
function fakeBrowser(plan: { json?: unknown; cards?: Array<Record<string, string>>; noCards?: boolean; bodyText?: string }[]): { launch: LaunchBrowser; visited: string[]; closed: { browser: number } } {
  const visited: string[] = [];
  const closed = { browser: 0 };
  let n = 0;
  let cb: ((r: { url(): string; ok(): boolean; json(): Promise<unknown> }) => void) | undefined;
  let cur: typeof plan[number] = {};
  const page: PageLike = {
    on: (_e, c) => { cb = c; },
    goto: async (url) => { visited.push(url); cur = plan[Math.min(n++, plan.length - 1)] ?? {}; if (cur.json !== undefined) cb?.({ url: () => "https://appsapi.monster.io/jobs-svx-service/v2/monster/search-jobs/samsearch/en-US?apikey=k", ok: () => true, json: async () => cur.json }); },
    waitForSelector: async () => { if (cur.noCards) throw new Error("timeout"); return {}; },
    waitForTimeout: async () => {},
    $$eval: (async (sel: string, fn: (els: Element[]) => unknown) => {
      if (sel === "body") return fn([{ textContent: cur.bodyText ?? "" } as unknown as Element]);
      // The real parser runs in the browser; here the cards are handed over already read.
      void fn;
      return (cur.cards ?? []) as unknown;
    }) as PageLike["$$eval"],
    close: async () => {},
  };
  const browser: BrowserLike = { newPage: async () => page, close: async () => { closed.browser++; } };
  return { launch: async () => browser, visited, closed };
}
const OPTS = { location: "Ohio", hoursOld: 72, timeoutMs: 60_000, maxPages: 3 };

describe("Monster: the browser flow", () => {
  it("prefers the JSON the page fetched, builds the search URL, stops when a page is mostly old", async () => {
    const old = { jobResults: [{ jobId: "o1", jobPosting: { title: "Old", datePosted: "2026-09-01", url: "https://www.monster.com/job-openings/o1" } }] };
    const fb = fakeBrowser([{ json: apiPayload }, { json: old }, { json: apiPayload }]);
    const r = await searchMonster("rpg developer", 20, OPTS, fb.launch, NOW);
    expect(r.error).toBeUndefined();
    expect(r.rows.map((x) => x.title)).toEqual(["Senior RPG Developer", "Data Engineer"]);
    expect(fb.visited[0]).toBe("https://www.monster.com/jobs/search?q=rpg%20developer&where=Ohio&page=1&so=m.h.sh");
    expect(fb.visited).toHaveLength(2); // page 2 was all old, so page 3 was not read
    expect(fb.closed.browser).toBe(1);
  });
  it("falls back to the cards on screen when no JSON was seen", async () => {
    const fb = fakeBrowser([{ cards: [{ title: "QA Lead", href: "/job-openings/q1", company: "Acme", location: "Dayton, OH", recency: "1 day ago" }] }, { cards: [] }]);
    const r = await searchMonster("qa", 20, OPTS, fb.launch, NOW);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ company: "Acme", date_posted: "2026-11-05", job_url: "https://www.monster.com/job-openings/q1" });
  });
  it("reports a bot check as an error, with the by-hand hint, and still closes the browser", async () => {
    const fb = fakeBrowser([{ noCards: true, bodyText: "Verification Required. Slide right to secure your access" }]);
    const r = await searchMonster("qa", 20, OPTS, fb.launch, NOW);
    expect(r.rows).toEqual([]);
    expect(r.error).toMatch(/bot check.*MONSTER_HEADLESS=false/);
    expect(fb.closed.browser).toBe(1);
    const visible = await searchMonster("qa", 20, { ...OPTS, headless: false }, fb.launch, NOW);
    expect(visible.error).toMatch(/not passed within two minutes/);
  });
  it("passes the profile folder and channel to the launcher", async () => {
    const seen: unknown[] = [];
    const fb = fakeBrowser([{ json: apiPayload }]);
    const launch: LaunchBrowser = async (o) => { seen.push(o); return fb.launch(o); };
    await searchMonster("x", 5, { ...OPTS, profileDir: "out/p", channel: "chromium" }, launch, NOW);
    expect(seen[0]).toEqual({ headless: true, profileDir: "out/p", channel: "chromium" });
    await searchMonster("x", 5, OPTS, launch, NOW);
    expect(seen[1]).toEqual({ headless: true, profileDir: "out/monster-profile" });
  });
  it("no cards and no bot check on page 1 is a plain error, not a throw", async () => {
    const fb = fakeBrowser([{ noCards: true }]);
    const r = await searchMonster("qa", 20, OPTS, fb.launch, NOW);
    expect(r.error).toMatch(/no job cards/);
  });
  it("a missing Playwright is a setup error that stops the run once", async () => {
    const launch: LaunchBrowser = async () => { throw new MonsterSetupError("Playwright is not installed. ..."); };
    await expect(searchMonster("qa", 5, OPTS, launch, NOW)).rejects.toBeInstanceOf(MonsterSetupError);
  });
  it("caps at resultsWanted and removes duplicate links", async () => {
    const many = { jobResults: Array.from({ length: 30 }, (_, i) => ({ jobId: `j${i % 20}`, jobPosting: { title: `T${i}`, datePosted: "2026-11-05", url: `https://www.monster.com/job-openings/j${i % 20}?x=${i}` } })) };
    const r = await searchMonster("x", 7, { ...OPTS, maxPages: 1 }, fakeBrowser([{ json: many }]).launch, NOW);
    expect(r.rows).toHaveLength(7);
    expect(new Set(r.rows.map((x) => (x.job_url ?? "").replace(/\?.*/, ""))).size).toBe(7);
  });
});

describe("Monster inside runJobSpy", () => {
  const base: JobSpyOptions = { python: "python3", script: "scripts/jobspy_search.py", sites: ["indeed", "monster"], location: "Ohio", hoursOld: 72, countryIndeed: "USA", proxies: [], timeoutMs: 60_000 };
  const spyOut = { jobs: [{ site: "indeed", title: "Dev", company: "Indeed Co", job_url: "https://www.indeed.com/viewjob?jk=1", date_posted: "2026-11-05" }], errors: {} };
  const run: RunCommand = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(spyOut), stderr: "" }));

  it("merges Monster rows with JobSpy rows and never sends 'monster' to the Python script", async () => {
    const monster = vi.fn(async () => ({ rows: [{ site: "monster", title: "RPG Dev", company: "Buckeye", job_url: "https://www.monster.com/job-openings/a1", date_posted: "2026-11-05" }] }));
    const r = await runJobSpy("rpg", 10, base, run, monster);
    expect(r.hits.map((h) => h.company_name).sort()).toEqual(["Buckeye", "Indeed Co"]);
    expect(r.hits.find((h) => h.company_name === "Buckeye")).toMatchObject({ url: "https://www.monster.com/job-openings/a1", posted_date: "2026-11-05" });
    const sent = JSON.parse((run as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1][1]) as { sites: string[] };
    expect(sent.sites).toEqual(["indeed"]);
    expect(r.boardErrors).toEqual({});
  });
  it("a Monster problem is a board error; the other boards' jobs are kept", async () => {
    const monster = vi.fn(async () => ({ rows: [], error: "Monster showed a bot check instead of results; try again later or from another network" }));
    const r = await runJobSpy("rpg", 10, base, run, monster);
    expect(r.hits).toHaveLength(1);
    expect(r.boardErrors.monster).toMatch(/bot check/);
  });
  it("sites=monster alone skips Python entirely", async () => {
    const run2: RunCommand = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
    const monster = vi.fn(async () => ({ rows: [{ site: "monster", title: "T", company: "C", job_url: "https://www.monster.com/job-openings/z" }] }));
    const r = await runJobSpy("t", 5, { ...base, sites: ["monster"] }, run2, monster);
    expect(run2).not.toHaveBeenCalled();
    expect(r.hits).toHaveLength(1);
  });
  it("without 'monster' in the sites, the reader is never started", async () => {
    const monster = vi.fn(async () => ({ rows: [] }));
    await runJobSpy("t", 5, { ...base, sites: ["indeed", "linkedin"] }, run, monster);
    expect(monster).not.toHaveBeenCalled();
  });
  it("a Monster setup error stops the run with the install hint", async () => {
    const monster = vi.fn(async () => { throw new MonsterSetupError("Playwright is not installed. In the backend folder run: npm i playwright  then  npx playwright install chromium"); });
    await expect(runJobSpy("t", 5, base, run, monster)).rejects.toThrow(/npx playwright install chromium/);
  });
  it("a Monster link is never taken as the company's own domain", async () => {
    const monster = vi.fn(async () => ({ rows: [{ site: "monster", title: "T", company: "C", job_url: "https://www.monster.com/job-openings/z", company_url_direct: "https://www.monster.com/company/c" }] }));
    const r = await runJobSpy("t", 5, { ...base, sites: ["monster"] }, run, monster);
    expect(r.hits[0]!.company_domain).toBeUndefined();
  });
});

// Real Chromium against a local page that behaves like Monster's: cards drawn by script after a JSON fetch.
// Runs only with MONSTER_E2E=1 (needs Playwright's Chromium installed).
const e2e = process.env.MONSTER_E2E === "1" ? describe : describe.skip;
e2e("Monster: real browser against a local look-alike page", () => {
  const html = `<!doctype html><html><body><div id="JobCardGrid"></div><script>
    fetch(location.pathname.replace('/jobs/search','/search-jobs') + location.search).then(r => r.json()).then(j => {
      const g = document.getElementById('JobCardGrid');
      for (const it of j.jobResults) {
        const a = document.createElement('article'); a.setAttribute('data-testid','svx_jobCard');
        a.innerHTML = '<a data-testid="jobTitle" href="/job-openings/' + it.jobId + '">' + it.jobPosting.title + '</a><span data-testid="company">' + it.jobPosting.hiringOrganization.name + '</span><span data-testid="jobDetailLocation">Dayton, OH</span><span data-testid="jobDetailDateRecency">1 day ago</span>';
        g.appendChild(a);
      }
    });
  </script></body></html>`;
  let server: Server; let base = "";
  const start = () => new Promise<void>((ok) => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/search-jobs") {
        const page = Number(u.searchParams.get("page") ?? "1");
        const body = page === 1 ? { jobResults: [{ jobId: "m1", jobPosting: { title: "IBM i Developer", datePosted: "2026-11-05", hiringOrganization: { name: "Buckeye Logistics" }, url: "https://www.monster.com/job-openings/m1" } }] } : { jobResults: [] };
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); return;
      }
      res.setHeader("content-type", "text/html"); res.end(html);
    }).listen(0, "127.0.0.1", () => { const a = server.address() as { port: number }; base = `http://127.0.0.1:${a.port}`; ok(); });
  });
  it("reads the JSON the page fetched and closes the browser", async () => {
    await start();
    try {
      const r = await searchMonster("ibm i developer", 10, { ...OPTS, baseUrl: base, maxPages: 2, channel: "chromium", profileDir: `${process.env.TMPDIR ?? "/tmp"}/monster-profile-test-${Date.now()}` }, undefined, new Date("2026-11-06T10:00:00"));
      expect(r.error).toBeUndefined();
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ title: "IBM i Developer", company: "Buckeye Logistics", date_posted: "2026-11-05", job_url: "https://www.monster.com/job-openings/m1" });
    } finally { server.close(); }
  }, 60_000);
});
