/**
 * Monster.com job posts through an Apify actor (Apify runs the scraper on its servers; nothing runs in a browser here).
 *
 * Turned on with JOBSPY_SITES=indeed,linkedin,monster_apify and APIFY_TOKEN in .env. The actor is chosen with
 * APIFY_MONSTER_ACTOR (default blackfalcondata~monster-scraper: it returns the company website, which the Seamless
 * lookup needs). Other Monster actors also work: the reader accepts the common field names (title, company, url,
 * postedDate or posted_date, companyWebsite, description).
 *
 * Cost: paid by the actor's own price on your Apify account (for the default actor about $0.005 a run plus $0.001 a
 * post). APIFY_MONSTER_MAX caps posts per search term (default: the run's own number, at most 50).
 */
import { logger } from "../../lib/logger.js";
import type { JobSpyRow } from "./jobspy.js";
import { dateFromRecency, withinHours } from "./dates.js";

export interface ApifyMonsterOptions {
  token: string;
  /** Apify actor, "user~name" or "user/name". */
  actor: string;
  location: string;
  hoursOld: number;
  timeoutMs: number;
  maxResults?: number;
  /** Test hook. */
  baseUrl?: string;
}

export const DEFAULT_MONSTER_ACTOR = "blackfalcondata~monster-scraper";

export class ApifyMonsterSetupError extends Error {}

export type ApifyFetch = (url: string, init: { method: string; signal: AbortSignal; headers: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** One dataset item. Field names differ between actors, so each has its usual alternatives. */
type Item = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const first = (o: Item, ...keys: string[]): string => {
  for (const k of keys) { const s = str(o[k]); if (s) return s; }
  return "";
};

/** A post date as YYYY-MM-DD from an ISO date, a plain date, or "2 days ago". */
export function postDate(raw: string, now = new Date()): string {
  if (!raw) return "";
  const t = Date.parse(raw);
  if (!Number.isNaN(t) && /\d{4}-\d{2}-\d{2}/.test(raw)) return new Date(t).toISOString().slice(0, 10);
  return dateFromRecency(raw, now) ?? "";
}

/** Rows in JobSpy's shape from the actor's dataset items. Items with no title, company or link are dropped. */
export function rowsFromApify(items: unknown, now = new Date()): JobSpyRow[] {
  if (!Array.isArray(items)) return [];
  const out: JobSpyRow[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Item;
    const companyObj = (o.company && typeof o.company === "object" ? o.company : {}) as Item;
    const title = first(o, "title", "jobTitle", "job_title", "name");
    const company = first(o, "companyName", "company_name") || (typeof o.company === "string" ? str(o.company) : first(companyObj, "name"));
    const url = first(o, "url", "jobUrl", "job_url", "link", "applyUrl", "apply_url");
    if (!title || !company || !url) continue;
    const website = first(o, "companyWebsite", "company_website", "companyDomain", "website") || first(companyObj, "website", "url");
    const remote = o.isRemote === true || o.is_remote === true;
    out.push({
      site: "monster",
      title, company,
      location: remote ? "Remote" : first(o, "location", "jobLocation", "formattedLocation") || [first(o, "city"), first(o, "state")].filter(Boolean).join(", "),
      date_posted: postDate(first(o, "postedDate", "posted_date", "datePosted", "date_posted", "publishedAt", "postedAt"), now),
      job_url: url,
      ...(website ? { company_url_direct: website } : {}),
      ...(remote ? { is_remote: true } : {}),
      description: first(o, "description", "descriptionText", "snippet").replace(/\s+/g, " "),
      boards: ["Monster"],
    });
  }
  return out;
}

/** Up to `resultsWanted` Monster posts for `term` within `hoursOld`. Never throws for an Apify-side problem. */
export async function searchApifyMonster(
  term: string, resultsWanted: number, opts: ApifyMonsterOptions, fetchFn: ApifyFetch = fetch as unknown as ApifyFetch, now = new Date(),
): Promise<{ rows: JobSpyRow[]; error?: string }> {
  if (!opts.token?.trim()) throw new ApifyMonsterSetupError("APIFY_TOKEN is not set in .env (Apify console > Settings > API & Integrations), so monster_apify cannot run.");
  const actor = (opts.actor?.trim() || DEFAULT_MONSTER_ACTOR).replace("/", "~");
  const base = (opts.baseUrl ?? "https://api.apify.com").replace(/\/$/, "");
  const max = Math.max(1, Math.min(opts.maxResults ?? resultsWanted, 50));
  // "United States" means the whole country, which these actors take as an empty location.
  const location = /^(united states|usa|us)$/i.test(opts.location.trim()) ? "" : opts.location.trim();
  // Both input styles, so either common actor understands it; an actor ignores fields it does not know.
  const input = { query: term, queries: [term], location, country: "US", maxResults: max };
  const timeoutSec = Math.max(30, Math.min(Math.round(opts.timeoutMs / 1000), 600));
  const headers = { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${opts.token.trim()}` };
  const deadline = Date.now() + (timeoutSec + 30) * 1000;

  // Short requests only: start the run, then ask for its state every few seconds, then read the posts. One long open
  // request (run-sync) is cut by some home and office networks after about 10 seconds ("fetch failed").
  const call = async (url: string, method = "GET", body?: string): Promise<{ status: number; ok: boolean; json: unknown; text: string }> => {
    for (let attempt = 1; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30_000);
      try {
        const res = await fetchFn(url, { method, signal: ctl.signal, headers, ...(body ? { body } : {}) });
        const text = await res.text();
        let json: unknown; try { json = JSON.parse(text); } catch { json = undefined; }
        return { status: res.status, ok: res.ok, json, text };
      } catch (err) {
        // A dropped connection is tried again once; starting a run is not repeated, so no second run is paid for.
        if (attempt >= 2 || method === "POST") throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  };

  try {
    const runRes = await call(`${base}/v2/acts/${encodeURIComponent(actor).replace("%7E", "~")}/runs?timeout=${timeoutSec}`, "POST", JSON.stringify(input));
    if (runRes.status === 401 || runRes.status === 403) throw new ApifyMonsterSetupError(`Apify rejected APIFY_TOKEN (HTTP ${runRes.status}).`);
    if (runRes.status === 404) throw new ApifyMonsterSetupError(`Apify actor "${actor}" was not found. Check APIFY_MONSTER_ACTOR in .env.`);
    if (!runRes.ok) {
      return { rows: [], error: `Apify Monster: HTTP ${runRes.status}${/credit|limit|usage/i.test(runRes.text) ? " (Apify usage limit or credit used up)" : ""}` };
    }
    type Run = { id?: string; status?: string; defaultDatasetId?: string; statusMessage?: string };
    let run = (runRes.json as { data?: Run } | undefined)?.data ?? {};
    if (!run.id) return { rows: [], error: "Apify Monster: the run did not start (no run id)" };
    while (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status ?? "")) {
      if (Date.now() > deadline) return { rows: [], error: `Apify Monster: no result within ${timeoutSec + 30} s` };
      const poll = await call(`${base}/v2/actor-runs/${run.id}?waitForFinish=5`);
      run = (poll.json as { data?: Run } | undefined)?.data ?? run;
    }
    if (run.status !== "SUCCEEDED") return { rows: [], error: `Apify Monster: the run ${run.status?.toLowerCase()}${run.statusMessage ? ` (${run.statusMessage})` : ""}` };
    const items = await call(`${base}/v2/datasets/${run.defaultDatasetId}/items?clean=true&format=json&fields=${ITEM_FIELDS}`);
    if (!items.ok) return { rows: [], error: `Apify Monster: reading the posts failed (HTTP ${items.status})` };
    const all = rowsFromApify(items.json, now);
    const fresh = all.filter((r) => withinHours(r.date_posted || undefined, opts.hoursOld, now));
    logger.info({ term, actor, posts: all.length, fresh: fresh.length }, "apify monster");
    const seen = new Set<string>();
    return { rows: fresh.filter((r) => (seen.has(r.job_url!) ? false : (seen.add(r.job_url!), true))).slice(0, resultsWanted) };
  } catch (err) {
    if (err instanceof ApifyMonsterSetupError) throw err;
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const why = e.name === "AbortError" ? "no answer within 30 s" : `${e.message}${e.cause?.code ? ` (${e.cause.code})` : ""}`;
    return { rows: [], error: `Apify Monster: ${why}` };
  }
}

/** Only the fields the reader uses, so the download stays small (the actor returns about 50 fields a post). */
const ITEM_FIELDS = [
  "title", "jobTitle", "job_title", "company", "companyName", "company_name", "url", "jobUrl", "job_url", "applyUrl",
  "companyWebsite", "company_website", "postedDate", "posted_date", "datePosted", "location", "city", "state", "isRemote", "description",
].join(",");
