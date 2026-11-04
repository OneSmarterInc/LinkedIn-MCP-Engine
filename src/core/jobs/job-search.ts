import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import type { LLMProvider } from "../../lib/llm/provider.js";
import { logger } from "../../lib/logger.js";
import { researchAndPoll, pickEmail, seamlessFindRecruiter, type SeamlessOptions } from "../sources/seamless-finder.js";
import type { JobOutreachResult } from "./job-outreach.js";
import { staffingCheck, type StaffingCheck } from "./staffing.js";
import { cleanPersonName } from "../names.js";
import { JOBSPY_TERMS, JobSpySetupError, runJobSpy, type JobSpyOptions, type RunCommand } from "./jobspy.js";

/** Fixed settings. The search_jobs tool takes no input; change these numbers here. */
export const JOB_SEARCH_DEFAULTS = {
  /** Jobs posted in the last N days (up to today). */
  daysBack: 7,
  /** Stop once this many jobs are kept. */
  maxJobs: 10,
  /** Most Google searches (angles) in one run. Searching stops early once maxJobs is reached. */
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
  /** Longer post text, used only to spot staffing firms (JobSpy fills it). */
  about: z.string().nullish(),
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
  /** Google searches actually run. */
  searches: number;
  /** What happened after the search: gates, drafts, and the Jobs_Pipeline / Jobs_Quarantine rows. */
  outreach?: JobOutreachResult;
  /** Set when the search worked but the outreach step failed. export_job_search retries it. */
  outreach_error?: string;
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

/** One search angle: where to look (job pages or posts) and what kind of roles. Searched in this order. */
export interface JobSearchAngle {
  label: string;
  kind: "pages" | "posts";
  hint: string;
}

/**
 * Nine angles, searched in order until maxJobs is reached or maxSearches is used up.
 * Job pages first, split by field so one search does not drown out the others; then "we're hiring" posts,
 * where a person's name (and often a CV email) is visible.
 */
export const JOB_SEARCH_ANGLES: JobSearchAngle[] = [
  { label: "software, data and AI jobs", kind: "pages", hint: "software engineer, developer, data engineer, data scientist, AI or ML engineer, cloud, DevOps" },
  { label: "hiring posts asking for a CV", kind: "posts", hint: '"we are hiring" with "send your CV", "share your resume", or "email your resume"' },
  { label: "IT, ERP and IBM i jobs", kind: "pages", hint: "RPG, IBM i, AS/400, SAP, Oracle, ERP, systems administrator, IT manager, network engineer" },
  { label: "finance and accounting jobs", kind: "pages", hint: "accountant, controller, financial analyst, CFO, payroll, bookkeeper, audit" },
  { label: "healthcare and nursing jobs", kind: "pages", hint: "registered nurse, physician, medical assistant, healthcare IT, clinical, pharmacist" },
  { label: "sales and marketing jobs", kind: "pages", hint: "sales manager, account executive, business development, marketing manager, SDR" },
  { label: "operations, HR and admin jobs", kind: "pages", hint: "operations manager, HR manager, recruiter, office manager, customer service, supply chain" },
  { label: "engineering and manufacturing jobs", kind: "pages", hint: "mechanical engineer, electrical engineer, plant manager, quality engineer, maintenance technician" },
  { label: "hiring posts from managers and founders", kind: "posts", hint: '"my team is hiring", "join our team", "we\'re growing", posted by a manager or founder (not a job board)' },
];

/**
 * One prompt per angle. Natural-language instructions work better with Gemini's search than raw Google
 * operators like after:, so the date window is spelled out instead.
 */
export function buildJobPrompts(window: { from: string; to: string }, limit: number, angles: JobSearchAngle[] = JOB_SEARCH_ANGLES, avoid: string[] = []): string[] {
  const common = [
    `Today is ${window.to}. Only include posts from ${window.from} to ${window.to}.`,
    `LinkedIn shows age as "3 days ago" or "1 week ago": convert it to a YYYY-MM-DD posted_date using today's date. If you cannot tell the date, use null.`,
    "Any company, any country, but only companies hiring for their own team: leave out staffing agencies, recruiting firms, and IT consulting or outsourcing companies.",
    "For each give job_title, company_name, company_domain (the company's own website, not linkedin.com), location,",
    "posted_date, a two-sentence description, url (the LinkedIn link you found),",
    "poster_name and poster_title (only if the page shows who posted it).",
    ...(avoid.length ? [`Earlier searches already found these jobs. Leave them out and find different ones: ${avoid.join("; ")}.`] : []),
  ];
  return angles.map((a) =>
    a.kind === "pages"
      ? [
          `Use Google Search to find up to ${limit} job openings published on LinkedIn job pages in the last week, in this area: ${a.hint}.`,
          'Try searches like: site:linkedin.com/jobs/view hiring, linkedin.com/jobs/view "days ago", linkedin jobs posted this week, each combined with words from that area.',
          "The url must start with https://www.linkedin.com/jobs/view/ (or a country subdomain like in.linkedin.com).",
          ...common,
        ].join("\n")
      : [
          `Use Google Search to find up to ${limit} LinkedIn posts from the last week where someone announces a job opening: ${a.hint}.`,
          `Try searches like: site:linkedin.com/posts "we are hiring" "send your CV", site:linkedin.com/posts "hiring" "share your resume at", site:linkedin.com/posts "email your resume".`,
          "The url must start with https://www.linkedin.com/posts/ or https://www.linkedin.com/feed/update/.",
          ...common,
        ].join("\n"),
  );
}

/** Normalized LinkedIn job/post URL without query string, or undefined when it is not one. */
export function normalizeJobUrl(raw: string): string | undefined {
  const url = raw.trim().split(/[?#]/)[0]!.replace(/\/+$/, "");
  return JOB_URL.test(`${url}/`) ? url.replace(/^http:/i, "https:") : undefined;
}

/** A job link from any board JobSpy reads. LinkedIn links are cleaned; others keep their query (Indeed's ?jk= is the job). */
export function normalizeBoardUrl(raw: string): string | undefined {
  const linkedin = normalizeJobUrl(raw);
  if (linkedin) return linkedin;
  const url = raw.trim();
  return /^https?:\/\/[^\s]+$/i.test(url) ? url.replace(/^http:/i, "https:") : undefined;
}

/** True when the date is missing or inside the window. A date outside the window drops the job. */
export function inWindow(date: string | null | undefined, window: { from: string; to: string }): boolean {
  if (!date) return true;
  const d = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true;
  return d >= window.from && d <= window.to;
}

/** A live step report. Sent at start, before and after each search, after each email found, and at the end. */
export interface JobSearchProgress {
  stage: "starting" | "searching" | "emails" | "syncing" | "verifying" | "drafting" | "exporting" | "done";
  message: string;
  searches_done: number;
  searches_max: number;
  jobs_found: number;
  with_email: number;
  lookups_used: number;
  /** The jobs kept so far, emails filled in as they are found. */
  jobs: JobView[];
}

/** Jobs that earlier searches already found. A new search skips them, so each run brings new roles. */
export interface SeenJobs {
  urls: Set<string>;
  /** company|title, normalized: the same role can come back under a second URL. */
  keys: Set<string>;
  /** How many earlier searches there are. Used to start each run on a different search angle. */
  runs: number;
  /** "Company: Title" for the most recent finds, named in the prompt so Gemini looks past them. */
  recent: string[];
}

const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** The same role at the same company, however the title is punctuated. */
export function jobKey(company: string, title: string): string {
  return `${squash(company)}|${squash(title)}`;
}

export function emptySeenJobs(): SeenJobs {
  return { urls: new Set(), keys: new Set(), runs: 0, recent: [] };
}

/**
 * The jobs from one saved search that later searches should skip. A job is skipped when this search dealt with it:
 * drafted, or held back for a lasting reason. A search that failed or stopped before the gates, a job whose email
 * was never looked up, and a job held back only because a check crashed can all be found again.
 */
export function jobsToRemember(r: Partial<JobSearchRecord> & Partial<JobSearchOutput>): JobView[] {
  const out = r.result ?? (r.jobs ? (r as JobSearchOutput) : undefined);
  if (!out?.outreach) return [];
  const o = out.outreach;
  // Older records have no retry list. If every contact crashed a check, treat them all as retryable.
  const allCrashed = !o.retry_urls && o.contacts > 0 && (o.quarantined_by_reason?.GATE_ERROR ?? 0) === o.contacts;
  const retry = new Set(o.retry_urls ?? []);
  return out.jobs.filter((j) => !allCrashed && !retry.has(j.url) && j.email_source !== "lookup_limit");
}

/** Reads every saved search in out/job-searches (finished, failed or stopped) and collects the jobs they found. */
export async function loadSeenJobs(dir = resolve(process.cwd(), "out", "job-searches"), recentMax = 40): Promise<SeenJobs> {
  const seen = emptySeenJobs();
  let files: string[];
  try { files = (await readdir(dir)).filter((f) => f.startsWith("jobs-") && f.endsWith(".json")); } catch { return seen; }
  const found: Array<{ at: string; jobs: JobView[] }> = [];
  for (const f of files) {
    try {
      const r = JSON.parse(await readFile(resolve(dir, f), "utf8")) as Partial<JobSearchRecord> & Partial<JobSearchOutput>;
      found.push({ at: r.started_at ?? r.searched_at ?? "", jobs: jobsToRemember(r) });
    } catch { /* skip unreadable */ }
  }
  seen.runs = found.length;
  found.sort((a, b) => b.at.localeCompare(a.at));
  for (const { jobs } of found) {
    for (const j of jobs) {
      if (j.url) seen.urls.add(j.url);
      seen.keys.add(jobKey(j.company, j.job_title));
      if (seen.recent.length < recentMax) seen.recent.push(`${j.company}: ${j.job_title}`);
    }
  }
  return seen;
}

export interface JobSearchDeps {
  llm: LLMProvider;
  /** Leave out to skip Seamless (emails come only from the posts). */
  seamless?: { apiKey: string; fetchFn?: typeof fetch; poll?: SeamlessOptions };
  now?: Date;
  settings?: Partial<typeof JOB_SEARCH_DEFAULTS>;
  onProgress?: (p: JobSearchProgress) => void;
  /** Jobs from earlier searches. They are skipped before any Seamless lookup, so they cost no credits. */
  seen?: SeenJobs;
  /** Set to find jobs with JobSpy (real listings from Indeed, LinkedIn, ...) instead of Gemini's Google Search. */
  jobspy?: { opts: JobSpyOptions; run?: RunCommand };
  /** Spots staffing and consulting firms (competitors). Defaults to the built-in list plus SKIP_COMPANIES. */
  skip?: StaffingCheck;
}

/** Gemini's answer when the project has no credit left or is over its spending cap. */
export const GEMINI_OUT_OF_CREDIT = /quota exhausted|spending cap|exceeded your current quota/i;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function searchJobs(deps: JobSearchDeps): Promise<JobSearchOutput> {
  const settings = { ...JOB_SEARCH_DEFAULTS, ...deps.settings };
  const now = deps.now ?? new Date();
  const window = jobWindow(now, settings.daysBack);
  const before = deps.seen ?? emptySeenJobs();
  // Each run starts on a different angle, so the same first searches do not fill every run with the same jobs.
  const offset = before.runs % JOB_SEARCH_ANGLES.length;
  const angles = [...JOB_SEARCH_ANGLES.slice(offset), ...JOB_SEARCH_ANGLES.slice(0, offset)];
  const prompts = buildJobPrompts(window, settings.maxJobs, angles, before.recent);
  const spy = deps.jobspy;
  const termOffset = before.runs % JOBSPY_TERMS.length;
  const terms = [...JOBSPY_TERMS.slice(termOffset), ...JOBSPY_TERMS.slice(0, termOffset)];
  const searchesMax = Math.min(settings.maxSearches, spy ? terms.length : prompts.length);
  let seenBefore = 0;
  const skip = deps.skip ?? staffingCheck();
  let firmsSkipped = 0;

  const jobs: JobView[] = [];
  const skipped: JobSearchOutput["skipped"] = [];
  const seen = new Set<string>();
  let lookups = 0;
  let searches = 0;

  const report = (stage: JobSearchProgress["stage"], message: string) => {
    deps.onProgress?.({
      stage, message,
      searches_done: searches, searches_max: searchesMax,
      jobs_found: jobs.length, with_email: jobs.filter((j) => j.email).length, lookups_used: lookups,
      jobs: jobs.map((j) => ({ ...j })),
    });
  };

  // One Seamless answer per company (and per named poster) for the whole run. The same employer often has several
  // openings in one search; the second and third reuse the first answer and cost no credits.
  type Found = { email: string; name?: string; title?: string } | undefined;
  const companyKey = (v: JobView) => (v.company_domain ?? v.company.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const recruiterCache = new Map<string, Found>();
  const posterCache = new Map<string, Found>();

  const findEmail = async (view: JobView, h: JobHit, url: string): Promise<void> => {
    if (!deps.seamless) { view.email_source = "seamless_off"; return; }
    const s = deps.seamless;
    const ck = companyKey(view);
    const poster = h.poster_name?.trim();
    // A post by the company page names the company, not a person: go straight to the recruiter search.
    const realPoster = poster && !samePlace(poster, view.company) ? poster : undefined;
    const pk = realPoster ? `${realPoster.toLowerCase()}|${ck}` : undefined;

    const apply = (found: Found, source: JobEmailSource, fallbackName?: string, fallbackTitle?: string) => {
      if (!found) return;
      view.email = found.email;
      view.email_source = source;
      const name = found.name ?? fallbackName;
      const title = found.title ?? fallbackTitle;
      if (name) view.contact_name = cleanPersonName(name, found.email);
      if (title) view.contact_title = title;
    };

    if (pk && posterCache.has(pk)) {
      apply(posterCache.get(pk), "seamless_poster", realPoster, h.poster_title?.trim());
    } else if (pk && lookups < settings.maxSeamlessLookups) {
      lookups += 1;
      report("emails", `Finding an email for ${view.job_title} at ${view.company}: asking Seamless for ${realPoster} (lookup ${lookups} of ${settings.maxSeamlessLookups})`);
      const body = { contacts: [{ contactName: realPoster!, ...(view.company_domain ? { domain: view.company_domain } : { companyName: view.company }) }] };
      const email = pickEmail(await researchAndPoll(body, s.apiKey, s.fetchFn, s.poll, { job: url }));
      const found: Found = email ? { email } : undefined;
      posterCache.set(pk, found);
      apply(found, "seamless_poster", realPoster, h.poster_title?.trim());
    }

    if (!view.email && recruiterCache.has(ck)) {
      apply(recruiterCache.get(ck), "seamless_recruiter");
    } else if (!view.email && lookups < settings.maxSeamlessLookups) {
      lookups += 1;
      report("emails", `Finding an email for ${view.job_title} at ${view.company}: looking for a recruiter or HR person (lookup ${lookups} of ${settings.maxSeamlessLookups})`);
      const r = await seamlessFindRecruiter({ name: view.company, domain: view.company_domain }, s.apiKey, s.fetchFn, s.poll);
      const found: Found = r ? { email: r.email, ...(r.name ? { name: r.name } : {}), ...(r.title ? { title: r.title } : {}) } : undefined;
      recruiterCache.set(ck, found);
      apply(found, "seamless_recruiter");
    }

    if (!view.email) {
      const askedEverything = (pk ? posterCache.has(pk) : true) && recruiterCache.has(ck);
      view.email_source = askedEverything ? "not_found" : "lookup_limit";
    }
  };

  report("starting", `Starting: up to ${settings.maxJobs} jobs from ${window.from} to ${window.to}, up to ${searchesMax} searches` +
    (spy ? ` with JobSpy (${spy.opts.sites.join(", ")}, ${spy.opts.location}, last ${spy.opts.hoursOld} hours)` : "") +
    (deps.seamless ? `, up to ${settings.maxSeamlessLookups} Seamless lookups` : ", Seamless off") +
    (before.keys.size ? `, skipping ${plural(before.keys.size, "job")} found by earlier searches` : ""));

  for (let n = 0; n < searchesMax && jobs.length < settings.maxJobs; n++) {
    const angle = angles[n] ?? { label: `angle ${n + 1}`, kind: "pages" as const, hint: "" };
    const tag = spy ? `Search ${n + 1} of ${searchesMax} (${terms[n]!.label} on ${spy.opts.sites.join(", ")})` : `Search ${n + 1} of ${searchesMax} (${angle.label})`;
    report("searching", `${tag}...`);
    searches += 1;

    let hits: JobHit[] = [];
    try {
      if (spy) {
        // Ask for extra rows: jobs found by earlier runs are skipped below.
        const r = await runJobSpy(terms[n]!.term, settings.maxJobs * 3, spy.opts, spy.run);
        hits = r.hits;
        const blocked = Object.keys(r.boardErrors);
        if (blocked.length) report("searching", `${tag}: ${blocked.join(", ")} did not answer (often a rate limit); kept the other boards' jobs`);
      } else {
        hits = (await deps.llm.generateJSON(prompts[n]!, JobSearchResult, { grounded: true, system: SYSTEM })).jobs;
      }
    } catch (err) {
      if (err instanceof JobSpySetupError) throw err;
      const msg = (err as Error).message;
      // Out of credits or over the spending cap: every later call fails too, so stop now and say why.
      if (GEMINI_OUT_OF_CREDIT.test(msg)) {
        throw new Error("Gemini stopped answering: the Gemini project is out of credits or over its monthly spending cap. " +
          "Add credits or raise the cap at https://ai.studio/spend, then start the search again.");
      }
      // One failed search should not lose the others' jobs.
      logger.warn({ search: n + 1, err: msg }, "job search query failed");
    }

    let added = 0;
    let old = 0;
    let firms = 0;
    for (const h of hits) {
      if (jobs.length >= settings.maxJobs) break;
      const url = spy ? normalizeBoardUrl(h.url) : normalizeJobUrl(h.url);
      if (!url) { skipped.push({ url: h.url, reason: "NOT_A_LINKEDIN_JOB_URL" }); continue; }
      if (seen.has(url)) { skipped.push({ url, reason: "DUPLICATE" }); continue; }
      seen.add(url);
      if (before.urls.has(url) || before.keys.has(jobKey(h.company_name, h.job_title))) {
        skipped.push({ url, reason: "FOUND_BY_EARLIER_SEARCH" }); old += 1; seenBefore += 1; continue;
      }
      if (!inWindow(h.posted_date, window)) { skipped.push({ url, reason: "OUTSIDE_DATE_WINDOW" }); continue; }

      const domain = h.company_domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") || undefined;
      const firm = skip.reason({ name: h.company_name, ...(domain ? { domain } : {}), text: `${h.job_title} ${h.about ?? h.description}` });
      if (firm) {
        skipped.push({ url, reason: "STAFFING_OR_CONSULTING_FIRM" }); firms += 1; firmsSkipped += 1;
        report("searching", `Skipped ${h.company_name.trim()}: ${firm}`);
        continue;
      }
      const view: JobView = {
        job_title: h.job_title.trim(),
        company: h.company_name.trim(),
        ...(domain && !domain.includes("linkedin.com") ? { company_domain: domain } : {}),
        location: h.location.trim(),
        posted_date_unconfirmed: h.posted_date?.slice(0, 10) || null,
        description: h.description.trim(),
        url,
        email: null,
        email_source: "seamless_off",
      };
      await findEmail(view, h, url);
      if (skip.contact(view.contact_title)) {
        skipped.push({ url, reason: "STAFFING_OR_CONSULTING_FIRM" }); firms += 1; firmsSkipped += 1;
        report("emails", `Skipped ${view.company}: its contact is a ${view.contact_title}, which only staffing firms have`);
        continue;
      }
      jobs.push(view);
      added += 1;
      report("emails", view.email
        ? `Email found for ${view.company}: ${view.email} (${view.email_source})`
        : `No email for ${view.company} (${view.email_source})`);
    }
    report("searching", `${tag}: found ${plural(added, "new job")}, ${jobs.length} in total` +
      (old || firms ? ` (skipped: ${[old ? `${old} found before` : "", firms ? `${plural(firms, "staffing or consulting firm")}` : ""].filter(Boolean).join(", ")})` : ""));
  }

  logger.info({ searches, kept: jobs.length, lookups, seen_before: seenBefore, firms_skipped: firmsSkipped }, "job search");
  const withEmail = jobs.filter((j) => j.email).length;
  report("done", `Done: ${plural(jobs.length, "job")}, ${withEmail} with email, ${plural(searches, "search").replace("searchs", "searches")}, ${plural(lookups, "Seamless lookup")}`);
  return {
    searched_at: now.toISOString(),
    searches,
    window,
    total: jobs.length,
    with_email: withEmail,
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
  result?: JobSearchOutput;
  /** Latest step while RUNNING (counts only; the jobs are in jobs_so_far). Removed when DONE. */
  progress?: Omit<JobSearchProgress, "jobs">;
  /** Jobs kept so far while RUNNING, emails filled in as they are found. */
  jobs_so_far?: JobView[];
  /** Every progress message, oldest first. Kept after DONE. */
  log: string[];
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
  const text = JSON.stringify(rec, null, 2);
  await writeFile(tmp, text, "utf8");
  // On Windows the rename fails (EPERM/EBUSY) while another program has the file open, for example the API
  // reading it for the Runs page. Try a few times, then write the file directly so the record never gets stuck.
  for (let attempt = 1; ; attempt++) {
    try { await rename(tmp, target); return; } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!["EPERM", "EBUSY", "EACCES"].includes(code)) throw err;
      if (attempt < 5) { await new Promise((r) => setTimeout(r, 40 * attempt)); continue; }
      await writeFile(target, text, "utf8");
      await unlink(tmp).catch(() => {});
      return;
    }
  }
}

export async function loadJobSearchRecord(id: string, dir = JOBS_DIR): Promise<JobSearchRecord> {
  try {
    const rec = JSON.parse(await readFile(recordPath(id, dir), "utf8")) as JobSearchRecord;
    return { ...rec, log: rec.log ?? [] };
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
 * Saves a RUNNING record, then runs the search and saves DONE or FAILED.
 * `run` gets an onProgress callback; each report is written to the record (progress, jobs_so_far, log) so a
 * client polling get_job_search sees the search move. Writes are serialized, and once the run has finished no
 * late progress report can overwrite the DONE or FAILED record.
 * Returns the RUNNING record and the work promise (the server does not wait for it).
 */
export async function startJobSearch(
  run: (onProgress: (p: JobSearchProgress) => void, searchId: string) => Promise<JobSearchOutput>,
  dir = JOBS_DIR,
  now: () => Date = () => new Date(),
): Promise<{ record: JobSearchRecord; done: Promise<void> }> {
  const started = now().toISOString();
  let record: JobSearchRecord = { search_id: createJobSearchId(), status: "RUNNING", started_at: started, updated_at: started, log: [] };
  await saveJobSearchRecord(record, dir);

  let finished = false;
  let chain: Promise<void> = Promise.resolve();
  /** All writes go through one queue, in order. */
  const write = (next: () => JobSearchRecord | undefined) => {
    chain = chain.then(async () => {
      const r = next();
      if (!r) return;
      record = r;
      await saveJobSearchRecord(record, dir);
    }).catch((err) => { logger.warn({ err: (err as Error).message }, "job search record write failed"); });
    return chain;
  };

  const onProgress = (p: JobSearchProgress) => {
    void write(() => {
      if (finished) return undefined;
      const { jobs, ...counts } = p;
      return { ...record, progress: counts, jobs_so_far: jobs, log: [...record.log, p.message], updated_at: now().toISOString() };
    });
  };

  const done = (async () => {
    try {
      const result = await run(onProgress, record.search_id);
      finished = true;
      await write(() => {
        const { progress: _p, jobs_so_far: _j, ...rest } = record;
        return { ...rest, status: "DONE", result, updated_at: now().toISOString() };
      });
    } catch (err) {
      finished = true;
      await write(() => {
        const { progress: _p, ...rest } = record;
        return { ...rest, status: "FAILED", error: (err as Error).message, updated_at: now().toISOString() };
      });
    }
  })();

  return { record, done };
}
