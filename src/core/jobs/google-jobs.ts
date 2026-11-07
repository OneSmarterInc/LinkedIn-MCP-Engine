/**
 * Job posts from Google Jobs through SerpApi (a licensed API; no scraping on our side).
 *
 * Google Jobs collects postings from Monster, Dice, CareerBuilder, LinkedIn, Indeed and company career pages.
 * One SerpApi call returns ten posts with the original links, so this is the dependable way to get Monster
 * posts. Turned on with JOBSPY_SITES=indeed,linkedin,google_jobs and SERPAPI_KEY in .env.
 *
 * Quota: the free plan allows 250 searches a month; each page of ten posts is one search. GOOGLE_JOBS_PAGES
 * (default 1) caps pages per term. When the quota is used up SerpApi answers with an error, which is reported
 * as a board error so the run keeps the other boards' jobs.
 */
import { logger } from "../../lib/logger.js";
import type { JobSpyRow } from "./jobspy.js";
import { dateFromRecency, withinHours } from "./dates.js";

export interface GoogleJobsOptions {
  apiKey: string;
  location: string;
  hoursOld: number;
  timeoutMs: number;
  /** Pages of ten per term; each page costs one SerpApi search. Default 1. */
  maxPages?: number;
  /** Use this board's link when the post is listed there too, e.g. "monster" (GOOGLE_JOBS_PREFER_LINK). */
  preferLink?: string;
  /** Test hook. */
  baseUrl?: string;
}

export class GoogleJobsSetupError extends Error {}

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Google's own date filter, so the quota is not spent on old posts. */
export function dateChip(hoursOld: number): string {
  if (hoursOld <= 24) return "date_posted:today";
  if (hoursOld <= 72) return "date_posted:3days";
  if (hoursOld <= 168) return "date_posted:week";
  return "date_posted:month";
}

/** The SerpApi fields this module reads (the response has many more). */
interface SerpJob {
  title?: string; company_name?: string; location?: string; via?: string; description?: string;
  extensions?: string[]; detected_extensions?: { posted_at?: string };
  apply_options?: Array<{ title?: string; link?: string }>; share_link?: string; source_link?: string;
}
interface SerpResponse {
  error?: string;
  search_metadata?: { status?: string };
  jobs_results?: SerpJob[];
  serpapi_pagination?: { next_page_token?: string };
}

const BOARD_WORDS = /monster|indeed|linkedin|dice|careerbuilder|ziprecruiter|glassdoor|simplyhired/i;

/** Google's click-tracking tail (utm_*) removed, so the Sheet holds the plain link and duplicates match. */
export function cleanLink(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    return u.toString().replace(/\?$/, "");
  } catch {
    return url;
  }
}

/**
 * Rows in JobSpy's shape from one SerpApi page. The link is the original posting: the preferred board when the post
 * is listed there (preferLink), else the source Google names ("via"), else any job board, else the first apply link,
 * else Google's share link. `boards` keeps every site the post appears on.
 */
export function rowsFromSerp(json: SerpResponse, now = new Date(), preferLink?: string): JobSpyRow[] {
  const out: JobSpyRow[] = [];
  const prefer = preferLink?.trim().toLowerCase();
  for (const j of json.jobs_results ?? []) {
    const title = (j.title ?? "").trim();
    const company = (j.company_name ?? "").trim();
    const options = (j.apply_options ?? []).filter((o) => o.link);
    const preferred = prefer ? options.find((o) => (o.title ?? "").toLowerCase().includes(prefer)) : undefined;
    const via = options.find((o) => o.title && j.via && o.title.toLowerCase() === j.via.toLowerCase());
    const board = options.find((o) => BOARD_WORDS.test(o.title ?? ""));
    const url = cleanLink((preferred ?? via ?? board ?? options[0])?.link ?? j.source_link ?? j.share_link ?? "");
    if (!title || !url) continue;
    const recency = j.detected_extensions?.posted_at ?? (j.extensions ?? []).find((e) => /\bago\b|today|yesterday/i.test(e));
    out.push({
      site: `google_jobs${j.via ? `:${j.via}` : ""}`,
      title: title.replace(/\s+jobs?$/i, ""), company: company || "Unknown company",
      location: (j.location ?? "").replace(/\s*\(\+\d+ others?\)\s*$/i, "").trim(),
      date_posted: dateFromRecency(recency, now) ?? "",
      job_url: url,
      description: (j.description ?? "").replace(/\s+/g, " ").trim(),
      boards: [...new Set([j.via, ...options.map((o) => o.title)].filter((b): b is string => Boolean(b)))],
    });
  }
  return out;
}

const QUOTA = /run out of searches|exceeded|quota|rate limit/i;

/** Up to `resultsWanted` posts for `term`, newest first, within `hoursOld`. Never throws for a SerpApi-side problem. */
export async function searchGoogleJobs(
  term: string, resultsWanted: number, opts: GoogleJobsOptions, fetchFn: FetchLike = fetch as unknown as FetchLike, now = new Date(),
): Promise<{ rows: JobSpyRow[]; error?: string; searches: number }> {
  if (!opts.apiKey?.trim()) throw new GoogleJobsSetupError("SERPAPI_KEY is not set in .env (free key at serpapi.com/manage-api-key), so google_jobs cannot run.");
  const base = (opts.baseUrl ?? "https://serpapi.com").replace(/\/$/, "");
  const maxPages = Math.max(1, opts.maxPages ?? 1);
  const rows: JobSpyRow[] = [];
  let token: string | undefined;
  let searches = 0;
  for (let page = 1; page <= maxPages && rows.length < resultsWanted; page++) {
    const q = new URLSearchParams({ engine: "google_jobs", q: term, location: opts.location, hl: "en", gl: "us", chips: dateChip(opts.hoursOld), api_key: opts.apiKey });
    if (token) q.set("next_page_token", token);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
    let json: SerpResponse;
    try {
      searches++;
      const res = await fetchFn(`${base}/search.json?${q.toString()}`, { signal: ctl.signal, headers: { accept: "application/json" } });
      json = (await res.json().catch(() => ({}))) as SerpResponse;
      if (!res.ok || json.error) {
        const msg = json.error ?? `HTTP ${res.status}`;
        if (res.status === 401 || /invalid api key/i.test(msg)) throw new GoogleJobsSetupError(`SerpApi rejected SERPAPI_KEY: ${msg}`);
        return { rows: rows.slice(0, resultsWanted), searches, error: QUOTA.test(msg) ? `SerpApi quota used up for this month (${msg})` : `SerpApi: ${msg}` };
      }
    } catch (err) {
      if (err instanceof GoogleJobsSetupError) throw err;
      const why = (err as Error).name === "AbortError" ? `no answer within ${Math.round(opts.timeoutMs / 1000)} s` : (err as Error).message;
      return { rows: rows.slice(0, resultsWanted), searches, error: `SerpApi: ${why}` };
    } finally {
      clearTimeout(timer);
    }
    const pageRows = rowsFromSerp(json, now, opts.preferLink);
    const fresh = pageRows.filter((r) => withinHours(r.date_posted || undefined, opts.hoursOld, now));
    logger.info({ term, page, posts: pageRows.length, fresh: fresh.length }, "google jobs page");
    rows.push(...fresh);
    token = json.serpapi_pagination?.next_page_token;
    if (!token || pageRows.length === 0) break;
  }
  const seen = new Set<string>();
  return { rows: rows.filter((r) => { const k = r.job_url!; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, resultsWanted), searches };
}
