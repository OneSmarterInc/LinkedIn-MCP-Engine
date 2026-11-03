import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

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
  created_at: string;
  updated_at: string;
  counts: { sourced: number; passed?: number; failed?: number; drafted?: number };
  leads: LeadView[];
}

/**
 * Builds a readable view of a stored run. Uses the cleaned lead from verification when there is one,
 * so the email shown is the one the gates checked.
 */
export function viewRun(state: McpRunState, opts: { includeBodies?: boolean } = {}): RunView {
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

  return {
    run_id: state.run_id,
    status: state.status,
    campaign: state.config.campaign_name,
    created_at: state.created_at,
    updated_at: state.updated_at,
    counts: {
      sourced: state.source.leads.length,
      ...(state.verification
        ? { passed: state.verification.passed.length, failed: state.verification.quarantined.length }
        : {}),
      ...(state.drafts ? { drafted: state.drafts.length } : {}),
    },
    leads,
  };
}

/** Run IDs in out/mcp-runs, newest first. */
export async function listRunIds(limit = 10, dir = resolve(process.cwd(), "out", "mcp-runs")): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const runs = names.filter((n) => /^mcp-[0-9a-f-]{36}\.json$/i.test(n));
  const withTime = await Promise.all(
    runs.map(async (n) => ({ id: n.slice(0, -5), t: (await stat(resolve(dir, n))).mtimeMs })),
  );
  return withTime.sort((a, b) => b.t - a.t).slice(0, limit).map((r) => r.id);
}
