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

export interface EntityCheckOptions {
  minConfidence?: number;
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

    try {
      const verdict = await llm.generateJSON(buildPrompt(lead, domain), EntityVerdict, {
        system: SYSTEM,
        grounded: llm.supportsGrounding,
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
