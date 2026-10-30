
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { CampaignConfig } from "../config/schema.js";
import type { SourceResult } from "../core/sources/types.js";
import type { VerifyOutput } from "../core/verifier.js";
import type { DraftedLead } from "../core/enricher.js";

export type McpRunStatus = "SOURCED" | "VERIFIED" | "DRAFTED";

export interface McpRunState {
  run_id: string;
  status: McpRunStatus;
  campaign_path: string;
  config: CampaignConfig;
  source: SourceResult;
  verification?: VerifyOutput;
  drafts?: DraftedLead[];
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
    !["SOURCED", "VERIFIED", "DRAFTED"].includes(state.status) ||
    !state.source ||
    !Array.isArray(state.source.leads)
  ) {
    throw new Error(`Stored run ${runId} has an invalid structure.`);
  }

  return state;
}
