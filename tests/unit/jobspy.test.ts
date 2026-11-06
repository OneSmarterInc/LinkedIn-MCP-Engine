import { describe, it, expect } from "vitest";
import { companyDomain, jobSpyOptionsFromEnv, JobSpySetupError, rowToHit, runJobSpy, useJobSpy, type RunCommand } from "../../src/core/jobs/jobspy.js";
import { normalizeBoardUrl, searchJobs } from "../../src/core/jobs/job-search.js";
import type { LLMProvider } from "../../src/lib/llm/provider.js";

// All companies and links here are made up.

const opts = { ...jobSpyOptionsFromEnv({}), python: "python", script: "scripts/jobspy_search.py" };
const reply = (body: unknown): RunCommand => async () => ({ code: 0, stdout: `${JSON.stringify(body)}\n`, stderr: "" });
const row = (o: Record<string, unknown> = {}) => ({
  site: "indeed", title: "Java Developer", company: "Acme", location: "Dayton, OH, US", date_posted: "2026-11-02",
  job_url: "https://www.indeed.com/viewjob?jk=abc1", company_url_direct: "https://www.acme.com", description: "Build services. Use Java 21. Join a small team.", ...o,
});
const noGemini = {
  name: "fake", supportsGrounding: false,
  async generateJSON() { throw new Error("Gemini must not be used to find jobs"); },
  async generateText() { return ""; },
} as unknown as LLMProvider;

describe("JobSpy", () => {
  it("is used only when JOB_SEARCH_SOURCE=jobspy", () => {
    expect(useJobSpy({ JOB_SEARCH_SOURCE: "jobspy" })).toBe(true);
    expect(useJobSpy({ JOB_SEARCH_SOURCE: "" })).toBe(false);
    expect(useJobSpy({})).toBe(false);
  });

  it("reads defaults and .env settings", () => {
    const o = jobSpyOptionsFromEnv({ JOBSPY_SITES: "indeed, glassdoor", JOBSPY_HOURS_OLD: "24", JOBSPY_LOCATION: "Ohio" });
    expect(o.sites).toEqual(["indeed", "glassdoor"]);
    expect(o.hoursOld).toBe(24);
    expect(o.location).toBe("Ohio");
    expect(jobSpyOptionsFromEnv({}).sites).toEqual(["indeed", "linkedin"]);
  });

  it("takes the company domain from its own website, never from a job board", () => {
    expect(companyDomain("https://www.acme.com/careers")).toBe("acme.com");
    expect(companyDomain("https://www.indeed.com/cmp/Acme")).toBeUndefined();
    expect(companyDomain("https://uk.linkedin.com/company/acme")).toBeUndefined();
    expect(companyDomain(undefined)).toBeUndefined();
  });

  it("maps a row to a job, and drops rows with no title, company or link", () => {
    const h = rowToHit(row())!;
    expect(h).toMatchObject({ job_title: "Java Developer", company_name: "Acme", company_domain: "acme.com", posted_date: "2026-11-02", poster_name: null });
    expect(h.description).toBe("Build services. Use Java 21.");
    expect(rowToHit(row({ company: undefined }))).toBeUndefined();
    expect(rowToHit(row({ is_remote: true }))?.location).toBe("Remote");
  });

  it("keeps Indeed's ?jk= in the link and cleans LinkedIn links", () => {
    expect(normalizeBoardUrl("https://www.indeed.com/viewjob?jk=abc1")).toBe("https://www.indeed.com/viewjob?jk=abc1");
    expect(normalizeBoardUrl("https://www.linkedin.com/jobs/view/42?refId=x")).toBe("https://www.linkedin.com/jobs/view/42");
    expect(normalizeBoardUrl("not a link")).toBeUndefined();
  });

  it("keeps the other boards' jobs when one board is rate-limited", async () => {
    const r = await runJobSpy("java", 20, opts, reply({ jobs: [row()], errors: { linkedin: "429" } }));
    expect(r.hits).toHaveLength(1);
    expect(r.boardErrors).toEqual({ linkedin: "429" });
  });

  it("says how to set up Python or JobSpy when they are missing", async () => {
    const noPython: RunCommand = async () => ({ code: null, stdout: "", stderr: "", spawnError: "spawn python ENOENT" });
    await expect(runJobSpy("java", 20, opts, noPython)).rejects.toThrow(/Install Python 3.10\+/);
    await expect(runJobSpy("java", 20, opts, reply({ error: "JobSpy is not installed. Run: pip install -U python-jobspy" }))).rejects.toBeInstanceOf(JobSpySetupError);
  });

  it("finds jobs with JobSpy instead of Gemini, and Seamless-free runs keep the job without an email", async () => {
    const terms: string[] = [];
    const run: RunCommand = async (_c, args) => {
      terms.push(JSON.parse(args[1]!).search_term);
      return { code: 0, stdout: JSON.stringify({ jobs: terms.length === 1 ? [row(), row({ job_url: "https://www.indeed.com/viewjob?jk=abc2", title: "QA Lead" })] : [], errors: {} }), stderr: "" };
    };
    const out = await searchJobs({ llm: noGemini, now: new Date("2026-11-03T10:00:00Z"), settings: { maxSearches: 2 }, jobspy: { opts, run } });
    expect(terms).toEqual(["software engineer", "data engineer"]);
    expect(out.jobs.map((j) => j.job_title)).toEqual(["Java Developer", "QA Lead"]);
    expect(out.jobs[0]!.email_source).toBe("seamless_off");
  });

  it("records which board each job came from and the posts per board", async () => {
    const run: RunCommand = async (_c, args) => {
      const first = JSON.parse(args[1]!).search_term === "software engineer";
      return { code: 0, stdout: JSON.stringify({ jobs: first ? [row(), row({ site: "linkedin", job_url: "https://www.linkedin.com/jobs/view/77", title: "QA Lead", company: "Other Co" })] : [], errors: {} }), stderr: "" };
    };
    const monster = async () => ({ rows: [{ site: "monster", title: "RPG Dev", company: "Buckeye", job_url: "https://www.monster.com/job-openings/m1", date_posted: "2026-11-03" }] });
    const out = await searchJobs({ llm: noGemini, now: new Date("2026-11-03T10:00:00Z"), settings: { maxSearches: 1 }, jobspy: { opts: { ...opts, sites: ["indeed", "linkedin", "monster"] }, run, readers: { searchMonster: monster } } });
    expect(out.jobs.map((j) => [j.job_title, j.board])).toEqual([["Java Developer", "indeed"], ["QA Lead", "linkedin"], ["RPG Dev", "monster"]]);
    expect(out.posts_by_board).toEqual({ indeed: 1, linkedin: 1, monster: 1 });
    expect(out.posts_on_monster).toBe(1);
  });

  it("treats the Windows Store python shortcut (exit 9009) as Python missing", async () => {
    const store: RunCommand = async () => ({ code: 9009, stdout: "", stderr: "Python was not found; run without arguments to install from the Microsoft Store" });
    await expect(runJobSpy("java", 20, opts, store)).rejects.toBeInstanceOf(JobSpySetupError);
    await expect(searchJobs({ llm: noGemini, jobspy: { opts, run: store } })).rejects.toThrow(/Microsoft Store/);
  });

  it("stops the run at once when Python is missing", async () => {
    const run: RunCommand = async () => ({ code: null, stdout: "", stderr: "", spawnError: "spawn python ENOENT" });
    await expect(searchJobs({ llm: noGemini, jobspy: { opts, run } })).rejects.toThrow(/Python/);
  });

  it("starts each run on a different search term", async () => {
    const first: string[] = [];
    const run: RunCommand = async (_c, args) => { first.push(JSON.parse(args[1]!).search_term); return { code: 0, stdout: '{"jobs":[]}', stderr: "" }; };
    await searchJobs({ llm: noGemini, settings: { maxSearches: 1 }, jobspy: { opts, run }, seen: { urls: new Set(), keys: new Set(), runs: 1, recent: [], noEmailCompanies: new Set() } });
    expect(first).toEqual(["data engineer"]);
  });
});
