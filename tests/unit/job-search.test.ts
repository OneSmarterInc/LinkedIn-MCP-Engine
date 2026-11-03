import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildJobPrompts, inWindow, samePlace, jobWindow, normalizeJobUrl, saveJobSearch, searchJobs, type JobHit,
  latestJobSearchId, loadJobSearchRecord, startJobSearch, type JobSearchProgress,
} from "../../src/core/jobs/job-search.js";
import { firstSearchResultId, seamlessFindRecruiter } from "../../src/core/sources/seamless-finder.js";
import type { LLMProvider } from "../../src/lib/llm/provider.js";

/** Fake Gemini: the first search returns `answer`, the second returns no jobs. Records prompts. */
function fakeLLM(answer: { jobs: unknown[] }, _grounding = true) {
  const prompts: string[] = [];
  const llm = {
    name: "fake", supportsGrounding: true,
    async generateJSON(prompt: string, schema: { parse(x: unknown): unknown }) {
      prompts.push(prompt);
      return schema.parse(prompts.length === 1 ? answer : { jobs: [] });
    },
    async generateText() { return ""; },
  } as unknown as LLMProvider;
  return { llm, prompts };
}

// All companies, people and emails here are made up.

const NOW = new Date("2026-11-03T10:00:00Z");
const fast = { pollMs: 0, maxWaitMs: 2_000 };

function job(o: Partial<JobHit> = {}): JobHit {
  return {
    job_title: "RPG Developer", company_name: "Acme", company_domain: "acme.com", location: "Dayton, OH",
    posted_date: "2026-11-01", description: "Maintain IBM i programs.", url: "https://www.linkedin.com/jobs/view/111",
    poster_name: null, poster_title: null, ...o,
  };
}

/**
 * Fake Seamless. Poster lookups (contactName) find `posterEmail`; recruiter searches find `recruiterEmail`.
 * Records which endpoints were called.
 */
function fakeSeamless(opts: { posterEmail?: string; recruiterEmail?: string; searchHasRow?: boolean } = {}) {
  const calls: string[] = [];
  let lastKind: "poster" | "recruiter" = "poster";
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.endsWith("/search/contacts")) {
      calls.push("search");
      return reply(opts.searchHasRow === false ? { data: [] } : { data: [{ searchResultId: "sr-1" }], supplementalData: {} });
    }
    if (u.endsWith("/contacts/research")) {
      const body = JSON.parse(String(init?.body));
      lastKind = body.searchResultIds ? "recruiter" : "poster";
      calls.push(`research:${lastKind}`);
      return reply({ success: true, requestIds: ["req-1"] }, 202);
    }
    if (u.includes("/contacts/research/poll")) {
      const email = lastKind === "poster" ? opts.posterEmail : opts.recruiterEmail;
      const contact = lastKind === "recruiter" ? { email, firstName: "Rita", lastName: "Recruit", title: "Talent Acquisition" } : { email };
      return reply({ success: true, data: [{ requestId: "req-1", status: email ? "done" : "not found", contact: email ? contact : null }] });
    }
    return reply({}, 404);
  });
  return { fetchFn: fn as unknown as typeof fetch, calls };
}

describe("job search helpers", () => {
  it("window is the last 7 days up to today", () => {
    expect(jobWindow(NOW, 7)).toEqual({ from: "2026-10-27", to: "2026-11-03" });
  });
  it("builds 9 prompts: job pages per angle, with hiring posts second, all bounded by the window", () => {
    const all = buildJobPrompts({ from: "2026-10-27", to: "2026-11-03" }, 10);
    expect(all).toHaveLength(9);
    const [pages, posts] = all;
    expect(pages).toContain("site:linkedin.com/jobs/view");
    expect(posts).toContain("site:linkedin.com/posts");
    for (const p of [pages!, posts!]) {
      expect(p).toContain("Today is 2026-11-03");
      expect(p).toContain("from 2026-10-27 to 2026-11-03");
      expect(p).not.toContain("after:");
    }
  });
  it("keeps searching other angles while it has fewer than 10 jobs, up to the search limit", async () => {
    const { llm, prompts } = fakeLLM({ jobs: [job()] }); // only the first search finds anything
    const out = await searchJobs({ llm, now: NOW });
    expect(prompts).toHaveLength(8);
    expect(out.searches).toBe(8);
    expect(out.total).toBe(1);
  });
  it("stops searching once it has 10 jobs", async () => {
    const many = (start: number) => ({ jobs: Array.from({ length: 6 }, (_, i) => job({ url: `https://www.linkedin.com/jobs/view/${start + i}` })) });
    const answers = [many(100), many(200), many(300)];
    let i = 0;
    const llm = {
      name: "fake", supportsGrounding: true,
      async generateJSON(_p: string, schema: { parse(x: unknown): unknown }) { return schema.parse(answers[i++] ?? { jobs: [] }); },
      async generateText() { return ""; },
    } as unknown as LLMProvider;
    const out = await searchJobs({ llm, now: NOW });
    expect(i).toBe(2);
    expect(out.total).toBe(10);
  });
  it("keeps the jobs from one search when the other search fails", async () => {
    let call = 0;
    const llm = {
      name: "fake", supportsGrounding: true,
      async generateJSON(_p: string, schema: { parse(x: unknown): unknown }) {
        call += 1;
        if (call === 1) throw new Error("boom");
        return schema.parse({ jobs: [job()] });
      },
      async generateText() { return ""; },
    } as unknown as Parameters<typeof searchJobs>[0]["llm"];
    const out = await searchJobs({ llm, now: NOW });
    expect(out.total).toBe(1);
  });
  it.each([
    ["https://www.linkedin.com/jobs/view/123?trk=x", "https://www.linkedin.com/jobs/view/123"],
    ["https://in.linkedin.com/jobs/view/rpg-dev-123/", "https://in.linkedin.com/jobs/view/rpg-dev-123"],
    ["https://www.linkedin.com/posts/jane_hiring-activity-1", "https://www.linkedin.com/posts/jane_hiring-activity-1"],
    ["https://www.linkedin.com/in/jane", undefined],
    ["https://www.indeed.com/viewjob?jk=1", undefined],
  ])("normalizeJobUrl(%s)", (raw, want) => expect(normalizeJobUrl(raw)).toBe(want));
  it("keeps missing dates, drops dates outside the window", () => {
    const w = { from: "2026-10-27", to: "2026-11-03" };
    expect(inWindow(null, w)).toBe(true);
    expect(inWindow("2026-10-30", w)).toBe(true);
    expect(inWindow("2026-10-01", w)).toBe(false);
    expect(inWindow("2026-12-01", w)).toBe(false);
  });
});

describe("searchJobs", () => {
  it("ignores any email Gemini gives and asks Seamless instead", async () => {
    const madeUp = { ...job(), email: "guessed.name@acme.com" };
    const { llm } = fakeLLM({ jobs: [madeUp] });
    const s = fakeSeamless({ recruiterEmail: "rita@acme.com" });
    const out = await searchJobs({ llm, now: NOW, seamless: { apiKey: "k", fetchFn: s.fetchFn, poll: fast } });
    expect(out.jobs[0]).toMatchObject({ email: "rita@acme.com", email_source: "seamless_recruiter" });
    expect(JSON.stringify(out)).not.toContain("guessed.name");
  });

  it("marks the posted date as unconfirmed", async () => {
    const { llm } = fakeLLM({ jobs: [job({ posted_date: "2026-11-01" })] });
    const out = await searchJobs({ llm, now: NOW });
    expect(out.jobs[0]!.posted_date_unconfirmed).toBe("2026-11-01");
    expect(out.jobs[0]).not.toHaveProperty("posted_date");
  });

  it("skips the poster lookup when the poster is the company page", async () => {
    const { llm } = fakeLLM({ jobs: [job({ company_name: "Medoja Bio Private Limited", poster_name: "Medoja" })] });
    const s = fakeSeamless({ recruiterEmail: "rita@acme.com" });
    await searchJobs({ llm, now: NOW, seamless: { apiKey: "k", fetchFn: s.fetchFn, poll: fast } });
    expect(s.calls).toEqual(["search", "research:recruiter"]);
  });

  it("asks Seamless for the poster when the post names one", async () => {
    const { llm } = fakeLLM({ jobs: [job({ poster_name: "Jane Miller", poster_title: "HR Lead" })] }, true);
    const s = fakeSeamless({ posterEmail: "jane.miller@acme.com" });
    const out = await searchJobs({ llm, now: NOW, seamless: { apiKey: "k", fetchFn: s.fetchFn, poll: fast } });
    expect(out.jobs[0]).toMatchObject({
      email: "jane.miller@acme.com", email_source: "seamless_poster", contact_name: "Jane Miller", contact_title: "HR Lead",
    });
    expect(s.calls).toEqual(["research:poster"]);
  });

  it("falls back to a recruiter at the company when there is no poster", async () => {
    const { llm } = fakeLLM({ jobs: [job()] }, true);
    const s = fakeSeamless({ recruiterEmail: "rita@acme.com" });
    const out = await searchJobs({ llm, now: NOW, seamless: { apiKey: "k", fetchFn: s.fetchFn, poll: fast } });
    expect(out.jobs[0]).toMatchObject({
      email: "rita@acme.com", email_source: "seamless_recruiter", contact_name: "Rita Recruit", contact_title: "Talent Acquisition",
    });
    expect(s.calls).toEqual(["search", "research:recruiter"]);
  });

  it("tries the recruiter when the poster has no email", async () => {
    const { llm } = fakeLLM({ jobs: [job({ poster_name: "Jane Miller" })] }, true);
    const s = fakeSeamless({ recruiterEmail: "rita@acme.com" });
    const out = await searchJobs({ llm, now: NOW, seamless: { apiKey: "k", fetchFn: s.fetchFn, poll: fast } });
    expect(out.jobs[0]!.email_source).toBe("seamless_recruiter");
    expect(s.calls).toEqual(["research:poster", "search", "research:recruiter"]);
  });

  it("lists the job with not_found when Seamless has nothing", async () => {
    const { llm } = fakeLLM({ jobs: [job()] }, true);
    const s = fakeSeamless({ searchHasRow: false });
    const out = await searchJobs({ llm, now: NOW, seamless: { apiKey: "k", fetchFn: s.fetchFn, poll: fast } });
    expect(out.jobs[0]).toMatchObject({ email: null, email_source: "not_found" });
    expect(out.total).toBe(1);
    expect(out.with_email).toBe(0);
  });

  it("looks a company up once and reuses the answer for its other openings (no extra credits)", async () => {
    const jobs = [1, 2, 3].map((i) => job({ url: `https://www.linkedin.com/jobs/view/${i}`, company_name: "Boston Scientific", company_domain: "bostonscientific.com" }));
    const { llm } = fakeLLM({ jobs }, true);
    const s = fakeSeamless({ recruiterEmail: "rita@bostonscientific.com" });
    const out = await searchJobs({ llm, now: NOW, settings: { maxSeamlessLookups: 10 }, seamless: { apiKey: "k", fetchFn: s.fetchFn, poll: fast } });
    expect(out.jobs.map((j) => j.email)).toEqual(["rita@bostonscientific.com", "rita@bostonscientific.com", "rita@bostonscientific.com"]);
    expect(out.jobs.every((j) => j.email_source === "seamless_recruiter" && j.contact_name === "Rita Recruit")).toBe(true);
    expect(out.seamless_lookups_used).toBe(1);
    expect(s.calls).toEqual(["search", "research:recruiter"]);
  });

  it("remembers a company with no email too, so it is not asked again", async () => {
    const jobs = [1, 2].map((i) => job({ url: `https://www.linkedin.com/jobs/view/${i}` }));
    const { llm } = fakeLLM({ jobs }, true);
    const s = fakeSeamless({ searchHasRow: false });
    const out = await searchJobs({ llm, now: NOW, seamless: { apiKey: "k", fetchFn: s.fetchFn, poll: fast } });
    expect(out.jobs.map((j) => j.email_source)).toEqual(["not_found", "not_found"]);
    expect(out.seamless_lookups_used).toBe(1);
  });

  it("stops Seamless lookups at the limit", async () => {
    const jobs = [1, 2, 3].map((i) => job({ url: `https://www.linkedin.com/jobs/view/${i}`, company_name: `Company ${i}`, company_domain: `company${i}.com` }));
    const { llm } = fakeLLM({ jobs }, true);
    const s = fakeSeamless({ recruiterEmail: "rita@acme.com" });
    const out = await searchJobs({
      llm, now: NOW, settings: { maxSeamlessLookups: 2 }, seamless: { apiKey: "k", fetchFn: s.fetchFn, poll: fast },
    });
    expect(out.jobs.map((j) => j.email_source)).toEqual(["seamless_recruiter", "seamless_recruiter", "lookup_limit"]);
    expect(out.seamless_lookups_used).toBe(2);
  });

  it("marks seamless_off when there is no Seamless key", async () => {
    const { llm } = fakeLLM({ jobs: [job()] }, true);
    const out = await searchJobs({ llm, now: NOW });
    expect(out.jobs[0]).toMatchObject({ email: null, email_source: "seamless_off" });
  });

  it("drops non-LinkedIn links, duplicates, and posts outside the date window", async () => {
    const { llm } = fakeLLM({
      jobs: [
        job(),
        job({ url: "https://www.linkedin.com/jobs/view/111?trk=abc" }),
        job({ url: "https://www.indeed.com/viewjob?jk=9" }),
        job({ url: "https://www.linkedin.com/jobs/view/222", posted_date: "2026-09-01" }),
        job({ url: "https://www.linkedin.com/jobs/view/333", posted_date: null }),
      ],
    }, true);
    const out = await searchJobs({ llm, now: NOW });
    expect(out.jobs.map((j) => j.url)).toEqual(["https://www.linkedin.com/jobs/view/111", "https://www.linkedin.com/jobs/view/333"]);
    expect(out.skipped.map((s) => s.reason)).toEqual(["DUPLICATE", "NOT_A_LINKEDIN_JOB_URL", "OUTSIDE_DATE_WINDOW"]);
  });

  it("never uses linkedin.com as the company domain", async () => {
    const { llm } = fakeLLM({ jobs: [job({ company_domain: "https://www.linkedin.com/company/acme" })] }, true);
    const out = await searchJobs({ llm, now: NOW });
    expect(out.jobs[0]!.company_domain).toBeUndefined();
  });

  it("saves the result to a file", async () => {
    const { llm } = fakeLLM({ jobs: [job()] }, true);
    const out = await searchJobs({ llm, now: NOW });
    const dir = await mkdtemp(join(tmpdir(), "jobs-"));
    const path = await saveJobSearch(out, dir);
    expect(JSON.parse(await readFile(path, "utf8")).jobs[0].company).toBe("Acme");
  });
});

describe("Seamless recruiter search", () => {
  it("reads searchResultId from the documented reply", () => {
    expect(firstSearchResultId({ data: [{ searchResultId: "abc" }], supplementalData: { isMore: false } })).toBe("abc");
    expect(firstSearchResultId({ data: [] })).toBeUndefined();
    expect(firstSearchResultId(null)).toBeUndefined();
  });
  it("searches by company domain with recruiter titles and limit 1", async () => {
    const s = fakeSeamless({ recruiterEmail: "rita@acme.com" });
    await seamlessFindRecruiter({ name: "Acme", domain: "acme.com" }, "k", s.fetchFn, fast);
    const body = JSON.parse(String((s.fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body));
    expect(body).toMatchObject({ companyDomain: ["acme.com"], limit: 1 });
    expect(body.jobTitle).toContain("Recruiter");
  });
  it("returns undefined on a failed search, and does not throw", async () => {
    const fn = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    expect(await seamlessFindRecruiter({ name: "Acme" }, "k", fn, fast)).toBeUndefined();
  });
});

describe("samePlace", () => {
  it.each([
    ["Medoja", "Medoja Bio Private Limited", true],
    ["Acme Inc", "Acme", true],
    ["Jane Miller", "Acme", false],
  ])("%s vs %s -> %s", (poster, company, want) => expect(samePlace(poster, company)).toBe(want));
});

describe("live progress", () => {
  it("reports each step in order: start, each search, each email, done", async () => {
    const { llm } = fakeLLM({ jobs: [job(), job({ url: "https://www.linkedin.com/jobs/view/222" })] });
    const s = fakeSeamless({ recruiterEmail: "rita@acme.com" });
    const steps: JobSearchProgress[] = [];
    await searchJobs({
      llm, now: NOW, settings: { maxSearches: 2 }, onProgress: (p) => steps.push(p),
      seamless: { apiKey: "k", fetchFn: s.fetchFn, poll: fast },
    });
    const msgs = steps.map((p) => p.message);
    expect(msgs[0]).toMatch(/^Starting: up to 10 jobs/);
    expect(msgs).toContain("Search 1 of 2 (software, data and AI jobs)...");
    expect(msgs).toContain("Search 1 of 2 (software, data and AI jobs): found 2 new jobs, 2 in total");
    expect(msgs.filter((m) => m.startsWith("Email found for Acme"))).toHaveLength(2);
    expect(msgs).toContain("Search 2 of 2 (hiring posts asking for a CV): found 0 new jobs, 2 in total");
    // Both jobs are at Acme: the company is looked up once and the answer reused, so one Seamless lookup.
    expect(msgs.at(-1)).toBe("Done: 2 jobs, 2 with email, 2 searches, 1 Seamless lookup");
    // emails show up in the job list as soon as they are found
    const afterFirstEmail = steps.find((p) => p.message.startsWith("Email found"))!;
    expect(afterFirstEmail.with_email).toBe(1);
    expect(afterFirstEmail.jobs_found).toBe(1);
  });
});

describe("background job search", () => {
  const out = (n: number) => ({
    searched_at: "2026-11-03T10:00:00.000Z", searches: 1, window: { from: "2026-10-27", to: "2026-11-03" },
    total: n, with_email: 0, seamless_lookups_used: 0, jobs: [], skipped: [],
  });

  it("saves RUNNING at once, then DONE with the result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobs-bg-"));
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    let report!: (p: JobSearchProgress) => void;
    const { record, done } = await startJobSearch(async (onProgress) => { report = onProgress; await gate; return out(3); }, dir);
    expect(record.status).toBe("RUNNING");
    expect((await loadJobSearchRecord(record.search_id, dir)).status).toBe("RUNNING");

    // A progress update while running is saved: current step, jobs so far, and a log line.
    await new Promise((r) => setTimeout(r, 0));
    report({
      stage: "searching", message: "Search 1 of 8 (software, data and AI jobs): found 1 new job, 1 in total",
      searches_done: 1, searches_max: 8, jobs_found: 1, with_email: 0, lookups_used: 0,
      jobs: [{ job_title: "RPG Developer", company: "Acme", location: "Dayton, OH", posted_date_unconfirmed: null,
        description: "x", url: "https://www.linkedin.com/jobs/view/1", email: null, email_source: "seamless_off" }],
    });
    await new Promise((r) => setTimeout(r, 50));
    const mid = await loadJobSearchRecord(record.search_id, dir);
    expect(mid.status).toBe("RUNNING");
    expect(mid.progress?.jobs_found).toBe(1);
    expect(mid.jobs_so_far).toHaveLength(1);
    expect(mid.log.at(-1)).toMatch(/found 1 new job/);

    finish();
    await done;
    const rec = await loadJobSearchRecord(record.search_id, dir);
    expect(rec.status).toBe("DONE");
    expect(rec.result?.total).toBe(3);
    expect(rec.progress).toBeUndefined();
    expect(rec.log.length).toBeGreaterThan(0);
  });

  it("a late progress write never overwrites DONE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobs-bg-"));
    const { record, done } = await startJobSearch(async (onProgress) => {
      for (let i = 0; i < 20; i++) {
        onProgress({ stage: "searching", message: `step ${i}`, searches_done: i, searches_max: 20, jobs_found: 0, with_email: 0, lookups_used: 0, jobs: [] });
      }
      return out(0);
    }, dir);
    await done;
    expect((await loadJobSearchRecord(record.search_id, dir)).status).toBe("DONE");
  });

  it("saves FAILED with the error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobs-bg-"));
    const { record, done } = await startJobSearch(async () => { throw new Error("Gemini quota"); }, dir);
    await done;
    expect(await loadJobSearchRecord(record.search_id, dir)).toMatchObject({ status: "FAILED", error: "Gemini quota" });
  });

  it("finds the newest search, and none in an empty folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobs-bg-"));
    expect(await latestJobSearchId(dir)).toBeUndefined();
    const times = [new Date("2026-11-01T00:00:00Z"), new Date("2026-11-02T00:00:00Z")];
    const a = await startJobSearch(async () => out(1), dir, () => times[0]!);
    const b = await startJobSearch(async () => out(2), dir, () => times[1]!);
    await Promise.all([a.done, b.done]);
    expect(await latestJobSearchId(dir)).toBe(b.record.search_id);
  });

  it("rejects a bad search id and says when one is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobs-bg-"));
    await expect(loadJobSearchRecord("../secrets", dir)).rejects.toThrow(/Invalid/);
    await expect(loadJobSearchRecord("jobs-00000000-0000-0000-0000-000000000000", dir)).rejects.toThrow(/not found/);
  });
});

describe("live steps while finding emails", () => {
  it("says which lookup is running before Seamless answers, and the result after", async () => {
    const { llm } = fakeLLM({ jobs: [job({ poster_name: "Jane Miller" })] });
    const s = fakeSeamless({ posterEmail: "jane.miller@acme.com" });
    const msgs: string[] = [];
    await searchJobs({ llm, now: NOW, settings: { maxSearches: 1 }, onProgress: (p) => msgs.push(p.message), seamless: { apiKey: "k", fetchFn: s.fetchFn, poll: fast } });
    const asking = msgs.findIndex((m) => m.startsWith("Finding an email for RPG Developer at Acme: asking Seamless for Jane Miller (lookup 1 of"));
    const found = msgs.findIndex((m) => m.startsWith("Email found for Acme"));
    expect(asking).toBeGreaterThan(-1);
    expect(found).toBeGreaterThan(asking);
  });
  it("reports a job with no email too", async () => {
    const { llm } = fakeLLM({ jobs: [job()] });
    const s = fakeSeamless({ searchHasRow: false });
    const msgs: string[] = [];
    await searchJobs({ llm, now: NOW, settings: { maxSearches: 1 }, onProgress: (p) => msgs.push(p.message), seamless: { apiKey: "k", fetchFn: s.fetchFn, poll: fast } });
    expect(msgs).toContain("No email for Acme (not_found)");
  });
});
