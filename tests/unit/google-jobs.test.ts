import { describe, it, expect, vi } from "vitest";
import { cleanLink, dateChip, rowsFromSerp, searchGoogleJobs, GoogleJobsSetupError, type FetchLike } from "../../src/core/jobs/google-jobs.js";
import { runJobSpy, type JobSpyOptions, type RunCommand } from "../../src/core/jobs/jobspy.js";

const NOW = new Date("2026-11-06T12:00:00");

// Shaped like the real SerpApi answer of 6 Nov 2026 (engine=google_jobs, Ohio, date_posted:3days).
const page1 = {
  search_metadata: { status: "Success" },
  jobs_results: [
    { title: "Software Release Systems Engineer", company_name: "Ford Motor Company", location: "Dearborn, MI", via: "Ford Careers",
      extensions: ["1 day ago", "Full-time", "Paid time off"], description: "Build  release\n systems.",
      apply_options: [{ title: "Ford Careers", link: "https://www.careers.ford.com/en/job/dearborn/sw-release" }, { title: "Monster", link: "https://www.monster.com/job-openings/vehicle-sw--m1" }, { title: "LinkedIn", link: "https://www.linkedin.com/jobs/view/1" }],
      share_link: "https://www.google.com/search?ibp=htl;jobs&q=x&htidocid=A" },
    { title: "Software Engineer (Python, APIs)", company_name: "PNC", location: "Strongsville, OH (+3 others)", via: "PNC Careers",
      extensions: ["3 days ago", "Full-time"], apply_options: [{ title: "PNC Careers", link: "https://careers.pnc.com/job/R240018" }, { title: "BeBee", link: "https://bebee.com/x" }] },
    { title: "Senior Software Engineer", company_name: "Siemens", location: "Mason, OH", via: "Hiring Cafe",
      extensions: ["Full-time"], detected_extensions: { posted_at: "2 days ago" },
      apply_options: [{ title: "Hiring Cafe", link: "https://hiringcafe.com/job/s1" }, { title: "Indeed", link: "https://www.indeed.com/viewjob?jk=09" }] },
    { title: "Old post", company_name: "X", location: "Columbus, OH", via: "LinkedIn", extensions: ["25 days ago"], apply_options: [{ title: "LinkedIn", link: "https://www.linkedin.com/jobs/view/old" }] },
    { title: "", company_name: "No title", via: "Indeed", apply_options: [{ title: "Indeed", link: "https://www.indeed.com/viewjob?jk=1" }] },
  ],
  serpapi_pagination: { next_page_token: "tok2" },
};
const page2 = { search_metadata: { status: "Success" }, jobs_results: [
  { title: "Java Lead", company_name: "Archer", location: "Westerville, OH", via: "LinkedIn", extensions: ["1 day ago"], apply_options: [{ title: "LinkedIn", link: "https://www.linkedin.com/jobs/view/2" }] },
  { title: "Software Release Systems Engineer", company_name: "Ford Motor Company", location: "Dearborn, MI", via: "Ford Careers", extensions: ["1 day ago"], apply_options: [{ title: "Ford Careers", link: "https://www.careers.ford.com/en/job/dearborn/sw-release" }] }, // duplicate link
] };

describe("Google Jobs (SerpApi): mapping", () => {
  it("picks Google's date filter from hoursOld", () => {
    expect(dateChip(24)).toBe("date_posted:today"); expect(dateChip(72)).toBe("date_posted:3days"); expect(dateChip(168)).toBe("date_posted:week"); expect(dateChip(500)).toBe("date_posted:month");
  });
  it("maps rows: the 'via' source link first, dates from the extensions, location suffix removed, source kept in site", () => {
    const rows = rowsFromSerp(page1, NOW);
    expect(rows.map((r) => r.title)).toEqual(["Software Release Systems Engineer", "Software Engineer (Python, APIs)", "Senior Software Engineer", "Old post"]);
    expect(rows[0]).toMatchObject({ site: "google_jobs:Ford Careers", job_url: "https://www.careers.ford.com/en/job/dearborn/sw-release", date_posted: "2026-11-05", description: "Build release systems." });
    expect(rows[1]).toMatchObject({ location: "Strongsville, OH", date_posted: "2026-11-03" });
    expect(rows[2]).toMatchObject({ date_posted: "2026-11-04" }); // detected_extensions.posted_at wins
    expect(rows[3]!.date_posted).toBe("2026-10-12");
  });
  it("drops Google's utm_ tail from links and a trailing 'Jobs' from titles", () => {
    expect(cleanLink("https://www.indeed.com/viewjob?jk=4f75&utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic")).toBe("https://www.indeed.com/viewjob?jk=4f75");
    expect(cleanLink("https://careers.pnc.com/job/R1?utm_campaign=x")).toBe("https://careers.pnc.com/job/R1");
    expect(cleanLink("not a url")).toBe("not a url");
    const r = rowsFromSerp({ jobs_results: [{ title: "Jr Software Engineer Jobs", company_name: "R", via: "X", apply_options: [{ title: "X", link: "https://x.com/j?utm_source=g" }] }] }, NOW);
    expect(r[0]).toMatchObject({ title: "Jr Software Engineer", job_url: "https://x.com/j" });
  });
  it("keeps every board a post is on, and preferLink picks that board's link when present", () => {
    const rows = rowsFromSerp(page1, NOW, "monster");
    expect(rows[0]!.boards).toEqual(["Ford Careers", "Monster", "LinkedIn"]);
    expect(rows[0]!.job_url).toBe("https://www.monster.com/job-openings/vehicle-sw--m1"); // Ford post is also on Monster
    expect(rows[1]!.job_url).toBe("https://careers.pnc.com/job/R240018");                 // PNC post is not: normal choice
    expect(rowsFromSerp(page1, NOW)[0]!.job_url).toBe("https://www.careers.ford.com/en/job/dearborn/sw-release"); // without preference
  });
  it("falls back to a board link, then the first apply link, then Google's share link", () => {
    const r = rowsFromSerp({ jobs_results: [
      { title: "A", company_name: "C", via: "Somewhere", apply_options: [{ title: "Jooble", link: "https://jooble.org/1" }, { title: "Monster", link: "https://www.monster.com/job-openings/a" }] },
      { title: "B", company_name: "C", via: "Somewhere", apply_options: [{ title: "Jooble", link: "https://jooble.org/2" }] },
      { title: "D", company_name: "C", share_link: "https://www.google.com/search?ibp=htl;jobs&htidocid=D" },
    ] }, NOW);
    expect(r.map((x) => x.job_url)).toEqual(["https://www.monster.com/job-openings/a", "https://jooble.org/2", "https://www.google.com/search?ibp=htl;jobs&htidocid=D"]);
  });
});

const fetchOf = (pages: Record<string, unknown>, calls: string[] = []): FetchLike => async (url) => {
  calls.push(url);
  const token = new URL(url).searchParams.get("next_page_token") ?? "";
  const body = pages[token];
  return { ok: true, status: 200, json: async () => body };
};
const OPTS = { apiKey: "k", location: "Ohio, United States", hoursOld: 72, timeoutMs: 5_000 };

describe("Google Jobs (SerpApi): the call", () => {
  it("asks for the right page, keeps fresh posts only, follows the token up to maxPages, removes duplicates, counts searches", async () => {
    const calls: string[] = [];
    const r = await searchGoogleJobs("software engineer", 20, { ...OPTS, maxPages: 2 }, fetchOf({ "": page1, tok2: page2 }, calls), NOW);
    expect(r.error).toBeUndefined();
    expect(r.searches).toBe(2);
    expect(r.rows.map((x) => x.title)).toEqual(["Software Release Systems Engineer", "Software Engineer (Python, APIs)", "Senior Software Engineer", "Java Lead"]); // old post dropped, duplicate dropped
    const u = new URL(calls[0]!);
    expect(u.origin + u.pathname).toBe("https://serpapi.com/search.json");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ engine: "google_jobs", q: "software engineer", location: "Ohio, United States", chips: "date_posted:3days", api_key: "k", gl: "us" });
    expect(new URL(calls[1]!).searchParams.get("next_page_token")).toBe("tok2");
  });
  it("default is one page, so one search per term", async () => {
    const calls: string[] = [];
    const r = await searchGoogleJobs("x", 50, OPTS, fetchOf({ "": page1, tok2: page2 }, calls), NOW);
    expect(calls).toHaveLength(1); expect(r.searches).toBe(1);
  });
  it("a used-up quota is a plain board error with the rows read so far", async () => {
    const f: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({ error: "Your account has run out of searches." }) });
    const r = await searchGoogleJobs("x", 10, OPTS, f, NOW);
    expect(r.rows).toEqual([]); expect(r.error).toMatch(/quota used up/);
  });
  it("a missing or rejected key is a setup error (stops the run once, with the fix)", async () => {
    await expect(searchGoogleJobs("x", 10, { ...OPTS, apiKey: "" }, fetchOf({}), NOW)).rejects.toThrow(/SERPAPI_KEY is not set/);
    const f: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({ error: "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key" }) });
    await expect(searchGoogleJobs("x", 10, OPTS, f, NOW)).rejects.toBeInstanceOf(GoogleJobsSetupError);
  });
  it("a slow answer becomes an error, not a hang", async () => {
    const f: FetchLike = (_u, { signal }) => new Promise((_r, rej) => { signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
    const r = await searchGoogleJobs("x", 10, { ...OPTS, timeoutMs: 50 }, f, NOW);
    expect(r.error).toMatch(/no answer within/);
  });
});

describe("google_jobs inside runJobSpy", () => {
  const base: JobSpyOptions = { python: "python3", script: "scripts/jobspy_search.py", sites: ["indeed", "google_jobs"], location: "Ohio", hoursOld: 72, countryIndeed: "USA", proxies: [], timeoutMs: 60_000 };
  const spyOut = { jobs: [{ site: "indeed", title: "Dev", company: "Indeed Co", job_url: "https://www.indeed.com/viewjob?jk=1", date_posted: "2026-11-05" }], errors: {} };
  const run: RunCommand = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(spyOut), stderr: "" }));
  it("merges Google Jobs rows; the Python script gets only its own boards; a Monster link is not a company domain", async () => {
    const gj = vi.fn(async () => ({ rows: rowsFromSerp(page1, NOW).slice(0, 1), searches: 1 }));
    const r = await runJobSpy("rpg", 10, base, run, { searchGoogleJobs: gj });
    expect(r.hits.map((h) => h.company_name).sort()).toEqual(["Ford Motor Company", "Indeed Co"]);
    expect(r.hits.find((h) => h.company_name === "Ford Motor Company")!.company_domain).toBeUndefined();
    expect(JSON.parse((run as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1][1]).sites).toEqual(["indeed"]);
    expect(gj).toHaveBeenCalledWith("rpg", 10, expect.objectContaining({ location: "Ohio", hoursOld: 72, maxPages: 1 }));
  });
  it("quota error is a board error; setup error stops the run", async () => {
    const r = await runJobSpy("rpg", 10, base, run, { searchGoogleJobs: vi.fn(async () => ({ rows: [], searches: 1, error: "SerpApi quota used up for this month (x)" })) });
    expect(r.hits).toHaveLength(1); expect(r.boardErrors.google_jobs).toMatch(/quota/);
    await expect(runJobSpy("rpg", 10, base, run, { searchGoogleJobs: vi.fn(async () => { throw new GoogleJobsSetupError("SERPAPI_KEY is not set in .env"); }) })).rejects.toThrow(/SERPAPI_KEY/);
  });
  it("monster and google_jobs can run together, with no Python call when no JobSpy board is listed", async () => {
    const run2: RunCommand = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
    const r = await runJobSpy("rpg", 10, { ...base, sites: ["monster", "google_jobs"] }, run2, {
      searchMonster: vi.fn(async () => ({ rows: [{ site: "monster", title: "M", company: "MC", job_url: "https://www.monster.com/job-openings/m" }] })),
      searchGoogleJobs: vi.fn(async () => ({ rows: [{ site: "google_jobs:Dice", title: "G", company: "GC", job_url: "https://www.dice.com/job/g" }], searches: 1 })),
    });
    expect(run2).not.toHaveBeenCalled();
    expect(r.hits.map((h) => h.company_name).sort()).toEqual(["GC", "MC"]);
  });
});

describe("run log: posts per board", () => {
  it("counts by board and says how many are on Monster", async () => {
    const { boardSummary } = await import("../../src/core/jobs/job-search.js");
    const { rowToHit } = await import("../../src/core/jobs/jobspy.js");
    const hits = [
      rowToHit({ site: "indeed", title: "A", company: "C", job_url: "https://www.indeed.com/viewjob?jk=1" })!,
      rowToHit({ site: "indeed", title: "B", company: "C", job_url: "https://www.indeed.com/viewjob?jk=2" })!,
      rowToHit({ site: "linkedin", title: "D", company: "C", job_url: "https://www.linkedin.com/jobs/view/3" })!,
      ...rowsFromSerp(page1, NOW).slice(0, 2).map((r) => rowToHit(r)!),
      rowToHit({ site: "monster", title: "M", company: "C", job_url: "https://www.monster.com/job-openings/m" })!,
    ];
    expect(boardSummary(hits)).toBe("6 posts: indeed 2, linkedin 1, google_jobs 2, monster 1 (on Monster 2)");
    expect(boardSummary([])).toBe("0 posts");
  });
});
