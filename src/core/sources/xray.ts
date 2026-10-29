import type { CampaignConfig, LeadRecord } from "../../config/schema.js";
import { logger } from "../../lib/logger.js";
import type { PeopleQuery, SearchProvider } from "../../lib/search/provider.js";
import type { EmailFinder } from "./email-finder.js";
import { normalizeLinkedinUrl, splitFullName, stableId, type SkippedRow, type SourceResult } from "./types.js";

/** One query per title x location, in campaign order. */
export function buildQueries(cfg: CampaignConfig): PeopleQuery[] {
  const queries: PeopleQuery[] = [];
  for (const title of cfg.decision_maker_titles) {
    for (const location of cfg.target_geography) {
      queries.push({ title, location, keywords: cfg.industry_keywords, signal: cfg.signal_query });
    }
  }
  return queries;
}

/**
 * gemini_xray: finds people through a SearchProvider (fixture or live Gemini),
 * keeps only real LinkedIn profile URLs, removes duplicates, then asks the EmailFinder for an email.
 */
export async function sourceFromSearch(
  cfg: CampaignConfig,
  limit: number,
  search: SearchProvider,
  emailFinder: EmailFinder,
): Promise<SourceResult> {
  const leads: LeadRecord[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Set<string>();
  let hitNo = 0;

  for (const q of buildQueries(cfg)) {
    if (leads.length >= limit) break;
    const want = Math.min(10, limit - leads.length);
    const hits = await search.findPeople(q, want);
    logger.info({ provider: search.name, title: q.title, location: q.location, hits: hits.length }, "search");

    for (const h of hits) {
      hitNo += 1;
      if (leads.length >= limit) break;

      const url = normalizeLinkedinUrl(h.linkedin_url);
      if (!url) { skipped.push({ row: hitNo, reason: "INVALID_LINKEDIN_URL", detail: h.linkedin_url }); continue; }
      if (seen.has(url)) { skipped.push({ row: hitNo, reason: "DUPLICATE_PROFILE", detail: url }); continue; }
      seen.add(url);

      const { first, last } = splitFullName(h.full_name);
      if (!first || !last) { skipped.push({ row: hitNo, reason: "MISSING_NAME", detail: h.full_name }); continue; }
      if (!h.company_name.trim()) { skipped.push({ row: hitNo, reason: "MISSING_COMPANY" }); continue; }

      const lead: LeadRecord = {
        lead_id: stableId("li", url),
        first_name: first,
        last_name: last,
        title: h.title,
        company_name: h.company_name,
        company_domain: h.company_domain ?? undefined,
        location: h.location,
        linkedin_url: url,
        email: h.email ?? undefined,
        source: "gemini_xray",
      };
      lead.email = await emailFinder.find(lead);
      leads.push(lead);
    }
  }
  return { provider: `gemini_xray/${search.name}`, leads, skipped };
}
