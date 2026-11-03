
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { CampaignConfig } from "../config/schema.js";
import type { SourceResult } from "../core/sources/types.js";
import type { VerifyOutput } from "../core/verifier.js";
import type { DraftedLead } from "../core/enricher.js";

export type McpRunStatus = "SOURCING" | "SOURCED" | "VERIFIED" | "DRAFTED" | "EXPORTED" | "FAILED";

export interface McpRunState {
  run_id: string;
  status: McpRunStatus;
  campaign_path: string;
  config: CampaignConfig;
  source: SourceResult;
  verification?: VerifyOutput;
  drafts?: DraftedLead[];
  exported_at?: string;
  /** Set when status is FAILED. */
  error?: string;
  created_at: string;
  updated_at: string;
}

const RUNS_DIR = resolve(process.cwd(), "out", "mcp-runs");

export function createRunId(): string {
  return `mcp-${randomUUID()}`;
}

function getRunPath(runId: string): string {
  if (!/^mcp-[0-9a-f-]{36}$/i.test(runId)) {
    throw new Error("Invalid MCP run ID.");
  }

  return resolve(RUNS_DIR, `${runId}.json`);
}

export async function saveRunState(state: McpRunState): Promise<void> {
  const target = getRunPath(state.run_id);

  await mkdir(RUNS_DIR, { recursive: true });

  const temporary = `${target}.${randomUUID()}.tmp`;

  await writeFile(
    temporary,
    JSON.stringify(state, null, 2),
    "utf8"
  );

  await rename(temporary, target);
}

export async function loadRunState(
  runId: string
): Promise<McpRunState> {
  const path = getRunPath(runId);

  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Run ${runId} not found. Call source_leads first.`);
    }

    throw error;
  }

  let state: McpRunState;

  try {
    state = JSON.parse(raw) as McpRunState;
  } catch {
    throw new Error(`Stored run ${runId} contains invalid JSON.`);
  }

  if (
    state.run_id !== runId ||
    !["SOURCING", "SOURCED", "VERIFIED", "DRAFTED", "EXPORTED", "FAILED"].includes(state.status) ||
    !state.source ||
    !Array.isArray(state.source.leads)
  ) {
    throw new Error(`Stored run ${runId} has an invalid structure.`);
  }

  return state;
}

export interface McpRunSummary {
  run_id: string;
  status: McpRunStatus;
  campaign: string;
  leads: number;
  passed?: number;
  drafts?: number;
  created_at: string;
  updated_at: string;
}

/** Newest first. Reads only the fields a person needs to pick a run. */
export async function listRuns(limit = 10): Promise<McpRunSummary[]> {
  let files: string[] = [];
  try { files = (await readdir(RUNS_DIR)).filter((f) => /^mcp-[0-9a-f-]{36}\.json$/i.test(f)); } catch { return []; }
  const out: McpRunSummary[] = [];
  for (const f of files) {
    try {
      const st = JSON.parse(await readFile(resolve(RUNS_DIR, f), "utf8")) as McpRunState;
      out.push({
        run_id: st.run_id, status: st.status, campaign: st.config?.campaign_name ?? "?",
        leads: st.source?.leads?.length ?? 0, passed: st.verification?.passed.length, drafts: st.drafts?.length,
        created_at: st.created_at, updated_at: st.updated_at,
      });
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}
