import { z } from "zod";
import type { CampaignConfig, FailureReason, LeadRecord } from "../../config/schema.js";
import type { LLMProvider } from "../../lib/llm/provider.js";
import { logger } from "../../lib/logger.js";
import { emailParts } from "../sanitize.js";

/** What the model must return for Gate 4. */
export const EntityVerdict = z.object({
  same_organization: z.boolean().describe("The email domain belongs to this company, its parent, or a subsidiary"),
  location_consistent: z.boolean().describe("The company operates where the person is located"),
  confidence: z.number().min(0).max(1),
  reason: z.string().describe("One short sentence"),
});
export type EntityVerdict = z.infer<typeof EntityVerdict>;

const SYSTEM = [
  "You verify B2B contact records before outreach.",
  "Decide whether an email domain belongs to the named company, and whether that company operates in the person's location.",
  "Be strict. A university, hospital system, or unrelated business that happens to share a word with the company is a mismatch.",
  "A same-name person in a different state is a mismatch.",
  "If you are unsure, set confidence below 0.5.",
].join(" ");

function buildPrompt(lead: LeadRecord, emailDomain: string): string {
  return [
    `Person: ${lead.first_name} ${lead.last_name}`,
    `Title: ${lead.title}`,
    `Company: ${lead.company_name}`,
    `Company website domain: ${lead.company_domain ?? "unknown"}`,
    `Person location: ${lead.location}`,
    `Email domain found: ${emailDomain}`,
    lead.linkedin_url ? `LinkedIn: ${lead.linkedin_url}` : "",
    "",
    "Does the email domain belong to this company (or its parent/subsidiary), and does the company operate in the person's location?",
  ].filter(Boolean).join("\n");
}

/** Personal inbox (gmail etc.) for a candidate: the address must carry the person's name. */
export function emailMatchesName(local: string, first: string, last: string): boolean {
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
  const l = norm(local);
  const f = norm(first);
  const s = norm(last);
  if (s.length >= 3 && l.includes(s)) return true;
  if (f.length >= 3 && l.includes(f)) return true;
  if (f && s && l.includes(`${f[0]}${s}`)) return true;
  return false;
}

const EDU_DOMAIN = /\.(edu|edu\.[a-z]{2}|ac\.[a-z]{2})$/;
const GOV_DOMAIN = /\.(gov|mil|gov\.[a-z]{2})$/;
const SCHOOL_WORDS = /\b(university|college|school|institute|academy|education|seminary|polytechnic|district)\b/i;
const GOV_WORDS = /\b(government|county|city of|state of|department|agency|authority|commission|federal|army|navy|air force|military)\b/i;

/**
 * Code rules that run before the model, so obvious mismatches never depend on model quality.
 * Returns a reason when the email domain is a school or government domain but the company is not one.
 */
export function institutionalMismatch(companyName: string, emailDomain: string): string | null {
  if (EDU_DOMAIN.test(emailDomain) && !SCHOOL_WORDS.test(companyName)) {
    return `education domain ${emailDomain} for non-school company "${companyName}"`;
  }
  if (GOV_DOMAIN.test(emailDomain) && !GOV_WORDS.test(companyName)) {
    return `government domain ${emailDomain} for non-government company "${companyName}"`;
  }
  return null;
}

export interface EntityCheckOptions {
  minConfidence?: number;
}

// ---------------------------------------------------------------------------
// Rules: does the email domain belong to the company? No model, no cost, no quota.
// ---------------------------------------------------------------------------

const TWO_LEVEL_TLDS = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** "www.mail.Acme.co.uk" -> "acme.co.uk"; "sub.acme.com" -> "acme.com". */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const keep = TWO_LEVEL_TLDS.has(parts[parts.length - 2]!) && parts[parts.length - 1]!.length === 2 ? 3 : 2;
  return parts.slice(-keep).join(".");
}

const NAME_STOPWORDS = new Set(["inc", "llc", "ltd", "plc", "corp", "corporation", "company", "co", "the", "group", "holdings", "and", "of", "international", "global", "services", "solutions"]);

function nameTokens(companyName: string): string[] {
  return companyName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t && !NAME_STOPWORDS.has(t));
}

/**
 * Compares an email domain with the company. Three answers:
 *   "match"     the domain is the company's website domain, or its main word is the company's name
 *   "mismatch"  the company's website domain is known and this is a different one
 *   "unknown"   no website domain on record and the words do not line up
 */
export function domainMatchesCompany(emailDomain: string, companyName: string, companyDomain?: string): "match" | "mismatch" | "unknown" {
  const email = registrableDomain(emailDomain);
  if (companyDomain && registrableDomain(companyDomain) === email) return "match";
  const label = email.split(".")[0] ?? "";
  const tokens = nameTokens(companyName);
  const compact = tokens.join("");
  if (label.length >= 4 && compact.length >= 4 && (compact.includes(label) || label.includes(compact))) return "match";
  if (tokens.some((t) => t.length >= 4 && label.includes(t))) return "match";
  const acronym = tokens.map((t) => t[0]).join("");
  if (acronym.length >= 3 && label === acronym) return "match";
  return companyDomain ? "mismatch" : "unknown";
}

/** Sources that looked the person up at that company, rather than guessing or scraping an address. */
const TRUSTED_SOURCES = new Set(["seamless", "apollo"]);

/**
 * Gate 4 without a model (ENTITY_CHECK=rules). Same code rules as before, then the domain comparison.
 * Domain matches the company: pass. Company website unknown: pass only when Seamless or Apollo supplied the
 * address. Company website known and the email is elsewhere: held back. Location is not checked.
 */
export function makeRuleEntityCheck(cfg: CampaignConfig) {
  return async (lead: LeadRecord): Promise<FailureReason | null> => {
    const { local, domain } = emailParts(lead.email!);
    if (cfg.mode === "CANDIDATE" && cfg.blocked_consumer_domains.includes(domain)) {
      return emailMatchesName(local, lead.first_name, lead.last_name) ? null : "ENTITY_MISMATCH";
    }
    const rule = institutionalMismatch(lead.company_name, domain);
    if (rule) { logger.debug({ lead_id: lead.lead_id, gate: 4, rule }, "entity rule mismatch"); return "ENTITY_MISMATCH"; }
    const verdict = domainMatchesCompany(domain, lead.company_name, lead.company_domain);
    const trusted = TRUSTED_SOURCES.has(lead.email_source ?? "");
    // "match" passes. "unknown" (no company website on record) passes only for an address Seamless or Apollo
    // returned for this person. "mismatch" (the company's website is known and this is a different domain) is
    // held back whoever supplied the address: that is the wrong-company case this gate exists for.
    const ok = verdict === "match" || (verdict === "unknown" && trusted);
    logger.debug({ lead_id: lead.lead_id, gate: 4, verdict, email_source: lead.email_source, ok }, "entity rules");
    return ok ? null : "ENTITY_MISMATCH";
  };
}

/**
 * Gate 4 hybrid (ENTITY_CHECK=hybrid): rules decide the clear cases; the model is asked only when the
 * domain and the company do not line up. Cuts model calls to the hard cases.
 */
export function makeHybridEntityCheck(llm: LLMProvider, cfg: CampaignConfig, opts: EntityCheckOptions = {}) {
  const model = makeEntityCheck(llm, cfg, opts);
  return async (lead: LeadRecord): Promise<FailureReason | null> => {
    const { domain } = emailParts(lead.email!);
    if (cfg.mode === "CANDIDATE" && cfg.blocked_consumer_domains.includes(domain)) return model(lead);
    if (institutionalMismatch(lead.company_name, domain)) return "ENTITY_MISMATCH";
    if (domainMatchesCompany(domain, lead.company_name, lead.company_domain) === "match") return null;
    return model(lead);
  };
}

/**
 * Gate 4: entity and geography cross-check.
 * Fails closed: if the model errors, the lead is held back with GATE_ERROR.
 */
export function makeEntityCheck(llm: LLMProvider, cfg: CampaignConfig, opts: EntityCheckOptions = {}) {
  const minConfidence = opts.minConfidence ?? 0.7;

  return async (lead: LeadRecord): Promise<FailureReason | null> => {
    const { local, domain } = emailParts(lead.email!);

    // CANDIDATE on a personal inbox: the domain says nothing about the company, so check the name instead.
    if (cfg.mode === "CANDIDATE" && cfg.blocked_consumer_domains.includes(domain)) {
      return emailMatchesName(local, lead.first_name, lead.last_name) ? null : "ENTITY_MISMATCH";
    }

    const rule = institutionalMismatch(lead.company_name, domain);
    if (rule) {
      logger.debug({ lead_id: lead.lead_id, gate: 4, rule }, "entity rule mismatch");
      return "ENTITY_MISMATCH";
    }

    try {
      const verdict = await llm.generateJSON(buildPrompt(lead, domain), EntityVerdict, {
        system: SYSTEM,
        grounded: llm.supportsGrounding,
        thinking: "low", // a yes/no check needs little thinking; keeps Gate 4 cheap
      });
      const ok = verdict.same_organization && verdict.location_consistent && verdict.confidence >= minConfidence;
      logger.debug({ lead_id: lead.lead_id, gate: 4, ok, confidence: verdict.confidence, reason: verdict.reason }, "entity check");
      return ok ? null : "ENTITY_MISMATCH";
    } catch (err) {
      logger.error({ lead_id: lead.lead_id, gate: 4, err: (err as Error).message }, "entity check failed");
      return "GATE_ERROR";
    }
  };
}
