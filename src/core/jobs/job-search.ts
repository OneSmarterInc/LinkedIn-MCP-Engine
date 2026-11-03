import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import type { LLMProvider } from "../../lib/llm/provider.js";
import { logger } from "../../lib/logger.js";
import { researchAndPoll, pickEmail, seamlessFindRecruiter, type SeamlessOptions } from "../sources/seamless-finder.js";

/** Fixed settings. The search_jobs tool takes no input; change these numbers here. */
export const JOB_SEARCH_DEFAULTS = {
  /** Jobs posted in the last N days (up to today). */
  daysBack: 7,
  /** Jobs wanted per run. Searches stop once this many are found. */
  maxJobs: 10,
  /** Most Gemini searches per run, so a slow day cannot run up the bill. */
  maxSearches: 8,
  /** Most Seamless lookups in one run. Each costs 1 to 2 credits. */
  maxSeamlessLookups: 10,
};

/** One job post as the search returns it. */
export const JobHit = z.object({
  job_title: z.string().min(1),
  company_name: z.string().min(1),
  company_domain: z.string().nullish().describe("Official company website domain, e.g. acme.com"),
  location: z.string().describe("City, State or Remote"),
  posted_date: z.string().nullish().describe("YYYY-MM-DD, or null when the page shows no date"),
  description: z.string().describe("Two or three sentences: what the job is and the main skills"),
  url: z.string().describe("LinkedIn job or post URL"),
  poster_name: z.string().nullish().describe("The person who posted the job, if the page shows one"),
  poster_title: z.string().nullish(),
});
export type JobHit = z.infer<typeof JobHit>;
const JobSearchResult = z.object({ jobs: z.array(JobHit) });

/**
 * Gemini's search does not read LinkedIn pages: it fills in emails and dates that look right.
 * So emails come only from Seamless, and every date is marked unconfirmed.
 */
export type JobEmailSource =
  | "seamless_poster"     // Seamless found the poster's work email
  | "seamless_recruiter"  // Seamless found a recruiter or HR person at the company
  | "not_found"           // Seamless was asked and had nothing
  | "lookup_limit"        // the run's Seamless limit was reached
  | "seamless_off";       // SEAMLESS_API_KEY is empty

export interface JobView {
  job_title: string;
  company: string;
  company_domain?: string;
  location: string;
  /** From Gemini's search. Can be wrong; open the link to confirm. */
  posted_date_unconfirmed: string | null;
  description: string;
  url: string;
  email: string | null;
  email_source: JobEmailSource;
  /** Who the email belongs to, when Seamless found it. */
  contact_name?: string;
  contact_title?: string;
}

export interface JobSearchOutput {
  searched_at: string;
  /** Gemini searches used. */
  searches: number;
  window: { from: string; to: string };
  total: number;
  with_email: number;
  seamless_lookups_used: number;
  jobs: JobView[];
  skipped: Array<{ url: string; reason: string }>;
}

/** True when the poster "name" is just the company (e.g. "Medoja" for "Medoja Bio Private Limited"). */
export function samePlace(poster: string, company: string): boolean {
  const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const p = n(poster);
  const c = n(company);
  return !!p && (p === c || c.startsWith(p) || p.startsWith(c));
}
const JOB_URL = /^https?:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/(jobs\/view|posts|feed\/update)\//i;

const SYSTEM = [
  "You find real, recent job posts on LinkedIn using Google Search.",
  "Only return posts whose LinkedIn URL you actually found in search results. Never invent URLs, companies, or emails.",
  "If you find fewer posts than asked, return fewer.",
].join(" ");

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function jobWindow(now: Date, daysBack: number): { from: string; to: string } {
  const from = new Date(now.getTime() - daysBack * 86_400_000);
  return { from: ymd(from), to: ymd(now) };
}

/**
 * Search angles, tried in order until a run has enough jobs. Gemini's search returns only a few posts per call,
 * so different angles find different posts. The last one looks for "send your CV" posts.
 */
export const JOB_SEARCH_ANGLES = [
  "software, data and AI jobs",
  "jobs in the United States",
  "jobs in India",
  "healthcare and pharma jobs",
  "finance, banking and accounting jobs",
  "sales, marketing and customer jobs",
  "jobs in Europe and the UK",
  "operations, HR and manufacturing jobs",
];

/** One prompt per angle: LinkedIn job pages, plus "we're hiring" posts for the first angle. */
export function buildJobPrompts(window: { from: string; to: string }, limit: number): string[] {
  const common = [
    `Today is ${window.to}. Only include posts from ${window.from} to ${window.to}.`,
    `LinkedIn shows age as "3 days ago" or "1 week ago": convert it to a YYYY-MM-DD posted_date using today's date. If you cannot tell the date, use null.`,
    "For each give job_title, company_name, company_domain (the company's own website, not linkedin.com), location,",
    "posted_date, a two-sentence description, url (the LinkedIn link you found),",
    "poster_name and poster_title (only if the page shows who posted it).",
  ];
  const pages = JOB_SEARCH_ANGLES.map((angle) => [
    `Use Google Search to find up to ${limit} ${angle} published on LinkedIn job pages in the last week.`,
    `Try searches like: site:linkedin.com/jobs/view ${angle}, linkedin.com/jobs/view "days ago" ${angle}.`,
    "The url must start with https://www.linkedin.com/jobs/view/ (or a country subdomain like in.linkedin.com).",
    ...common,
  ].join("\n"));
  const posts = [
    `Use Google Search to find up to ${limit} LinkedIn posts from the last week where someone announces a job opening and asks people to send a CV or resume.`,
    `Try searches like: site:linkedin.com/posts "we are hiring" "send your CV", site:linkedin.com/posts "hiring" "share your resume at".`,
    "The url must start with https://www.linkedin.com/posts/ or https://www.linkedin.com/feed/update/.",
    "Any role, any company, any country.",
    ...common,
  ].join("\n");
  // Hiring posts second: they often name the poster, which makes the Seamless lookup cheaper.
  return [pages[0]!, posts, ...pages.slice(1)];
}

/** Normalized LinkedIn job/post URL without query string, or undefined when it is not one. */
export function normalizeJobUrl(raw: string): string | undefined {
  const url = raw.trim().split(/[?#]/)[0]!.replace(/\/+$/, "");
  return JOB_URL.test(`${url}/`) ? url.replace(/^http:/i, "https:") : undefined;
}

/** True when the date is missing or inside the window. A date outside the window drops the job. */
export function inWindow(date: string | null | undefined, window: { from: string; to: string }): boolean {
  if (!date) return true;
  const d = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true;
  return d >= window.from && d <= window.to;
}

/** A live status update while a search runs. */
export interface JobSearchProgress {
  stage: "searching" | "finding_email" | "done";
  /** One plain sentence, e.g. "Search 3 of 8 (jobs in India): found 2 new jobs". */
  message: string;
  searches_done: number;
  searches_max: number;
  jobs_found: number;
  with_email: number;
  lookups_used: number;
  /** Jobs so far, with emails filled in as they are found. */
  jobs: JobView[];
}

export interface JobSearchDeps {
  llm: LLMProvider;
  /** Leave out to skip Seamless (emails come only from the posts). */
  seamless?: { apiKey: string; fetchFn?: typeof fetch; poll?: SeamlessOptions };
  now?: Date;
  settings?: Partial<typeof JOB_SEARCH_DEFAULTS>;
  /** Called at every step, so a caller can save live status. */
  onProgress?: (p: JobSearchProgress) => void;
}

export async function searchJobs(deps: JobSearchDeps): Promise<JobSearchOutput> {
  const settings = { ...JOB_SEARCH_DEFAULTS, ...deps.settings };
  const now = deps.now ?? new Date();
  const window = jobWindow(now, settings.daysBack);

  type Candidate = { view: JobView; poster?: string; posterTitle?: string };
  const candidates: Candidate[] = [];
  const skipped: JobSearchOutput["skipped"] = [];
  const seen = new Set<string>();

  const keep = (h: JobHit) => {
    const url = normalizeJobUrl(h.url);
    if (!url) { skipped.push({ url: h.url, reason: "NOT_A_LINKEDIN_JOB_URL" }); return; }
    if (seen.has(url)) { skipped.push({ url, reason: "DUPLICATE" }); return; }
    seen.add(url);
    if (!inWindow(h.posted_date, window)) { skipped.push({ url, reason: "OUTSIDE_DATE_WINDOW" }); return; }
    const domain = h.company_domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") || undefined;
    candidates.push({
      view: {
        job_title: h.job_title.trim(),
        company: h.company_name.trim(),
        ...(domain && !domain.includes("linkedin.com") ? { company_domain: domain } : {}),
        location: h.location.trim(),
        posted_date_unconfirmed: h.posted_date?.slice(0, 10) || null,
        description: h.description.trim(),
        url,
        email: null,
        email_source: "seamless_off",
      },
      ...(h.poster_name?.trim() ? { poster: h.poster_name.trim() } : {}),
      ...(h.poster_title?.trim() ? { posterTitle: h.poster_title.trim() } : {}),
    });
  };

  const jobs: JobView[] = [];
  let searches = 0;
  let lookups = 0;
  const prompts = buildJobPrompts(window, settings.maxJobs);
  const labels = ["software, data and AI jobs", "hiring posts asking for a CV", ...JOB_SEARCH_ANGLES.slice(1)];
  const searchesMax = Math.min(settings.maxSearches, prompts.length);
  const report = (stage: JobSearchProgress["stage"], message: string) => {
    logger.info({ stage, searches, jobs: jobs.length, lookups }, message);
    deps.onProgress?.({
      stage, message, searches_done: searches, searches_max: searchesMax, jobs_found: jobs.length,
      with_email: jobs.filter((j) => j.email).length, lookups_used: lookups, jobs: jobs.map((j) => ({ ...j })),
    });
  };

  /** Finds a contact email for one job. Fills the view in place. */
  const findEmail = async ({ view, poster, posterTitle }: Candidate) => {
    if (!deps.seamless) { view.email_source = "seamless_off"; return; }
    if (lookups >= settings.maxSeamlessLookups) { view.email_source = "lookup_limit"; return; }
    lookups += 1;
    const s = deps.seamless;
    report("finding_email", `Finding an email for ${view.job_title} at ${view.company} (lookup ${lookups} of ${settings.maxSeamlessLookups})`);
    // A post by the company page names the company, not a person: go straight to the recruiter search.
    if (poster && !samePlace(poster, view.company)) {
      const body = { contacts: [{ contactName: poster, ...(view.company_domain ? { domain: view.company_domain } : { companyName: view.company }) }] };
      const email = pickEmail(await researchAndPoll(body, s.apiKey, s.fetchFn, s.poll, { job: view.url }));
      if (email) {
        view.email = email;
        view.email_source = "seamless_poster";
        view.contact_name = poster;
        if (posterTitle) view.contact_title = posterTitle;
      }
    }
    if (!view.email) {
      const r = await seamlessFindRecruiter({ name: view.company, domain: view.company_domain }, s.apiKey, s.fetchFn, s.poll);
      if (r) {
        view.email = r.email;
        view.email_source = "seamless_recruiter";
        if (r.name) view.contact_name = r.name;
        if (r.title) view.contact_title = r.title;
      }
    }
    if (!view.email) view.email_source = "not_found";
  };

  // Search angle by angle. After each search, find emails for its new jobs, so results show up as they come.
  report("searching", `Starting: up to ${settings.maxJobs} jobs posted ${window.from} to ${window.to}`);
  for (const prompt of prompts) {
    if (jobs.length >= settings.maxJobs || searches >= searchesMax) break;
    searches += 1;
    const label = labels[searches - 1] ?? "jobs";
    report("searching", `Search ${searches} of ${searchesMax} (${label})...`);
    const before = candidates.length;
    try {
      const r = await deps.llm.generateJSON(prompt, JobSearchResult, { grounded: true, system: SYSTEM });
      for (const h of r.jobs) {
        if (candidates.length - before + jobs.length >= settings.maxJobs) break;
        keep(h);
      }
    } catch (err) {
      // One failed search should not lose the other searches' jobs.
      logger.warn({ search: searches, err: (err as Error).message }, "job search query failed");
      report("searching", `Search ${searches} of ${searchesMax} (${label}) failed: ${(err as Error).message}`);
    }
    const fresh = candidates.slice(before);
    report("searching", `Search ${searches} of ${searchesMax} (${label}): found ${fresh.length} new job${fresh.length === 1 ? "" : "s"}, ${jobs.length + fresh.length} in total`);
    for (const c of fresh) {
      jobs.push(c.view);
      await findEmail(c);
      report("finding_email", c.view.email
        ? `Email found for ${c.view.company} (${c.view.email_source})`
        : `No email for ${c.view.company} (${c.view.email_source})`);
    }
  }
  report("done", `Done: ${jobs.length} jobs, ${jobs.filter((j) => j.email).length} with email, ${searches} searches, ${lookups} Seamless lookups`);

  logger.info({ searches, kept: jobs.length, lookups }, "job search done");
  return {
    searched_at: now.toISOString(),
    searches,
    window,
    total: jobs.length,
    with_email: jobs.filter((j) => j.email).length,
    seamless_lookups_used: lookups,
    jobs,
    skipped,
  };
}

/** Saves a job search to out/job-searches/jobs-<time>.json and returns the path. */
export async function saveJobSearch(out: JobSearchOutput, dir = resolve(process.cwd(), "out", "job-searches")): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `jobs-${out.searched_at.replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify(out, null, 2), "utf8");
  return path;
}

// ---------------------------------------------------------------------------
// Background runs. A search with Seamless lookups takes 2-6 minutes, longer than a chat client waits.
// search_jobs starts one and returns a search_id at once; get_job_search shows progress and the result.
// ---------------------------------------------------------------------------

export type JobSearchStatus = "RUNNING" | "DONE" | "FAILED";

export interface JobSearchRecord {
  search_id: string;
  status: JobSearchStatus;
  started_at: string;
  updated_at: string;
  error?: string;
  /** Live status while RUNNING. */
  progress?: Omit<JobSearchProgress, "jobs">;
  /** Jobs found so far, while RUNNING. */
  jobs_so_far?: JobView[];
  /** Every status line with its time, oldest first (last 50). */
  log: string[];
  result?: JobSearchOutput;
}

const JOBS_DIR = resolve(process.cwd(), "out", "job-searches");
const ID = /^jobs-[0-9a-f-]{36}$/i;

export function createJobSearchId(): string {
  return `jobs-${randomUUID()}`;
}

function recordPath(id: string, dir: string): string {
  if (!ID.test(id)) throw new Error("Invalid job search ID.");
  return resolve(dir, `${id}.json`);
}

export async function saveJobSearchRecord(rec: JobSearchRecord, dir = JOBS_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = recordPath(rec.search_id, dir);
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(rec, null, 2), "utf8");
  await rename(tmp, target);
}

export async function loadJobSearchRecord(id: string, dir = JOBS_DIR): Promise<JobSearchRecord> {
  try {
    return JSON.parse(await readFile(recordPath(id, dir), "utf8")) as JobSearchRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Job search ${id} not found. Call search_jobs first.`);
    throw err;
  }
}

/** The newest job search, or undefined when there is none. */
export async function latestJobSearchId(dir = JOBS_DIR): Promise<string | undefined> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => ID.test(f.replace(/\.json$/, "")) && f.endsWith(".json"));
  } catch {
    return undefined;
  }
  let best: { id: string; at: string } | undefined;
  for (const f of files) {
    try {
      const rec = JSON.parse(await readFile(resolve(dir, f), "utf8")) as JobSearchRecord;
      if (!best || rec.started_at > best.at) best = { id: rec.search_id, at: rec.started_at };
    } catch { /* skip unreadable */ }
  }
  return best?.id;
}

/**
 * Saves a RUNNING record, then runs the search, saving every progress update, and finally DONE or FAILED.
 * Writes are queued one after another, so a late progress write can never overwrite DONE.
 * Returns the RUNNING record and the work promise (the server does not wait for it).
 */
export async function startJobSearch(
  run: (onProgress: (p: JobSearchProgress) => void) => Promise<JobSearchOutput>,
  dir = JOBS_DIR,
  now: () => Date = () => new Date(),
): Promise<{ record: JobSearchRecord; done: Promise<void> }> {
  const started = now().toISOString();
  let current: JobSearchRecord = {
    search_id: createJobSearchId(), status: "RUNNING", started_at: started, updated_at: started, log: [],
  };
  await saveJobSearchRecord(current, dir);
  const first = current;

  let queue: Promise<void> = Promise.resolve();
  const write = (next: JobSearchRecord) => {
    current = next;
    queue = queue.then(() => saveJobSearchRecord(next, dir)).catch(() => { /* keep going; next write retries */ });
    return queue;
  };
  const line = (msg: string) => [...current.log, `${now().toISOString().slice(11, 19)} ${msg}`].slice(-50);

  const onProgress = (p: JobSearchProgress) => {
    const { jobs, ...progress } = p;
    void write({ ...current, progress, jobs_so_far: jobs, log: line(p.message), updated_at: now().toISOString() });
  };

  const done = (async () => {
    try {
      const result = await run(onProgress);
      const { progress: _p, jobs_so_far: _j, ...rest } = current;
      await write({ ...rest, status: "DONE", result, updated_at: now().toISOString() });
    } catch (err) {
      const msg = (err as Error).message;
      await write({ ...current, status: "FAILED", error: msg, log: line(`Failed: ${msg}`), updated_at: now().toISOString() });
    }
  })();
  return { record: first, done };
}
