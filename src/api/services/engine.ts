import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadCampaign } from "../../config/load.js";
import type { CampaignConfig } from "../../config/schema.js";
import type { Ledger } from "../../core/db.js";
import { buildAsyncGates } from "../../core/gates/index.js";
import { draftAll } from "../../core/enricher.js";
import { sourceLeads } from "../../core/sourcing.js";
import { verifyBatch } from "../../core/verifier.js";
import { exportToSheet, recordExported, type SheetsGateway } from "../../core/exporter.js";
import type { RunReport } from "../../core/pipeline.js";
import { getLLM } from "../../lib/llm/index.js";
import { getSearch } from "../../lib/search/index.js";
import { GeminiProvider } from "../../lib/llm/gemini.js";
import { geminiOptions } from "../../lib/llm/index.js";
import {
  JOB_SEARCH_DEFAULTS, latestJobSearchId, loadJobSearchRecord, loadSeenJobs, searchJobs, startJobSearch, type JobSearchRecord,
} from "../../core/jobs/job-search.js";
import { jobSpyOptionsFromEnv, useJobSpy } from "../../core/jobs/jobspy.js";
import { DEFAULT_JOBS_CAMPAIGN, attachOutreach, type JobOutreachDeps } from "../../core/jobs/job-outreach.js";
import { createRunId, listRuns, loadRunState, saveRunState, type McpRunState } from "../../mcp/run-store.js";
import { viewRun } from "../../mcp/run-view.js";
import { acquireLock, lockDir } from "../../core/locks.js";
import { syncOptOuts } from "../../core/optout-sync.js";

/**
 * The engine, as the API sees it. Every function here calls the same src/core code the MCP server and the CLI use.
 * Long work runs in the background and is polled; nothing here blocks an HTTP request for more than a moment.
 */

export interface EngineDeps {
  gw: () => SheetsGateway;
  ledger: Ledger;
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Job search (search_jobs + outreach), same path as the MCP tool
// ---------------------------------------------------------------------------

async function jobsCampaign(env: NodeJS.ProcessEnv): Promise<CampaignConfig> {
  const ref = env.JOBS_CAMPAIGN?.trim() || DEFAULT_JOBS_CAMPAIGN;
  if (!env.GOOGLE_SHEET_ID?.trim()) throw new Error("GOOGLE_SHEET_ID must be set in .env for job outreach.");
  try {
    return await loadCampaign(ref);
  } catch (error) {
    throw new Error(`Job outreach needs a campaign named "${ref}" in the Campaigns tab (offer, sender company, persona). ${(error as Error).message}`);
  }
}

/**
 * One job search at a time, across the API, the MCP server and the CLI (a file lock in out/locks; see core/locks.ts).
 * A second search would spend Seamless credits twice and write duplicate rows. The lock is released when the
 * background search ends, or at once when the start itself fails.
 */
export async function startSearch(deps: EngineDeps): Promise<{ search_id: string; campaign: string }> {
  const release = await acquireLock("job-search", { dir: lockDir(deps.env ?? process.env), label: "api" });
  let handedOff = false;
  try {
    return await startSearchNow(deps, () => { handedOff = true; }, () => { void release(); });
  } finally {
    if (!handedOff) await release();
  }
}

async function startSearchNow(deps: EngineDeps, onStarted: () => void, onFinished: () => void): Promise<{ search_id: string; campaign: string }> {
  const env = deps.env ?? process.env;
  const key = env.GEMINI_API_KEY?.trim();
  if (!key) throw Object.assign(new Error("GEMINI_API_KEY is empty in .env."), { statusCode: 400 });
  const llm = new GeminiProvider(geminiOptions(env, key));
  // With JobSpy finding the jobs, Gemini only checks leads (gate 4) and writes drafts, so Google Search grounding is not needed.
  const jobspy = useJobSpy(env) ? { opts: jobSpyOptionsFromEnv(env) } : undefined;
  if (!jobspy && !llm.supportsGrounding) throw Object.assign(new Error("Set GEMINI_GROUNDING=true (needs billing) for job search, or set JOB_SEARCH_SOURCE=jobspy."), { statusCode: 400 });
  const cfg = await jobsCampaign(env);
  const seamlessKey = env.SEAMLESS_API_KEY?.trim();

  // The run starts inside startJobSearch; from then on, the run itself clears the lock when it ends.
  const { record } = await startJobSearch(async (onProgress, searchId) => {
    onStarted();
    try {
      const out = await searchJobs({ llm, onProgress, seen: await loadSeenJobs(), ...(jobspy ? { jobspy } : {}), ...(seamlessKey ? { seamless: { apiKey: seamlessKey } } : {}) });
      const onStep: JobOutreachDeps["onStep"] = (stage, message) => onProgress({
        stage, message, searches_done: out.searches, searches_max: out.searches,
        jobs_found: out.total, with_email: out.with_email, lookups_used: out.seamless_lookups_used, jobs: out.jobs,
      });
      return await attachOutreach(out, { cfg, ledger: deps.ledger, runId: searchId, onStep, gates: buildAsyncGates(cfg), llm: getLLM(env), gw: deps.gw() });
    } finally {
      onFinished();
    }
  });
  return { search_id: record.search_id, campaign: cfg.campaign_name };
}

export async function getSearch_(id?: string): Promise<JobSearchRecord> {
  const sid = id ?? (await latestJobSearchId());
  if (!sid) throw Object.assign(new Error("No job search yet."), { statusCode: 404 });
  return loadJobSearchRecord(sid);
}

const JOBS_DIR = resolve(process.cwd(), "out", "job-searches");
export async function listSearches(limit = 10): Promise<Array<Pick<JobSearchRecord, "search_id" | "status" | "started_at" | "updated_at"> & { total?: number; with_email?: number; drafts?: number }>> {
  let files: string[] = [];
  try { files = (await readdir(JOBS_DIR)).filter((f) => /^jobs-[0-9a-f-]{36}\.json$/i.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const r = JSON.parse(await readFile(resolve(JOBS_DIR, f), "utf8")) as JobSearchRecord & { result?: { total?: number; with_email?: number; outreach?: { pipeline_added?: number } } };
      out.push({ search_id: r.search_id, status: r.status, started_at: r.started_at, updated_at: r.updated_at, total: r.result?.total, with_email: r.result?.with_email, drafts: r.result?.outreach?.pipeline_added });
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit);
}

export const searchDefaults = JOB_SEARCH_DEFAULTS;

// ---------------------------------------------------------------------------
// Campaign run: source -> 5 gates -> draft -> export, in the background
// ---------------------------------------------------------------------------

type Status = McpRunState["status"];

/**
 * One campaign run at a time (file lock "campaign-run"), for the same reason as job search: a double click or a
 * retry must not source, verify and draft the same people twice. The lock is held until the background work ends.
 */
export async function startRun(deps: EngineDeps, campaign: string, limit = 10, doExport = true): Promise<{ run_id: string; campaign: string }> {
  const env = deps.env ?? process.env;
  const release = await acquireLock("campaign-run", { dir: lockDir(env), label: "api" });
  try {
    return await startRunNow(deps, campaign, limit, doExport, release);
  } catch (err) {
    await release();
    throw err;
  }
}

async function startRunNow(deps: EngineDeps, campaign: string, limit: number, doExport: boolean, release: () => Promise<void>): Promise<{ run_id: string; campaign: string }> {
  const env = deps.env ?? process.env;
  const cfg = await loadCampaign(campaign);
  const runId = createRunId();
  const now = new Date().toISOString();
  await saveRunState({ run_id: runId, status: "SOURCING", campaign_path: campaign, config: cfg, source: { provider: "pending", leads: [], skipped: [] }, created_at: now, updated_at: now });

  const set = async (status: Status, patch: Partial<McpRunState> = {}) => {
    const st = await loadRunState(runId);
    Object.assign(st, patch, { status, updated_at: new Date().toISOString() });
    await saveRunState(st);
    return st;
  };

  void (async () => {
    try {
      const llm = getLLM(env);
      const source = await sourceLeads(cfg, { limit }, { ...(cfg.sourcing_provider === "gemini_xray" ? { search: getSearch(env, llm) } : {}) });
      await set("SOURCED", { source });
      // Anyone marked Opted Out, Unsubscribed, Do Not Contact or Bounced in the Sheet (by AutoBooker or by hand) must be
      // in the ledger before Gate 2 runs, the same as the CLI and the job search do. If the Sheet cannot be read, the run
      // stops: not emailing anyone is safer than emailing someone who asked us to stop.
      try {
        await syncOptOuts(deps.gw(), deps.ledger);
      } catch (err) {
        throw new Error(`Could not read opt-outs from the Google Sheet, so the run was stopped: ${(err as Error).message}`);
      }
      const gates = buildAsyncGates(cfg, env, llm);
      const verification = await verifyBatch(source.leads, cfg, deps.ledger, gates);
      await set("VERIFIED", { verification });
      const drafts = await draftAll(verification.passed, cfg, llm, { concurrency: Number(env.DRAFT_CONCURRENCY ?? 3) });
      await set("DRAFTED", { drafts });
      if (!doExport) return;
      const st = await loadRunState(runId);
      const tally = <T,>(items: T[], key: (t: T) => string) => items.reduce<Record<string, number>>((a, i) => { a[key(i)] = (a[key(i)] ?? 0) + 1; return a; }, {});
      const report: RunReport = {
        run_id: runId, campaign: cfg.campaign_name, mode: cfg.mode, provider: source.provider, started_at: st.created_at, finished_at: new Date().toISOString(),
        counts: { rows_read: source.leads.length + source.skipped.length, skipped: source.skipped.length, sourced: source.leads.length, passed: verification.passed.length, quarantined: verification.quarantined.length },
        quarantined_by_reason: tally(verification.quarantined, (q) => q.result.failure_reason ?? "UNKNOWN"),
        skipped_by_reason: tally(source.skipped, (r) => r.reason),
        passed: verification.passed, quarantined: verification.quarantined, skipped: source.skipped, drafts, drafts_by_status: tally(drafts, (d) => d.draft_status),
      };
      const res = await exportToSheet(report, deps.gw());
      recordExported(report, res.exported, deps.ledger);
      await set("EXPORTED", { drafts, exported_at: new Date().toISOString() } as Partial<McpRunState>);
    } catch (err) {
      try { await set("FAILED", { error: (err as Error).message } as Partial<McpRunState>); } catch { /* nothing more to do */ }
    } finally {
      await release();
    }
  })();

  return { run_id: runId, campaign: cfg.campaign_name };
}

export async function getRun(id: string, includeBodies = false) {
  return viewRun(await loadRunState(id), { includeBodies });
}

export { listRuns };
