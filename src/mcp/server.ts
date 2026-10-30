import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadCampaign } from "../config/load.js";
import { openLedger } from "../core/db.js";
import { buildAsyncGates } from "../core/gates/index.js";
import { draftAll } from "../core/enricher.js";
import { sourceLeads } from "../core/sourcing.js";
import { verifyBatch } from "../core/verifier.js";
import { getLLM } from "../lib/llm/index.js";
import { getSearch } from "../lib/search/index.js";

import {
  createRunId,
  loadRunState,
  saveRunState
} from "./run-store.js";

const server = new McpServer({
  name: "linkedin-mcp-engine",
  version: "1.0.0"
});

const ledger = openLedger();

function success(data: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(data, null, 2)
    }]
  };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: error instanceof Error ? error.message : String(error)
    }]
  };
}

// TOOL 1: SOURCE LEADS
server.registerTool(
  "source_leads",
  {
    description: "Source leads using an existing campaign configuration and create a persistent run.",
    inputSchema: {
      campaign_path: z.string().min(1),
      csv_path: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional()
    }
  },
  async ({ campaign_path, csv_path, limit }) => {
    try {
      const cfg = await loadCampaign(campaign_path);
      const effectiveCsv = csv_path ??
        (cfg.sourcing_provider === "csv_import" ? cfg.csv_path : undefined);

      const llm = getLLM(process.env);

      const source = await sourceLeads(
        cfg,
        {
          limit: limit ?? 50,
          csvPath: csv_path
        },
        {
          ...(!effectiveCsv && cfg.sourcing_provider === "gemini_xray"
            ? { search: getSearch(process.env, llm) }
            : {})
        }
      );

      const runId = createRunId();
      const now = new Date().toISOString();

      await saveRunState({
        run_id: runId,
        status: "SOURCED",
        campaign_path,
        config: cfg,
        source,
        created_at: now,
        updated_at: now
      });

      return success({
        run_id: runId,
        status: "SOURCED",
        provider: source.provider,
        leads_found: source.leads.length,
        skipped: source.skipped.length
      });
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL 2: VERIFY LEADS
server.registerTool(
  "verify_leads",
  {
    description: "Run sourced leads through all five existing verification gates.",
    inputSchema: {
      run_id: z.string().min(1)
    }
  },
  async ({ run_id }) => {
    try {
      const state = await loadRunState(run_id);

      if (state.status !== "SOURCED") {
        throw new Error(`Verification requires SOURCED status. Current status: ${state.status}`);
      }

      const gates = buildAsyncGates(state.config);

      const verification = await verifyBatch(
        state.source.leads,
        state.config,
        ledger,
        gates
      );

      state.verification = verification;
      state.status = "VERIFIED";
      state.updated_at = new Date().toISOString();

      await saveRunState(state);

      return success({
        run_id,
        status: state.status,
        passed: verification.passed.length,
        quarantined: verification.quarantined.length,
        quarantined_by_reason: verification.quarantined.reduce(
          (result, item) => {
            const reason = item.result.failure_reason ?? "UNKNOWN";
            result[reason] = (result[reason] ?? 0) + 1;
            return result;
          },
          {} as Record<string, number>
        )
      });
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL 3: DRAFT EMAILS
server.registerTool(
  "draft_emails",
  {
    description: "Generate email drafts only for leads that passed all five verification gates.",
    inputSchema: {
      run_id: z.string().min(1),
      concurrency: z.number().int().min(1).max(10).optional()
    }
  },
  async ({ run_id, concurrency }) => {
    try {
      const state = await loadRunState(run_id);

      if (state.status !== "VERIFIED" || !state.verification) {
        throw new Error("Leads must pass verification before email drafting.");
      }

      const drafts = await draftAll(
        state.verification.passed,
        state.config,
        getLLM(process.env),
        { concurrency: concurrency ?? 3 }
      );

      state.drafts = drafts;
      state.status = "DRAFTED";
      state.updated_at = new Date().toISOString();

      await saveRunState(state);

      return success({
        run_id,
        status: state.status,
        total_drafts: drafts.length,
        ready: drafts.filter(d => d.draft_status === "READY").length,
        needs_rewrite: drafts.filter(d => d.draft_status === "NEEDS_REWRITE").length,
        errors: drafts.filter(d => d.draft_status === "DRAFT_ERROR").length,
        drafts
      });
    } catch (error) {
      return failure(error);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error("MCP server startup failed:", error);
  ledger.close();
  process.exit(1);
});

process.on("SIGINT", () => {
  ledger.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  ledger.close();
  process.exit(0);
});
