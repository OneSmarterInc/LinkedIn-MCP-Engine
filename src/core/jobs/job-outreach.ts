import type { CampaignConfig, LeadRecord } from "../../config/schema.js";
import type { LLMProvider } from "../../lib/llm/provider.js";
import { logger } from "../../lib/logger.js";
import type { Ledger } from "../db.js";
import { draftAll } from "../enricher.js";
import { exportToSheet, JOB_TABS, recordExported, type SheetsGateway } from "../exporter.js";
import { syncOptOuts } from "../optout-sync.js";
import type { RunReport } from "../pipeline.js";
import { splitFullName, stableId } from "../sources/types.js";
import { verifyBatch, type AsyncGates } from "../verifier.js";
import type { JobSearchOutput, JobView } from "./job-search.js";

/**
 * Turns found job posts into outreach, the same way a campaign run does:
 * contact -> 5 gates -> AI draft -> Jobs_Pipeline as "Ready for Review" (failures to Jobs_Quarantine).
 * After a human sets Status to Approved, AutoBooker sends it, tracks replies, and books the meeting.
 */

/** Campaigns-tab row (or JSON file) whose offer, sender and persona the job emails use. */
export const DEFAULT_JOBS_CAMPAIGN = "Jobs";

/** One lead per job post. A job with no contact email still becomes a lead, so it shows in Jobs_Quarantine. */
export function jobToLead(j: JobView): LeadRecord {
  const { first, last } = splitFullName(j.contact_name ?? "");
  return {
    lead_id: stableId("job", j.url),
    first_name: first,
    last_name: last,
    title: j.contact_title ?? "",
    company_name: j.company,
    ...(j.company_domain ? { company_domain: j.company_domain } : {}),
    location: j.location,
    ...(j.email ? { email: j.email, email_source: "seamless" as const } : {}),
    source: "job_search",
    hiring_for: {
      role: j.job_title,
      url: j.url,
      ...(j.posted_date_unconfirmed ? { posted_date: j.posted_date_unconfirmed } : {}),
    },
  };
}

export function jobsToLeads(out: JobSearchOutput): LeadRecord[] {
  return out.jobs.map(jobToLead);
}

/** Fails early with a clear message when the jobs campaign cannot write emails. */
export function checkJobsCampaign(cfg: CampaignConfig): void {
  if (cfg.mode !== "CORPORATE") {
    throw new Error(`Campaign "${cfg.campaign_name}" is ${cfg.mode}. Job outreach writes to companies, so it must be CORPORATE.`);
  }
  if (!cfg.offer?.trim()) {
    throw new Error(`Campaign "${cfg.campaign_name}" has no offer. Add one sentence saying what we offer to a company that is hiring.`);
  }
  if (!cfg.sender_company?.trim() || /your company name/i.test(cfg.sender_company)) {
    throw new Error(`Campaign "${cfg.campaign_name}" has no real sender company. Set it before sending job emails.`);
  }
}

export type OutreachStage = "syncing" | "verifying" | "drafting" | "exporting";

export interface JobOutreachDeps {
  cfg: CampaignConfig;
  ledger: Ledger;
  gates: AsyncGates;
  llm: LLMProvider;
  gw: SheetsGateway;
  runId: string;
  onStep?: (stage: OutreachStage, message: string) => void;
}

export interface JobOutreachResult {
  run_id: string;
  campaign: string;
  tabs: typeof JOB_TABS;
  contacts: number;
  passed: number;
  quarantined: number;
  quarantined_by_reason: Record<string, number>;
  drafts_ready: number;
  drafts_need_rewrite: number;
  draft_errors: number;
  pipeline_added: number;
  pipeline_already_present: number;
  quarantined_added: number;
  ledger_recorded: number;
  opt_outs_synced: number;
  /** Job URLs held back for a reason that can clear later (a check crashed). A later search may find them again. */
  retry_urls?: string[];
}

function tally<T>(items: T[], key: (t: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, i) => { acc[key(i)] = (acc[key(i)] ?? 0) + 1; return acc; }, {});
}

/** Held back only because something failed for the moment (a gate crashed, for example Gemini out of credits). */
export const RETRYABLE = new Set(["GATE_ERROR"]);

const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;

export async function runJobOutreach(out: JobSearchOutput, deps: JobOutreachDeps): Promise<JobOutreachResult> {
  const { cfg, ledger, gates, llm, gw, runId } = deps;
  const step = (stage: OutreachStage, message: string) => {
    logger.info({ stage, run_id: runId }, message);
    deps.onStep?.(stage, message);
  };
  checkJobsCampaign(cfg);
  const started = new Date().toISOString();

  // Anyone who opted out or bounced, in either pipeline, must be blocked at Gate 2 before we write again.
  step("syncing", "Reading opt-outs and bounces from the Sheet");
  const sync = await syncOptOuts(gw, ledger);

  const leads = jobsToLeads(out);
  step("verifying", `Checking ${n(leads.length, "contact")} through the 5 gates`);
  const verification = await verifyBatch(leads, cfg, ledger, gates);
  step("verifying", `Gates done: ${verification.passed.length} passed, ${verification.quarantined.length} to ${JOB_TABS.quarantined}`);

  step("drafting", `Writing ${n(verification.passed.length, "email")} with AI`);
  const drafts = verification.passed.length ? await draftAll(verification.passed, cfg, llm) : [];
  const ready = drafts.filter((d) => d.draft_status === "READY").length;
  step("drafting", `Drafts done: ${ready} ready, ${drafts.length - ready} need a rewrite or failed`);

  const report: RunReport = {
    run_id: runId,
    campaign: cfg.campaign_name,
    mode: cfg.mode,
    provider: "job_search",
    started_at: started,
    finished_at: new Date().toISOString(),
    counts: {
      rows_read: leads.length, skipped: 0, sourced: leads.length,
      passed: verification.passed.length, quarantined: verification.quarantined.length,
    },
    quarantined_by_reason: tally(verification.quarantined, (q) => q.result.failure_reason ?? "UNKNOWN"),
    skipped_by_reason: {},
    passed: verification.passed,
    quarantined: verification.quarantined,
    skipped: [],
    drafts,
    drafts_by_status: tally(drafts, (d) => d.draft_status),
  };

  step("exporting", `Writing to ${JOB_TABS.pipeline} and ${JOB_TABS.quarantined}`);
  const res = await exportToSheet(report, gw, JOB_TABS);
  const recorded = recordExported(report, res.exported, ledger);
  step("exporting", `${n(res.pipeline_added, "draft")} in ${JOB_TABS.pipeline} as "Ready for Review", ${res.quarantined_added} in ${JOB_TABS.quarantined}`);

  return {
    run_id: runId,
    campaign: cfg.campaign_name,
    tabs: JOB_TABS,
    contacts: leads.length,
    passed: verification.passed.length,
    quarantined: verification.quarantined.length,
    quarantined_by_reason: report.quarantined_by_reason,
    drafts_ready: ready,
    drafts_need_rewrite: drafts.filter((d) => d.draft_status === "NEEDS_REWRITE").length,
    draft_errors: drafts.filter((d) => d.draft_status === "DRAFT_ERROR").length,
    pipeline_added: res.pipeline_added,
    pipeline_already_present: res.pipeline_already_present,
    quarantined_added: res.quarantined_added,
    ledger_recorded: recorded,
    opt_outs_synced: sync.added,
    retry_urls: verification.quarantined
      .filter((q) => RETRYABLE.has(q.result.failure_reason ?? ""))
      .map((q) => q.lead.hiring_for?.url)
      .filter((u): u is string => Boolean(u)),
  };
}

/**
 * Runs the outreach for a finished search and attaches the result. If it fails (Sheet down, quota),
 * the jobs are kept and the error is recorded, so export_job_search can retry without searching again.
 */
export async function attachOutreach(out: JobSearchOutput, deps: JobOutreachDeps): Promise<JobSearchOutput> {
  const { outreach_error: _old, ...clean } = out;
  try {
    return { ...clean, outreach: await runJobOutreach(out, deps) };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ run_id: deps.runId, err: msg }, "job outreach failed");
    deps.onStep?.("exporting", `Outreach failed: ${msg}`);
    return { ...clean, outreach_error: msg };
  }
}

/** One line for chat and the CLI. */
export function formatOutreach(o: JobOutreachResult): string {
  return `${o.pipeline_added} draft(s) in ${o.tabs.pipeline} as "Ready for Review" (${o.drafts_ready} ready, ` +
    `${o.drafts_need_rewrite} need a rewrite), ${o.quarantined_added} in ${o.tabs.quarantined}. ` +
    `Set Status to Approved in ${o.tabs.pipeline} and AutoBooker sends them.`;
}
