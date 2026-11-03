import type { McpRunState } from "./run-store.js";

/** One lead in a run, in plain words: who it is, which email, and what happened to it. */
export interface LeadView {
  lead_id: string;
  name: string;
  title: string;
  company: string;
  company_domain?: string;
  location: string;
  linkedin_url?: string;
  email?: string;
  email_source?: string;
  /** PASSED, NOT VERIFIED YET, or "FAILED gate 3: DOMAIN_MISMATCH". */
  result: string;
  draft_status?: string;
  email_subject?: string;
  email_body?: string;
  draft_issues?: string[];
}

export interface RunView {
  run_id: string;
  status: string;
  campaign: string;
  provider: string;
  /** Shown while sourcing runs in the background. */
  message?: string;
  /** Why the run FAILED. */
  error?: string;
  created_at: string;
  updated_at: string;
  counts: { sourced: number; with_email: number; skipped: number; passed?: number; failed?: number; drafted?: number };
  leads: LeadView[];
  skipped: McpRunState["source"]["skipped"];
}

/**
 * Builds a readable view of a stored run. Uses the cleaned lead from verification when there is one,
 * so the email shown is the one the gates checked.
 */
export function viewRun(state: McpRunState, opts: { includeBodies?: boolean; now?: Date } = {}): RunView {
  const passed = new Map((state.verification?.passed ?? []).map((l) => [l.lead_id, l]));
  const failed = new Map((state.verification?.quarantined ?? []).map((q) => [q.lead.lead_id, q]));
  const drafts = new Map((state.drafts ?? []).map((d) => [d.lead_id, d]));

  const leads = state.source.leads.map((raw): LeadView => {
    const q = failed.get(raw.lead_id);
    const lead = passed.get(raw.lead_id) ?? q?.lead ?? raw;
    const d = drafts.get(raw.lead_id);

    let result = "NOT VERIFIED YET";
    if (passed.has(raw.lead_id)) result = "PASSED";
    else if (q) result = `FAILED gate ${q.result.failed_gate ?? "?"}: ${q.result.failure_reason ?? "UNKNOWN"}`;

    return {
      lead_id: lead.lead_id,
      name: `${lead.first_name} ${lead.last_name}`.trim(),
      title: lead.title,
      company: lead.company_name,
      company_domain: lead.company_domain,
      location: lead.location,
      linkedin_url: lead.linkedin_url,
      email: lead.email,
      email_source: lead.email_source,
      result,
      ...(d
        ? {
            draft_status: d.draft_status,
            email_subject: d.email_subject,
            ...(opts.includeBodies ? { email_body: d.email_body } : {}),
            ...(d.draft_issues.length ? { draft_issues: d.draft_issues } : {}),
          }
        : {}),
    };
  });

  const secs = Math.round(((opts.now ?? new Date()).getTime() - new Date(state.created_at).getTime()) / 1000);
  return {
    run_id: state.run_id,
    status: state.status,
    campaign: state.config.campaign_name,
    provider: state.source.provider,
    ...(state.status === "SOURCING" ? { message: `Still sourcing, ${secs}s so far. Check again in 20-30 seconds.` } : {}),
    ...(state.error ? { error: state.error } : {}),
    created_at: state.created_at,
    updated_at: state.updated_at,
    counts: {
      sourced: state.source.leads.length,
      with_email: state.source.leads.filter((l) => l.email).length,
      skipped: state.source.skipped.length,
      ...(state.verification
        ? { passed: state.verification.passed.length, failed: state.verification.quarantined.length }
        : {}),
      ...(state.drafts ? { drafted: state.drafts.length } : {}),
    },
    leads,
    skipped: state.source.skipped,
  };
}
