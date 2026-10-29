import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CampaignConfig, LeadRecord } from "../config/schema.js";
import type { Ledger } from "./db.js";
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

export async function writeReport(report: RunReport, dir = "out"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `run-${report.run_id}.json`);
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
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
  ];
  return parts.join("\n");
}
