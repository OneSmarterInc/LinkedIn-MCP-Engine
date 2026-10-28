import type { CampaignConfig, FailureReason, LeadRecord, VerificationResult } from "../config/schema.js";
import type { Ledger } from "./db.js";
import { cleanFirstName, cleanLastName, cleanText, emailParts, normalizeDomain, normalizeEmail } from "./sanitize.js";

type Gate = 1 | 2 | 3 | 4 | 5;
export type Quarantined = { lead: LeadRecord; result: VerificationResult };
export type VerifyOutput = { passed: LeadRecord[]; quarantined: Quarantined[] };

/** Gates 4 and 5 call external services. They are injected so tests can control them. */
export interface AsyncGates {
  entityCheck(lead: LeadRecord): Promise<FailureReason | null>;  // Gate 4
  mailboxCheck(lead: LeadRecord): Promise<FailureReason | null>; // Gate 5
}

function fail(lead: LeadRecord, gate: Gate, reason: FailureReason): Quarantined {
  return {
    lead,
    result: { lead_id: lead.lead_id, passed: false, failed_gate: gate, failure_reason: reason, checked_at: new Date().toISOString() },
  };
}

// ---------- Gate 1: sanitize ----------
export function gate1Sanitize(lead: LeadRecord): { lead: LeadRecord } | { reason: FailureReason } {
  const email = normalizeEmail(lead.email);
  const cleaned: LeadRecord = {
    ...lead,
    first_name: cleanFirstName(lead.first_name),
    last_name: cleanLastName(lead.last_name),
    title: cleanText(lead.title),
    company_name: cleanText(lead.company_name),
    location: cleanText(lead.location),
    company_domain: normalizeDomain(lead.company_domain),
    email,
  };
  if (!email) return { reason: "MISSING_EMAIL" };
  return { lead: cleaned };
}

// ---------- Gate 2: dedup + ledger ----------
function personKey(l: LeadRecord): string {
  return (l.linkedin_url ?? `${l.first_name} ${l.last_name}|${l.company_name}`).toLowerCase();
}

export function gate2Dedup(leads: LeadRecord[], ledger: Ledger): { kept: LeadRecord[]; failed: Quarantined[] } {
  const byEmail = new Map<string, LeadRecord[]>();
  for (const l of leads) {
    const list = byEmail.get(l.email!) ?? [];
    list.push(l);
    byEmail.set(l.email!, list);
  }

  const kept: LeadRecord[] = [];
  const failed: Quarantined[] = [];
  for (const [email, group] of byEmail) {
    const people = new Set(group.map(personKey));
    if (people.size > 1) {
      group.forEach((l) => failed.push(fail(l, 2, "SHARED_OR_DUPLICATE_EMAIL")));
      continue;
    }
    const [first, ...dupes] = group;
    dupes.forEach((l) => failed.push(fail(l, 2, "SHARED_OR_DUPLICATE_EMAIL")));
    if (!first) continue;
    if (ledger.isSuppressed(email)) failed.push(fail(first, 2, "OPTED_OUT"));
    else if (ledger.isContacted(email)) failed.push(fail(first, 2, "ALREADY_CONTACTED"));
    else kept.push(first);
  }
  return { kept, failed };
}

// ---------- Gate 3: mode-specific inbox + domain ----------
function domainMatches(emailDomain: string, companyDomain: string): boolean {
  return emailDomain === companyDomain || emailDomain.endsWith(`.${companyDomain}`);
}

function isRoleAccount(local: string, prefixes: string[]): boolean {
  return prefixes.some((p) => local === p || /^[._-]/.test(local.slice(p.length)) && local.startsWith(p));
}

export function gate3Domain(lead: LeadRecord, cfg: CampaignConfig): FailureReason | null {
  const { local, domain } = emailParts(lead.email!);
  if (isRoleAccount(local, cfg.blocked_email_prefixes)) return "ROLE_ACCOUNT";

  if (cfg.mode === "CORPORATE") {
    if (cfg.blocked_consumer_domains.includes(domain)) return "CONSUMER_DOMAIN";
    if (!lead.company_domain || !domainMatches(domain, lead.company_domain)) return "DOMAIN_MISMATCH";
    return null;
  }

  // CANDIDATE
  if (cfg.block_current_employer_domain && lead.company_domain && domainMatches(domain, lead.company_domain)) {
    return "CURRENT_EMPLOYER_DOMAIN";
  }
  return null;
}

// ---------- Orchestrator ----------
export async function verifyBatch(
  raw: LeadRecord[],
  cfg: CampaignConfig,
  ledger: Ledger,
  asyncGates: AsyncGates,
): Promise<VerifyOutput> {
  const quarantined: Quarantined[] = [];

  const afterG1: LeadRecord[] = [];
  for (const l of raw) {
    const r = gate1Sanitize(l);
    if ("reason" in r) quarantined.push(fail(l, 1, r.reason));
    else afterG1.push(r.lead);
  }

  const g2 = gate2Dedup(afterG1, ledger);
  quarantined.push(...g2.failed);

  const passed: LeadRecord[] = [];
  for (const l of g2.kept) {
    const r3 = gate3Domain(l, cfg);
    if (r3) { quarantined.push(fail(l, 3, r3)); continue; }

    const r4 = await asyncGates.entityCheck(l);
    if (r4) { quarantined.push(fail(l, 4, r4)); continue; }

    const r5 = await asyncGates.mailboxCheck(l);
    if (r5) { quarantined.push(fail(l, 5, r5)); continue; }

    passed.push(l);
  }
  return { passed, quarantined };
}