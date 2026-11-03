import type { LeadRecord } from "../../config/schema.js";
import { logger } from "../../lib/logger.js";

const SEAMLESS_BASE = "https://api.seamless.ai/api/client/v1";

/**
 * Seamless.AI Contact Research. Unlike Apollo it is asynchronous:
 *   1. POST /contacts/research with the person  -> a requestId (1 credit)
 *   2. GET  /contacts/research/poll?requestIds=  -> status queued | researching | done | not found | ...
 * This function does both and returns a usable email, or undefined.
 * It never invents a domain: without company_domain it sends the company name and lets Seamless match.
 * Errors are logged, not thrown, so the lead simply arrives without an email and fails Gate 1.
 */

export interface SeamlessOptions {
  /** Wait between polls. Tests pass 0. */
  pollMs?: number;
  /** Give up after this long. Seamless usually answers in a few seconds. */
  maxWaitMs?: number;
}

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
  } | null;
};

const PENDING = new Set(["queued", "researching", "pending", "processing"]);

/**
 * The submit response, as seen live: { "success": true, "requestIds": ["awKW..."] }.
 * Older or alternate shapes ({ requestId }, [{ requestId }], { data: [...] }) are still accepted.
 */
export function firstRequestId(body: unknown): string | undefined {
  const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  if (Array.isArray(body)) {
    for (const r of body) {
      const id = clean((r as ResearchRow)?.requestId) ?? clean(r);
      if (id) return id;
    }
    return undefined;
  }
  if (!body || typeof body !== "object") return undefined;
  const o = body as { requestId?: unknown; requestIds?: unknown; data?: unknown; results?: unknown };
  const direct = clean(o.requestId);
  if (direct) return direct;
  if (Array.isArray(o.requestIds)) return firstRequestId(o.requestIds);
  if (o.data || o.results) return firstRequestId(o.data ?? o.results);
  return undefined;
}

/**
 * The poll response, as seen live: { "success": true, "data": [ { requestId, status, contact } ] }.
 * A bare list or a single row are also accepted.
 */
export function pollRows(body: unknown): ResearchRow[] {
  if (Array.isArray(body)) return body as ResearchRow[];
  if (!body || typeof body !== "object") return [];
  const o = body as { data?: unknown; results?: unknown };
  if (Array.isArray(o.data)) return o.data as ResearchRow[];
  if (o.data && typeof o.data === "object") return [o.data as ResearchRow];
  if (Array.isArray(o.results)) return o.results as ResearchRow[];
  return [body as ResearchRow];
}

/**
 * Picks the first email Seamless did not mark invalid. Prefers the main `email`, then email1..3.
 * Seamless's own label is a free early filter; Gate 5 still runs ZeroBounce on whatever is returned.
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

export async function seamlessMatch(
  lead: LeadRecord,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  opts: SeamlessOptions = {},
): Promise<string | undefined> {
  const pollMs = opts.pollMs ?? 2_000;
  const maxWaitMs = opts.maxWaitMs ?? 30_000;
  const headers = { "Content-Type": "application/json", Token: apiKey };

  const contact: Record<string, string> = { contactName: `${lead.first_name} ${lead.last_name}`.trim() };
  if (lead.company_domain) contact.domain = lead.company_domain;
  else contact.companyName = lead.company_name;
  if (lead.linkedin_url) contact.liProfileUrl = lead.linkedin_url;

  try {
    const submit = await fetchFn(`${SEAMLESS_BASE}/contacts/research`, {
      method: "POST",
      headers,
      body: JSON.stringify({ contacts: [contact] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!submit.ok) {
      logger.warn({ lead_id: lead.lead_id, status: submit.status }, "seamless submit failed");
      return undefined;
    }
    const requestId = firstRequestId(await submit.json());
    if (!requestId) {
      logger.warn({ lead_id: lead.lead_id }, "seamless submit returned no requestId");
      return undefined;
    }

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() <= deadline) {
      if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));

      const res = await fetchFn(`${SEAMLESS_BASE}/contacts/research/poll?requestIds=${encodeURIComponent(requestId)}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        logger.warn({ lead_id: lead.lead_id, status: res.status }, "seamless poll failed");
        return undefined;
      }
      const rows = pollRows(await res.json());
      const row = rows.find((r) => r?.requestId === requestId) ?? rows[0];
      const status = (row?.status ?? "").toLowerCase();

      if (PENDING.has(status) || status === "") continue;
      if (status !== "done") {
        logger.debug({ lead_id: lead.lead_id, status }, "seamless: no email");
        return undefined; // not found | missing | duplicate | error
      }
      return pickEmail(row?.contact);
    }
    logger.warn({ lead_id: lead.lead_id, requestId }, "seamless research timed out");
    return undefined;
  } catch (err) {
    logger.warn({ lead_id: lead.lead_id, err: (err as Error).message }, "seamless match error");
    return undefined;
  }
}
