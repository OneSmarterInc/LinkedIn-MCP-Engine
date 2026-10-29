import pLimit from "p-limit";
import { z } from "zod";
import type { CampaignConfig, LeadRecord } from "../config/schema.js";
import type { LLMProvider } from "../lib/llm/provider.js";
import { logger } from "../lib/logger.js";

/** What the model returns. The greeting ("Hi Jane,") is added by code, not the model. */
export const DraftOutput = z.object({
  research_summary: z.array(z.string()).max(2).describe("Up to 2 short, verified facts about the company. Empty if none."),
  email_subject: z.string().describe("Plain subject line, at most 7 words"),
  email_body: z.string().describe("Exactly 4 sentences of plain text. No greeting, no sign-off."),
});
export type DraftOutput = z.infer<typeof DraftOutput>;

export type DraftStatus = "READY" | "NEEDS_REWRITE" | "DRAFT_ERROR";

export interface DraftedLead extends LeadRecord {
  research_summary: string[];
  email_subject: string;
  email_body: string;
  draft_status: DraftStatus;
  draft_issues: string[];
}

/** Phrases that make an email read like a template or an AI. Checked case-insensitively. */
export const BANNED_PHRASES = [
  "hope this email finds you", "hope you are doing well", "hope you're doing well", "hope all is well",
  "i wanted to reach out", "reaching out", "touch base", "circle back", "quick question",
  "synergy", "leverage", "cutting-edge", "cutting edge", "game changer", "game-changer", "revolutionize",
  "delve", "unlock", "world-class", "best-in-class", "seamless", "robust", "innovative solution",
  "excited to", "thrilled to", "i came across your profile", "in today's fast-paced",
  "as an ai", "[", "{", "todo",
];

const ABBREVIATIONS = /\b(?:Dr|Mr|Mrs|Ms|Inc|Co|Corp|Ltd|St|Jr|Sr|vs|e\.g|i\.e|U\.S)\.$/i;

/** Counts sentences, ignoring dots in common abbreviations like "Inc." or "U.S.". */
export function countSentences(text: string): number {
  const parts = text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  let count = 0;
  for (let i = 0; i < parts.length; i++) {
    const merged = ABBREVIATIONS.test(parts[i]!) && i < parts.length - 1;
    if (!merged) count += 1;
  }
  return count;
}

const LEGAL_SUFFIX = /[,\s]+(inc|incorporated|co|company|corp|corporation|llc|l\.l\.c|ltd|limited|plc|lp|llp|pc|pllc)\.?$/i;

/** How a person would say the company name in an email: "The Kroger Co." -> "Kroger". */
export function shortCompanyName(company: string): string {
  let name = company.trim().replace(/^the\s+/i, "");
  for (let i = 0; i < 2; i++) name = name.replace(LEGAL_SUFFIX, "").trim();
  return name || company.trim();
}

/** First meaningful word of a company name: "The Kroger Co." -> "kroger". */
export function companyKeyword(company: string): string {
  return company.toLowerCase().replace(/^the\s+/, "").split(/[\s,]+/)[0]?.replace(/[^a-z0-9'&-]/g, "") ?? "";
}

/** Code checks every draft must pass. Returns a list of problems (empty = READY). */
export function checkDraft(d: DraftOutput, lead: LeadRecord, cfg: CampaignConfig): string[] {
  const issues: string[] = [];
  const subjectWords = d.email_subject.trim().split(/\s+/).filter(Boolean).length;
  if (subjectWords === 0) issues.push("subject is empty");
  if (subjectWords > 7) issues.push(`subject has ${subjectWords} words (max 7)`);

  const sentences = countSentences(d.email_body);
  if (sentences !== 4) issues.push(`body has ${sentences} sentences (must be exactly 4)`);
  if (!d.email_body.trim().endsWith("?")) issues.push("body must end with a question asking for the call");
  if (/^\s*([-*•]|\d+\.)\s/m.test(d.email_body)) issues.push("body contains a bullet or numbered list");
  if (/\*\*|__|#/.test(d.email_body)) issues.push("body contains markdown");
  if (/https?:\/\//i.test(d.email_body)) issues.push("body contains a link");
  if (/^(hi|hello|dear|hey)\b/i.test(d.email_body.trim())) issues.push("body starts with a greeting (code adds it)");
  if (/(regards|best,|thanks,|sincerely|cheers)\s*$/i.test(d.email_body.trim())) issues.push("body ends with a sign-off");

  const text = `${d.email_subject} ${d.email_body}`.toLowerCase();
  for (const p of BANNED_PHRASES) if (text.includes(p)) issues.push(`contains banned phrase "${p}"`);

  if (cfg.mode === "CORPORATE") {
    const key = companyKeyword(lead.company_name);
    if (key && !d.email_body.toLowerCase().includes(key)) {
      issues.push(`body does not name the company: write "${shortCompanyName(lead.company_name)}" in the first or second sentence`);
    }
  }
  return issues;
}

function systemPrompt(cfg: CampaignConfig, grounded: boolean): string {
  const persona = cfg.outreach_persona ?? "a peer in the same industry";
  return [
    `You write short, plain cold emails as ${persona}${cfg.sender_company ? ` at ${cfg.sender_company}` : ""}.`,
    "Write like a busy professional writing to a peer: direct, specific, warm, no hype.",
    "Rules: exactly 4 sentences; no greeting and no sign-off (they are added later); no bullets, links, or markdown;",
    "subject line of 7 words or fewer; the last sentence is a question asking for the call.",
    `The ONLY thing you may offer is: ${cfg.offer ?? "a short call"}.`,
    "Never claim anything about the sender company's products, clients, or results.",
    grounded
      ? "Use Google Search to find 1-2 recent, verifiable facts about the recipient's company. Mention one in the first sentence. If you find nothing reliable, return an empty research_summary and write from their role instead."
      : "You have NO web access. Do not invent news, events, numbers, or facts about the company. Return an empty research_summary. Write from the person's role and the type of company.",
  ].join(" ");
}

function userPrompt(lead: LeadRecord, cfg: CampaignConfig, feedback?: string[]): string {
  const short = shortCompanyName(lead.company_name);
  const lines = [
    cfg.mode === "CANDIDATE"
      ? "Recipient is a potential job candidate. Speak to their career, not to their employer's needs. Never imply their employer knows."
      : `Recipient is a decision-maker at a company we would like to work with. You MUST name the company as "${short}" in the first or second sentence (naming it is required; inventing facts about it is not allowed).`,
    `Name: ${lead.first_name} ${lead.last_name}`,
    `Title: ${lead.title}`,
    `Company: ${lead.company_name}${lead.company_domain ? ` (${lead.company_domain})` : ""}`,
    `Location: ${lead.location}`,
    `Call length: ${cfg.calendar_duration_minutes} minutes`,
  ];
  if (feedback?.length) {
    lines.push("", "Your previous draft broke these rules. Fix every one:", ...feedback.map((f) => `- ${f}`));
  }
  return lines.join("\n");
}

export interface WriterOptions {
  /** Attempts per lead when the draft breaks a rule. Default 3. */
  maxAttempts?: number;
  /** Leads drafted at the same time. Default 3. */
  concurrency?: number;
}

/** Drafts one email. Rewrites with feedback until it passes the checks or attempts run out. */
export async function draftOne(
  lead: LeadRecord,
  cfg: CampaignConfig,
  llm: LLMProvider,
  opts: WriterOptions = {},
): Promise<DraftedLead> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const grounded = llm.supportsGrounding;
  let last: DraftOutput | undefined;
  let issues: string[] = [];

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await llm.generateJSON(userPrompt(lead, cfg, issues), DraftOutput, {
        system: systemPrompt(cfg, grounded),
        grounded,
        temperature: attempt === 1 ? 0.4 : 0.2,
      });
      last = { ...last, email_subject: last.email_subject.trim(), email_body: last.email_body.trim() };
      issues = checkDraft(last, lead, cfg);
      if (issues.length === 0) break;
      logger.debug({ lead_id: lead.lead_id, attempt, issues }, "draft rewrite");
    }
  } catch (err) {
    logger.error({ lead_id: lead.lead_id, err: (err as Error).message }, "draft failed");
    return { ...lead, research_summary: [], email_subject: "", email_body: "", draft_status: "DRAFT_ERROR", draft_issues: [(err as Error).message] };
  }

  return {
    ...lead,
    research_summary: last!.research_summary,
    email_subject: last!.email_subject,
    email_body: `Hi ${lead.first_name},\n\n${last!.email_body}`,
    draft_status: issues.length === 0 ? "READY" : "NEEDS_REWRITE",
    draft_issues: issues,
  };
}

/** Phase 3: drafts an email for every lead that passed all 5 gates. Only call this with gate-passed leads. */
export async function draftAll(
  leads: LeadRecord[],
  cfg: CampaignConfig,
  llm: LLMProvider,
  opts: WriterOptions = {},
): Promise<DraftedLead[]> {
  if (!cfg.offer) {
    throw new Error(`Campaign "${cfg.campaign_name}" has no "offer". Add one line saying what we are asking for.`);
  }
  const limit = pLimit(opts.concurrency ?? 3);
  return Promise.all(leads.map((l) => limit(() => draftOne(l, cfg, llm, opts))));
}
