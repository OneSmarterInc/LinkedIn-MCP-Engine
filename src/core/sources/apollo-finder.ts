import type { LeadRecord } from "../../config/schema.js";
import { logger } from "../../lib/logger.js";

const APOLLO_MATCH_URL = "https://api.apollo.io/api/v1/people/match";

/** Apollo returns a placeholder like this when the email is locked on the current plan. */
const LOCKED = /email_not_unlocked|not_unlocked|^$/i;

type MatchResponse = { person?: { email?: string | null; email_status?: string | null } | null };

/**
 * Looks one person up in Apollo. Returns a usable email, or undefined.
 * Never invents a domain: without company_domain it sends only name + company and lets Apollo match.
 * Errors are logged (not swallowed) so a bad key or a blocked plan is visible.
 */
export async function apolloMatch(lead: LeadRecord, apiKey: string, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  const body: Record<string, string> = {
    first_name: lead.first_name,
    last_name: lead.last_name,
    organization_name: lead.company_name,
  };
  if (lead.company_domain) body.domain = lead.company_domain;
  if (lead.linkedin_url) body.linkedin_url = lead.linkedin_url;

  try {
    const res = await fetchFn(APOLLO_MATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "x-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      logger.warn({ lead_id: lead.lead_id, status: res.status }, "apollo match failed");
      return undefined;
    }
    const data = (await res.json()) as MatchResponse;
    const email = data.person?.email?.trim().toLowerCase() ?? "";
    if (LOCKED.test(email) || !email.includes("@")) return undefined;
    return email;
  } catch (err) {
    logger.warn({ lead_id: lead.lead_id, err: (err as Error).message }, "apollo match error");
    return undefined;
  }
}

/** ASCII letters only: "José" -> "jose", "Mary Ann" -> "maryann", "O'Neil" -> "oneil". */
function emailPart(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * first.last@company_domain. Only when the real company domain is known; never made up from the name.
 * The result is a guess and must be labelled email_source="pattern".
 */
export function guessEmail(lead: LeadRecord): string | undefined {
  const first = emailPart(lead.first_name);
  const last = emailPart(lead.last_name.split(/\s+/).pop() ?? "");
  const domain = lead.company_domain?.trim().toLowerCase();
  if (!first || !last || !domain || !domain.includes(".")) return undefined;
  return `${first}.${last}@${domain}`;
}
