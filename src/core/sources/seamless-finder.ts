import type { LeadRecord } from "../../config/schema.js";
import { logger } from "../../lib/logger.js";

const SEAMLESS_BASE = "https://api.seamless.ai/api/client/v1";

/**
 * Seamless.AI Contact Research. Unlike Apollo it is asynchronous:
 *   1. POST /contacts/research with the person        -> { success, requestIds: ["..."] }   (1 credit)
 *   2. GET  /contacts/research/poll?requestIds=<id>    -> { success, data: [{ requestId, status, contact }] }
 *      status: queued | researching | done | not found | ...
 * This function does both and returns a usable work email, or undefined.
 * It never invents a domain: without company_domain it sends the company name and lets Seamless match.
 * Errors are logged, not thrown, so the lead simply arrives without an email and fails Gate 1.
 */

export interface SeamlessOptions {
  /** Wait between polls. Tests pass 0. */
  pollMs?: number;
  /** Give up after this long. */
  maxWaitMs?: number;
  /** How far back to read already-saved contacts when research answers "duplicate". Default 365 days. */
  savedDays?: number;
}

/**
 * What a lookup ended with: an email, a real "Seamless has no one", or a failure (HTTP error, timeout, a
 * duplicate that could not be read back). Only "none" may be remembered as a dead end; "error" is retried later.
 */
export type LookupOutcome = "found" | "none" | "error";

type ResearchRow = {
  requestId?: string;
  status?: string;
  contact?: {
    email?: string | null;
    email1?: string | null;
    email2?: string | null;
    email3?: string | null;
    email1EmailAI?: string | null;
    email2EmailAI?: string | null;
    email3EmailAI?: string | null;
    personalEmail?: string | null;
    /** Seamless "Do Not Email" flags. isDneAll = never email this person. */
    isDneAll?: boolean | null;
    isDneSome?: boolean | null;
  } | null;
};

/** Research statuses that mean "this person is already saved in your Seamless account". */
const DUPLICATE = new Set(["duplicate", "contact-already-researched", "contact already researched", "already researched"]);

const PENDING = new Set(["queued", "researching", "pending", "processing", "in progress", "in_progress"]);

/**
 * The first requestId in a submit response. Handles the real shape { requestIds: [...] }
 * and the older guesses (one row, a list of rows, or rows under data/results).
 */
export function firstRequestId(body: unknown): string | undefined {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const ids = (body as { requestIds?: unknown }).requestIds;
    if (Array.isArray(ids)) {
      const id = ids.find((x): x is string => typeof x === "string" && x.trim() !== "");
      if (id) return id.trim();
    }
  }
  const rows = Array.isArray(body) ? body : body && typeof body === "object" ? [body as ResearchRow] : [];
  for (const r of rows) {
    const id = (r as ResearchRow)?.requestId;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  const o = body as { data?: unknown; results?: unknown } | null;
  if (o && typeof o === "object" && (o.data || o.results)) return firstRequestId(o.data ?? o.results);
  return undefined;
}

/** Rows from a poll response. Real shape: { success, data: [ ...rows ] }. Also accepts a bare list or row. */
export function pollRows(body: unknown): ResearchRow[] {
  if (Array.isArray(body)) return body as ResearchRow[];
  if (body && typeof body === "object") {
    const o = body as { data?: unknown; results?: unknown };
    const inner = o.data ?? o.results;
    if (Array.isArray(inner)) return inner as ResearchRow[];
    if (inner && typeof inner === "object") return [inner as ResearchRow];
    return [body as ResearchRow];
  }
  return [];
}

/**
 * Picks the first work email Seamless did not mark invalid. Prefers the main `email`, then email1..3.
 * personalEmail is never used: business campaigns write to work addresses only.
 * Seamless's own label (e.g. "accept all" = catch-all domain) is a free early filter;
 * Gate 5 still runs ZeroBounce on whatever is returned.
 */
export function pickEmail(contact: ResearchRow["contact"]): string | undefined {
  if (!contact) return undefined;
  const candidates: Array<[string | null | undefined, string | null | undefined]> = [
    [contact.email, contact.email1EmailAI],
    [contact.email1, contact.email1EmailAI],
    [contact.email2, contact.email2EmailAI],
    [contact.email3, contact.email3EmailAI],
  ];
  for (const [raw, label] of candidates) {
    const email = (raw ?? "").trim().toLowerCase();
    if (!email.includes("@")) continue;
    if ((label ?? "").trim().toLowerCase() === "invalid") continue;
    return email;
  }
  return undefined;
}

/** The contact fields we read from a finished research row. */
export type ResearchContact = NonNullable<ResearchRow["contact"]> & {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
};

/**
 * Sends one research request (1 credit) and polls until it is done.
 * Returns the researched contact, or undefined when Seamless has nothing, the person is Do Not Email,
 * or anything fails. Never throws.
 */
export async function researchAndPoll(
  body: Record<string, unknown>,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  opts: SeamlessOptions = {},
  ctx: Record<string, unknown> = {},
  /** Set when Seamless answers "duplicate": the person is already saved in this account. Returns them from there. */
  onDuplicate?: () => Promise<ResearchContact | undefined>,
  outcome?: (o: LookupOutcome) => void,
): Promise<ResearchContact | undefined> {
  const done = (o: LookupOutcome, c?: ResearchContact) => { outcome?.(o); return c; };
  const pollMs = opts.pollMs ?? 3_000;
  const maxWaitMs = opts.maxWaitMs ?? 60_000;
  const headers = { "Content-Type": "application/json", Token: apiKey };

  try {
    const submit = await fetchFn(`${SEAMLESS_BASE}/contacts/research`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!submit.ok) {
      logger.warn({ ...ctx, status: submit.status }, "seamless submit failed");
      return done("error");
    }
    const requestId = firstRequestId(await submit.json());
    if (!requestId) {
      logger.warn(ctx, "seamless submit returned no requestId");
      return done("error");
    }

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() <= deadline) {
      if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));

      const res = await fetchFn(`${SEAMLESS_BASE}/contacts/research/poll?requestIds=${encodeURIComponent(requestId)}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        logger.warn({ ...ctx, status: res.status }, "seamless poll failed");
        return done("error");
      }
      const rows = pollRows(await res.json());
      const row = rows.find((r) => r?.requestId === requestId) ?? rows[0];
      const status = (row?.status ?? "").toLowerCase().trim();

      if (PENDING.has(status) || status === "") continue;
      if (DUPLICATE.has(status)) {
        // Already researched in this Seamless account (by an earlier run, or by hand): the email is in the saved
        // contacts. Read it from there; no new credit.
        const saved = onDuplicate ? await onDuplicate() : undefined;
        if (saved) { logger.info({ ...ctx }, "seamless: duplicate, read from saved contacts"); return done("found", saved); }
        logger.warn({ ...ctx, status }, "seamless: duplicate, but the saved contact was not found");
        return done("error");
      }
      if (status !== "done") {
        logger.info({ ...ctx, status }, "seamless: no email");
        return done(status === "error" ? "error" : "none"); // not found | missing -> none
      }
      if (row?.contact?.isDneAll) {
        logger.info(ctx, "seamless: contact is marked Do Not Email");
        return done("none");
      }
      const c = (row?.contact ?? undefined) as ResearchContact | undefined;
      return done(c ? "found" : "none", c);
    }
    logger.warn({ ...ctx, requestId }, "seamless research timed out");
    return done("error");
  } catch (err) {
    logger.warn({ ...ctx, err: (err as Error).message }, "seamless match error");
    return done("error");
  }
}

export async function seamlessMatch(
  lead: LeadRecord,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  opts: SeamlessOptions = {},
): Promise<string | undefined> {
  const contact: Record<string, string> = { contactName: `${lead.first_name} ${lead.last_name}`.trim() };
  if (lead.company_domain) contact.domain = lead.company_domain;
  else contact.companyName = lead.company_name;
  if (lead.linkedin_url) contact.liProfileUrl = lead.linkedin_url;

  const found = await researchAndPoll({ contacts: [contact] }, apiKey, fetchFn, opts, { lead_id: lead.lead_id });
  if (!found) return undefined;
  const email = pickEmail(found);
  if (!email) logger.info({ lead_id: lead.lead_id }, "seamless: done, but no usable work email");
  return email;
}

/** Titles tried when a job post names no person. */
export const RECRUITER_TITLES = [
  "Recruiter", "Talent Acquisition", "Recruiting", "HR Manager", "Human Resources Manager", "HR Business Partner",
  "HR Generalist", "HR Director", "Human Resources Director",
];

/**
 * How good a title is to email about an open job, lower is better: recruiters and talent acquisition first, then HR
 * managers and partners, then HR directors, then VPs, then the C-level and EVPs (they seldom answer a cold email).
 */
export function titleRank(title?: string | null): number {
  const t = (title ?? "").toLowerCase();
  if (!t) return 2.5;
  if (/\b(chief|chro|cpo|evp|svp|executive vice president|senior vice president|(?<!vice )president)\b/.test(t)) return 4;
  if (/\b(vp|vice president|head of)\b/.test(t)) return 3;
  if (/\b(recruit\w*|talent acquisition|talent partner|sourcer|sourcing)\b/.test(t)) return 0;
  if (/\b(director)\b/.test(t)) return 2;
  if (/\b(hr|human resources|people)\b/.test(t)) return 1;
  return 2.5;
}

export interface RecruiterHit {
  email: string;
  name?: string;
  title?: string;
}

/** First searchResultId in a POST /search/contacts reply: { data: [ { searchResultId, ... } ], supplementalData }. */
/** The searchResultId with the best title (titleRank), first in Seamless's order on a tie. */
export function bestSearchResultId(body: unknown): string | undefined {
  const rows = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return undefined;
  let best: { id: string; rank: number } | undefined;
  for (const r of rows as Array<Record<string, unknown>>) {
    const raw = r?.searchResultId;
    const id = typeof raw === "string" && raw.trim() ? raw.trim() : typeof raw === "number" ? String(raw) : undefined;
    if (!id) continue;
    const title = [r.title, r.jobTitle, r.currentTitle, r.position].find((v): v is string => typeof v === "string" && v.trim() !== "");
    const rank = titleRank(title);
    if (!best || rank < best.rank) best = { id, rank };
  }
  return best?.id;
}

export function firstSearchResultId(body: unknown): string | undefined {
  const rows = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return undefined;
  for (const r of rows) {
    const id = (r as { searchResultId?: unknown })?.searchResultId;
    if (typeof id === "string" && id.trim()) return id.trim();
    if (typeof id === "number") return String(id);
  }
  return undefined;
}

/**
 * Finds a recruiter or HR person at a company and their work email.
 * Step 1: POST /search/contacts (1 credit per started block of 50 results; we ask for 25 and keep the best title).
 * Step 2: research that searchResultId (1 credit) and poll.
 * Returns undefined when nothing usable is found. Never throws.
 */
export async function seamlessFindRecruiter(
  company: { name: string; domain?: string },
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  opts: SeamlessOptions = {},
  outcome?: (o: LookupOutcome) => void,
): Promise<RecruiterHit | undefined> {
  const ctx = { company: company.name };
  let result = "error" as LookupOutcome;
  const report = (o: LookupOutcome) => { result = o; };
  const filter: Record<string, unknown> = company.domain
    ? { companyDomain: [company.domain] }
    : { companyName: [company.name] };
  try {
    const res = await fetchFn(`${SEAMLESS_BASE}/search/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Token: apiKey },
      // Up to 25 people for one credit (Seamless bills a started block of 50), then the best title is researched.
      body: JSON.stringify({ ...filter, jobTitle: RECRUITER_TITLES, limit: 25 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      logger.warn({ ...ctx, status: res.status }, "seamless contact search failed");
      outcome?.("error");
      return undefined;
    }
    const id = bestSearchResultId(await res.json());
    if (!id) {
      logger.info(ctx, "seamless: no recruiter or HR contact found");
      outcome?.("none");
      return undefined;
    }
    const contact = await researchAndPoll({ searchResultIds: [id] }, apiKey, fetchFn, opts, ctx,
      () => findSavedContact(apiKey, fetchFn, { domain: company.domain, companyName: company.name, titles: RECRUITER_TITLES }, opts), report);
    const email = pickEmail(contact);
    if (!contact || !email) { outcome?.(result === "found" ? "none" : result); return undefined; }
    outcome?.("found");
    const name = (contact.name ?? `${contact.firstName ?? ""} ${contact.lastName ?? ""}`).trim();
    return { email, ...(name ? { name } : {}), ...(contact.title ? { title: contact.title } : {}) };
  } catch (err) {
    logger.warn({ ...ctx, err: (err as Error).message }, "seamless recruiter search error");
    outcome?.("error");
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Saved contacts. Research answers "duplicate" when the person is already in this Seamless account; the email is
// then read from the account's saved contacts (GET /contacts, 30 days per request, newest first). Loaded once per
// process and kept 10 minutes, so a run with several duplicates reads the list once.
// ---------------------------------------------------------------------------------------------------------------

/** Path of the saved-contacts list. SEAMLESS_SAVED_CONTACTS_PATH overrides it if Seamless moves it. */
export const savedContactsPath = () => process.env.SEAMLESS_SAVED_CONTACTS_PATH?.trim() || "/contacts";

type SavedRow = ResearchContact & {
  companyName?: string | null; company?: string | null; companyDomain?: string | null; domain?: string | null;
  createdAt?: string | null;
};

let savedCache: { key: string; at: number; rows: SavedRow[] } | undefined;
const SAVED_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** Test hook. */
export function clearSavedContactsCache(): void { savedCache = undefined; }

function rowsOf(body: unknown): SavedRow[] {
  if (Array.isArray(body)) return body as SavedRow[];
  const o = body as { results?: unknown; data?: unknown; contacts?: unknown } | null;
  const inner = o?.results ?? o?.data ?? o?.contacts;
  return Array.isArray(inner) ? (inner as SavedRow[]) : [];
}

/** Every saved contact from the last `days` days, 30-day windows, 500 a page. */
export async function loadSavedContacts(apiKey: string, fetchFn: typeof fetch = fetch, days = 365, now = Date.now()): Promise<SavedRow[]> {
  const key = `${apiKey.slice(-6)}|${days}`;
  if (savedCache && savedCache.key === key && now - savedCache.at < SAVED_TTL_MS) return savedCache.rows;
  const rows: SavedRow[] = [];
  for (let end = now; end > now - days * DAY_MS; end -= 30 * DAY_MS) {
    const start = Math.max(end - 30 * DAY_MS + 1000, now - days * DAY_MS);
    for (let page = 1; page <= 20; page++) {
      const q = new URLSearchParams({ startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString(), page: String(page), limit: "500" });
      const res = await fetchFn(`${SEAMLESS_BASE}${savedContactsPath()}?${q}`, { headers: { Token: apiKey }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`saved contacts: HTTP ${res.status}`);
      const got = rowsOf(await res.json());
      rows.push(...got);
      if (got.length < 500) break;
    }
  }
  savedCache = { key, at: now, rows };
  return rows;
}

const squashName = (v?: string | null) => (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const bareDomain = (v?: string | null) => (v ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

/**
 * The saved contact for a company (and, for a named person, that person). Prefers a recruiter or HR title when
 * `titles` is given, then the newest. Returns undefined when nothing matches or the list cannot be read.
 */
export async function findSavedContact(
  apiKey: string,
  fetchFn: typeof fetch,
  want: { domain?: string; companyName?: string; personName?: string; titles?: string[] },
  opts: SeamlessOptions = {},
): Promise<ResearchContact | undefined> {
  let rows: SavedRow[];
  try { rows = await loadSavedContacts(apiKey, fetchFn, opts.savedDays ?? 365); } catch (err) {
    logger.warn({ err: (err as Error).message, path: savedContactsPath() }, "seamless: could not read saved contacts");
    return undefined;
  }
  const d = bareDomain(want.domain);
  const n = squashName(want.companyName);
  const person = squashName(want.personName);
  const sameCompany = (r: SavedRow) =>
    (d && (bareDomain(r.companyDomain) === d || bareDomain(r.domain) === d || (pickEmail(r) ?? "").endsWith(`@${d}`))) ||
    (n && (squashName(r.companyName) === n || squashName(r.company) === n));
  const fullName = (r: SavedRow) => squashName(r.name ?? `${r.firstName ?? ""}${r.lastName ?? ""}`);
  let hits = rows.filter((r) => sameCompany(r) && pickEmail(r) && !r.isDneAll);
  if (person) hits = hits.filter((r) => fullName(r) === person);
  if (!hits.length) return undefined;
  // Recruiters first (titleRank), then the newest.
  const rank = (r: SavedRow) => (want.titles?.length ? titleRank(r.title) : 0);
  hits.sort((a, b) => rank(a) - rank(b) || String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return hits[0];
}
