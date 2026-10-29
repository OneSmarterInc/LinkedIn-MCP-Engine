import { z } from "zod";

export const Mode = z.enum(["CORPORATE", "CANDIDATE"]);
export const SourcingProvider = z.enum(["gemini_xray", "apify_or_apollo", "csv_import"]);

const DEFAULT_CONSUMER_DOMAINS = [
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "aol.com", "icloud.com", "msn.com", "comcast.net",
];
const DEFAULT_ROLE_PREFIXES = [
  "info", "contact", "admin", "support", "sales", "office", "billing",
  "volunteer", "hr", "careers", "jobs", "recruiting", "media", "help",
];

export const CampaignConfig = z.object({
  campaign_name: z.string().min(1),
  mode: Mode,
  sourcing_provider: SourcingProvider,
  /** Default file for csv_import. The CLI --csv flag overrides it. */
  csv_path: z.string().optional(),
  target_geography: z.array(z.string()).min(1),
  decision_maker_titles: z.array(z.string()).min(1),
  industry_keywords: z.array(z.string()).default([]),
  signal_query: z.string().optional(),
  outreach_persona: z.string().optional(),
  /** Who the email is from (company name). The writer uses only this, never a guess. */
  sender_company: z.string().optional(),
  /** What we are asking for, in one plain sentence. The writer may not invent any other offer or claim. */
  offer: z.string().optional(),
  blocked_email_prefixes: z.array(z.string()).default(DEFAULT_ROLE_PREFIXES),
  blocked_consumer_domains: z.array(z.string()).default(DEFAULT_CONSUMER_DOMAINS),
  block_current_employer_domain: z.boolean().default(false),
  calendar_duration_minutes: z.number().int().positive().default(15),
  auto_send_booking_replies: z.boolean().default(false),
  daily_send_cap: z.number().int().positive().default(20),
});
export type CampaignConfig = z.infer<typeof CampaignConfig>;

export const LeadRecord = z.object({
  lead_id: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  title: z.string(),
  company_name: z.string(),
  company_domain: z.string().optional(),
  location: z.string(),
  linkedin_url: z.string().url().optional(),
  email: z.string().email().optional(),
  source: SourcingProvider,
});
export type LeadRecord = z.infer<typeof LeadRecord>;

export const FailureReason = z.enum([
  // Gate 1
  "MISSING_EMAIL",
  // Gate 2
  "SHARED_OR_DUPLICATE_EMAIL",
  "ALREADY_CONTACTED",
  "OPTED_OUT",
  // Gate 3
  "CONSUMER_DOMAIN",
  "ROLE_ACCOUNT",
  "DOMAIN_MISMATCH",
  "CURRENT_EMPLOYER_DOMAIN",
  // Gate 4
  "ENTITY_MISMATCH",
  // Gate 5
  "NO_MX_RECORD",
  "MAILBOX_INVALID",
  "MAILBOX_CATCH_ALL",
  "MAILBOX_UNKNOWN",
  "MAILBOX_DO_NOT_MAIL",
  // Any gate: an external check failed. The lead is held back, never passed.
  "GATE_ERROR",
]);
export type FailureReason = z.infer<typeof FailureReason>;

export const VerificationResult = z.object({
  lead_id: z.string(),
  passed: z.boolean(),
  failed_gate: z.number().int().min(1).max(5).optional(),
  failure_reason: FailureReason.optional(),
  checked_at: z.string(),
});
export type VerificationResult = z.infer<typeof VerificationResult>;
