import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { logger } from "../../lib/logger.js";
import type { JobHit } from "./job-search.js";
import { searchMonster as defaultSearchMonster, MonsterSetupError } from "./monster.js";
import { searchGoogleJobs as defaultSearchGoogleJobs, GoogleJobsSetupError } from "./google-jobs.js";
import { searchApifyMonster as defaultSearchApifyMonster, ApifyMonsterSetupError, DEFAULT_MONSTER_ACTOR } from "./apify-monster.js";

/**
 * JobSpy (https://github.com/speedyapply/JobSpy) as the job finder: it reads real listings from Indeed, LinkedIn and
 * other boards, with real post dates and links. Gemini is not used to find jobs when JOB_SEARCH_SOURCE=jobspy;
 * Seamless still finds the emails, and the gates, drafts and Sheet work as before.
 *
 * JobSpy is Python, so scripts/jobspy_search.py runs one search and prints JSON.
 * Setup: Python 3.10+ and  pip install -U python-jobspy
 */

export interface JobSpyOptions {
  /** Python command, e.g. "python" or "py" on Windows. */
  python: string;
  script: string;
  sites: string[];
  location: string;
  hoursOld: number;
  countryIndeed: string;
  proxies: string[];
  timeoutMs: number;
}

/** One search term per run step. Each run starts at a different term, the same way the Gemini angles rotate. */
export const JOBSPY_TERMS: Array<{ label: string; term: string }> = [
  { label: "software engineers", term: "software engineer" },
  { label: "data and AI", term: "data engineer" },
  { label: "IBM i and RPG", term: "RPG IBM i developer" },
  { label: "SAP and ERP", term: "SAP business analyst" },
  { label: "finance and accounting", term: "accountant" },
  { label: "healthcare and nursing", term: "registered nurse" },
  { label: "sales", term: "sales manager" },
  { label: "marketing", term: "marketing manager" },
  { label: "operations and HR", term: "operations manager" },
  { label: "engineering and manufacturing", term: "mechanical engineer" },
];

export function jobSpyOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): JobSpyOptions {
  const list = (v: string | undefined, d: string[]) => (v?.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);
  return {
    python: env.JOBSPY_PYTHON?.trim() || (process.platform === "win32" ? "python" : "python3"),
    script: resolve(process.cwd(), "scripts", "jobspy_search.py"),
    sites: list(env.JOBSPY_SITES, ["indeed", "linkedin"]),
    location: env.JOBSPY_LOCATION?.trim() || "United States",
    hoursOld: Number(env.JOBSPY_HOURS_OLD) || 72,
    countryIndeed: env.JOBSPY_COUNTRY_INDEED?.trim() || "USA",
    proxies: list(env.JOBSPY_PROXIES, []),
    timeoutMs: Number(env.JOBSPY_TIMEOUT_MS) || 180_000,
  };
}

/** True when the .env asks for JobSpy instead of Gemini to find jobs. */
export function useJobSpy(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.JOB_SEARCH_SOURCE ?? "").trim().toLowerCase() === "jobspy";
}

export interface RunResult { code: number | null; stdout: string; stderr: string; spawnError?: string }
export type RunCommand = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

const runCommand: RunCommand = (cmd, args, timeoutMs) =>
  new Promise((done) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    const timer = setTimeout(() => { child.kill(); stderr += `\nstopped after ${timeoutMs} ms`; }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => { clearTimeout(timer); done({ code: null, stdout, stderr, spawnError: err.message }); });
    child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });

/** One row as scripts/jobspy_search.py prints it. */
export interface JobSpyRow {
  site?: string;
  title?: string;
  company?: string;
  location?: string;
  date_posted?: string;
  job_url?: string;
  job_url_direct?: string;
  company_url?: string;
  company_url_direct?: string;
  is_remote?: boolean;
  description?: string;
  /** Every board or site the post was seen on (Google Jobs lists them as apply options). */
  boards?: string[];
}

const BOARD = /(^|\.)(linkedin|indeed|glassdoor|ziprecruiter|google|bayt|naukri|bdjobs|hellowork|monster|dice|careerbuilder|simplyhired)\.[a-z.]+$/i;

/** The company's own domain from its website link, never a job board. */
export function companyDomain(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
    return host && !BOARD.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** The first two sentences, for the Details view and the email draft. */
function shortDescription(text?: string): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const two = t.match(/^(.+?[.!?])\s+(.+?[.!?])(\s|$)/);
  return (two ? `${two[1]} ${two[2]}` : t).slice(0, 300);
}

export function rowToHit(r: JobSpyRow): JobHit | undefined {
  if (!r.title?.trim() || !r.company?.trim() || !r.job_url?.trim()) return undefined;
  const domain = companyDomain(r.company_url_direct);
  return {
    job_title: r.title.trim(),
    company_name: r.company.trim(),
    ...(domain ? { company_domain: domain } : {}),
    location: r.is_remote ? "Remote" : (r.location ?? "").trim(),
    posted_date: r.date_posted ? String(r.date_posted).slice(0, 10) : null,
    description: shortDescription(r.description),
    url: r.job_url.trim(),
    ...(r.description ? { about: r.description } : {}),
    poster_name: null,
    poster_title: null,
    ...(r.site ? { board: r.site } : {}),
    ...(r.boards?.length ? { boards: r.boards } : {}),
  };
}

/** A clear message when Python or JobSpy is missing, so the run fails once instead of on every search. */
export class JobSpySetupError extends Error {}

const siteName = (s: string) => s.trim().toLowerCase();
const isMonster = (s: string) => siteName(s) === "monster";
const isGoogleJobs = (s: string) => ["google_jobs", "googlejobs", "serpapi"].includes(siteName(s));
const isApifyMonster = (s: string) => ["monster_apify", "apify_monster", "apify"].includes(siteName(s));

/** The readers that are not JobSpy boards, injectable for tests. */
export interface ExtraReaders {
  searchMonster?: typeof defaultSearchMonster;
  searchGoogleJobs?: typeof defaultSearchGoogleJobs;
  searchApifyMonster?: typeof defaultSearchApifyMonster;
}

/**
 * Runs one search for `term` on every board in `opts.sites`. JobSpy reads its boards through the Python script.
 * Two names are not JobSpy boards and run at the same time through their own readers: "monster" (browser-based,
 * monster.ts) and "google_jobs" (SerpApi, google-jobs.ts; Monster, Dice, CareerBuilder and company sites via
 * Google Jobs). Board errors (LinkedIn 429, a Monster bot check, SerpApi quota) are logged and the other boards'
 * jobs kept; a setup problem (no Python, no Playwright, no SERPAPI_KEY) stops the run with the fix in the message.
 */
export async function runJobSpy(
  term: string, resultsWanted: number, opts: JobSpyOptions, run: RunCommand = runCommand, extra: ExtraReaders | typeof defaultSearchMonster = {},
): Promise<{ hits: JobHit[]; boardErrors: Record<string, string> }> {
  const readers: ExtraReaders = typeof extra === "function" ? { searchMonster: extra } : extra;
  const searchMonster = readers.searchMonster ?? defaultSearchMonster;
  const searchGoogleJobs = readers.searchGoogleJobs ?? defaultSearchGoogleJobs;
  const searchApifyMonster = readers.searchApifyMonster ?? defaultSearchApifyMonster;
  const env = process.env;
  const spySites = opts.sites.filter((s) => !isMonster(s) && !isGoogleJobs(s) && !isApifyMonster(s));
  const monster = opts.sites.some(isMonster)
    ? searchMonster(term, resultsWanted, {
        location: opts.location, hoursOld: opts.hoursOld, timeoutMs: opts.timeoutMs,
        headless: env.MONSTER_HEADLESS?.trim() !== "false", maxPages: Number(env.MONSTER_PAGES) || 3,
        ...(env.MONSTER_PROFILE_DIR?.trim() ? { profileDir: env.MONSTER_PROFILE_DIR.trim() } : {}),
        ...(env.MONSTER_BROWSER?.trim() === "chromium" ? { channel: "chromium" as const } : {}),
      })
    : undefined;
  const gjobs = opts.sites.some(isGoogleJobs)
    ? searchGoogleJobs(term, resultsWanted, {
        apiKey: env.SERPAPI_KEY?.trim() ?? "", location: opts.location, hoursOld: opts.hoursOld,
        timeoutMs: Math.min(opts.timeoutMs, Number(env.GOOGLE_JOBS_TIMEOUT_MS) || 30_000), maxPages: Number(env.GOOGLE_JOBS_PAGES) || 1,
        ...(env.GOOGLE_JOBS_PREFER_LINK?.trim() ? { preferLink: env.GOOGLE_JOBS_PREFER_LINK.trim() } : {}),
      })
    : undefined;
  const apify = opts.sites.some(isApifyMonster)
    ? searchApifyMonster(term, resultsWanted, {
        token: env.APIFY_TOKEN?.trim() ?? "", actor: env.APIFY_MONSTER_ACTOR?.trim() || DEFAULT_MONSTER_ACTOR,
        location: opts.location, hoursOld: opts.hoursOld, timeoutMs: Math.min(opts.timeoutMs, Number(env.APIFY_MONSTER_TIMEOUT_MS) || 180_000),
        ...(Number(env.APIFY_MONSTER_MAX) > 0 ? { maxResults: Number(env.APIFY_MONSTER_MAX) } : {}),
      })
    : undefined;
  const spy = spySites.length ? runJobSpyScript(term, resultsWanted, { ...opts, sites: spySites }, run) : Promise.resolve({ hits: [] as JobHit[], boardErrors: {} as Record<string, string> });
  // Let all finish before raising a setup error, so no browser or Python process is left behind.
  const [spyResult, monsterResult, gjobsResult, apifyResult] = await Promise.allSettled([
    spy, monster ?? Promise.resolve(undefined), gjobs ?? Promise.resolve(undefined), apify ?? Promise.resolve(undefined),
  ]);
  if (spyResult.status === "rejected") throw spyResult.reason;
  const { hits, boardErrors } = spyResult.value;
  const merge = (name: string, r: PromiseSettledResult<{ rows: JobSpyRow[]; error?: string } | undefined>, setup: new (...a: never[]) => Error) => {
    if (r.status === "rejected") {
      if (r.reason instanceof setup) throw r.reason;
      boardErrors[name] = String((r.reason as Error).message ?? r.reason);
      return;
    }
    if (!r.value) return;
    if (r.value.error) { boardErrors[name] = r.value.error; logger.warn({ term, board: name, err: r.value.error }, "board error"); }
    hits.push(...r.value.rows.map(rowToHit).filter((h): h is JobHit => Boolean(h)));
  };
  merge("monster", monsterResult, MonsterSetupError);
  merge("google_jobs", gjobsResult, GoogleJobsSetupError);
  merge("monster_apify", apifyResult, ApifyMonsterSetupError);
  return { hits, boardErrors };
}

async function runJobSpyScript(term: string, resultsWanted: number, opts: JobSpyOptions, run: RunCommand): Promise<{ hits: JobHit[]; boardErrors: Record<string, string> }> {
  const input = {
    search_term: term, sites: opts.sites, location: opts.location, hours_old: opts.hoursOld,
    results_wanted: resultsWanted, country_indeed: opts.countryIndeed, proxies: opts.proxies,
  };
  const res = await run(opts.python, [opts.script, JSON.stringify(input)], opts.timeoutMs);
  // Windows: with no Python installed, "python" is a Microsoft Store shortcut that prints a hint and exits 9009.
  if (!res.spawnError && (res.code === 9009 || /Microsoft Store|was not found; run without arguments/i.test(res.stderr))) {
    throw new JobSpySetupError(`Python is not installed ("${opts.python}" opens the Microsoft Store). Install Python 3.10+ from python.org, then run "pip install -U python-jobspy", or set JOBSPY_PYTHON in .env.`);
  }
  if (res.spawnError) {
    throw new JobSpySetupError(`Could not start Python ("${opts.python}"): ${res.spawnError}. Install Python 3.10+ and run "pip install -U python-jobspy", or set JOBSPY_PYTHON in .env.`);
  }
  let parsed: { jobs?: JobSpyRow[]; errors?: Record<string, string>; error?: string };
  try {
    parsed = JSON.parse(res.stdout.trim().split(/\r?\n/).pop() ?? "{}");
  } catch {
    throw new Error(`JobSpy gave no answer (exit ${res.code}). ${res.stderr.trim().slice(-400)}`);
  }
  if (parsed.error) {
    if (/not installed/i.test(parsed.error)) throw new JobSpySetupError(parsed.error);
    throw new Error(parsed.error);
  }
  const boardErrors = parsed.errors ?? {};
  for (const [site, err] of Object.entries(boardErrors)) logger.warn({ site, term, err }, "jobspy board error");
  const hits = (parsed.jobs ?? []).map(rowToHit).filter((h): h is JobHit => Boolean(h));
  return { hits, boardErrors };
}
