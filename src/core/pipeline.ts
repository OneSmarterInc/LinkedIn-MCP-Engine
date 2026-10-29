import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CampaignConfig, LeadRecord } from "../config/schema.js";
import type { LLMProvider } from "../lib/llm/provider.js";
import type { Ledger } from "./db.js";
import { draftAll, type DraftedLead, type WriterOptions } from "./enricher.js";
import { sourceLeads, type SourceDeps, type SourceOptions, type SkippedRow } from "./sourcing.js";
import { verifyBatch, type AsyncGates, type Quarantined } from "./verifier.js";

export interface RunReport {
  run_id: string;
  campaign: string;
  mode: CampaignConfig["mode"];
  provider: string;
  started_at: string;
  finished_at: string;
  counts: { rows_read: number; skipped: number; sourced: number; passed: number; quarantined: number };
  quarantined_by_reason: Record<string, number>;
  skipped_by_reason: Record<string, number>;
  passed: LeadRecord[];
  quarantined: Quarantined[];
  skipped: SkippedRow[];
  /** Present after `run` (Phase 3). One draft per passed lead. */
  drafts?: DraftedLead[];
  drafts_by_status?: Record<string, number>;
}

function tally<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/** Source -> 5 gates -> report. Reads the ledger but does not write to it (Phase 4 does, on export). */
export async function runVerify(
  cfg: CampaignConfig,
  opts: SourceOptions,
  deps: SourceDeps & { ledger: Ledger; gates: AsyncGates },
): Promise<RunReport> {
  const started = new Date();
  const src = await sourceLeads(cfg, opts, deps);
  const { passed, quarantined } = await verifyBatch(src.leads, cfg, deps.ledger, deps.gates);

  return {
    run_id: `${started.toISOString().replace(/[:.]/g, "-")}`,
    campaign: cfg.campaign_name,
    mode: cfg.mode,
    provider: src.provider,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    counts: {
      rows_read: src.leads.length + src.skipped.length,
      skipped: src.skipped.length,
      sourced: src.leads.length,
      passed: passed.length,
      quarantined: quarantined.length,
    },
    quarantined_by_reason: tally(quarantined, (q) => q.result.failure_reason ?? "UNKNOWN"),
    skipped_by_reason: tally(src.skipped, (s) => s.reason),
    passed,
    quarantined,
    skipped: src.skipped,
  };
}

/** Source -> 5 gates -> draft an email for every lead that passed. */
export async function runAll(
  cfg: CampaignConfig,
  opts: SourceOptions,
  deps: SourceDeps & { ledger: Ledger; gates: AsyncGates; llm: LLMProvider; writer?: WriterOptions },
): Promise<RunReport> {
  const report = await runVerify(cfg, opts, deps);
  const drafts = await draftAll(report.passed, cfg, deps.llm, deps.writer);
  return {
    ...report,
    finished_at: new Date().toISOString(),
    drafts,
    drafts_by_status: tally(drafts, (d) => d.draft_status),
  };
}

/** A plain-text file for a person to read every draft quickly. */
export function formatDrafts(r: RunReport): string {
  const out: string[] = [`# Drafts: ${r.campaign}`, `Run ${r.run_id}`, ""];
  for (const d of r.drafts ?? []) {
    out.push(`## ${d.first_name} ${d.last_name}, ${d.title}, ${d.company_name}  [${d.draft_status}]`);
    out.push(`To: ${d.email}`);
    out.push(`Subject: ${d.email_subject}`, "", d.email_body, "");
    if (d.research_summary.length) out.push("Research:", ...d.research_summary.map((x) => `- ${x}`), "");
    if (d.draft_issues.length) out.push("Issues:", ...d.draft_issues.map((x) => `- ${x}`), "");
    out.push("---", "");
  }
  return out.join("\n");
}

export async function writeReport(report: RunReport, dir = "out"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `run-${report.run_id}.json`);
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
  if (report.drafts) await writeFile(join(dir, `drafts-${report.run_id}.md`), formatDrafts(report), "utf8");
  return path;
}

export function formatSummary(r: RunReport): string {
  const line = (label: string, n: number) => `  ${label.padEnd(28, ".")} ${n}`;
  const parts = [
    `Campaign: ${r.campaign}  (${r.mode})`,
    `Source:   ${r.provider}`,
    "",
    line("Rows read", r.counts.rows_read),
    line("Skipped at import", r.counts.skipped),
    ...Object.entries(r.skipped_by_reason).map(([k, v]) => line(`    ${k}`, v)),
    line("Sent to the 5 gates", r.counts.sourced),
    line("PASSED", r.counts.passed),
    line("QUARANTINED", r.counts.quarantined),
    ...Object.entries(r.quarantined_by_reason).map(([k, v]) => line(`    ${k}`, v)),
    ...(r.drafts
      ? [line("DRAFTED", r.drafts.length), ...Object.entries(r.drafts_by_status ?? {}).map(([k, v]) => line(`    ${k}`, v))]
      : []),
  ];
  return parts.join("\n");
}
