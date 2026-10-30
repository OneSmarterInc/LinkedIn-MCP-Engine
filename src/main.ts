import "dotenv/config";
import { Command, Option } from "commander";
import { loadCampaign } from "./config/load.js";
import { openLedger } from "./core/db.js";
import { buildAsyncGates } from "./core/gates/index.js";
import { exportToSheet, exportToXlsx, formatExportSummary, recordExported } from "./core/exporter.js";
import { formatSummary, runAll, runVerify, writeReport, type RunReport } from "./core/pipeline.js";
import type { Ledger } from "./core/db.js";
import { getSearch } from "./lib/search/index.js";
import { getLLM } from "./lib/llm/index.js";

type ExportTarget = "none" | "sheet" | "xlsx" | "both";

/**
 * Sends a finished run to the Google Sheet and/or a local Excel file.
 * Leads are recorded in the ledger (so they are never contacted twice) only after the main target succeeds.
 * If the Sheet fails, an Excel copy is still written, but nothing is recorded, so the run can simply be repeated.
 */
async function exportRun(target: ExportTarget, report: RunReport, ledger: Ledger, outDir: string): Promise<void> {
  if (target === "none") return;
  const wantSheet = target === "sheet" || target === "both";
  let sheetOk = false;

  if (wantSheet) {
    try {
      const { createSheetsGateway } = await import("./lib/google/sheets.js");
      const res = await exportToSheet(report, createSheetsGateway());
      const recorded = recordExported(report, res.exported, ledger);
      console.log("");
      console.log(formatExportSummary(res, recorded));
      sheetOk = true;
    } catch (err) {
      process.exitCode = 1;
      console.error(`\nGoogle Sheet export FAILED: ${(err as Error).message}`);
      console.error("Nothing was recorded in the ledger, so you can fix the problem and run again.");
    }
  }

  if (target === "xlsx" || target === "both" || (wantSheet && !sheetOk)) {
    try {
      const res = await exportToXlsx(report, outDir);
      const recorded = target === "xlsx" ? recordExported(report, res.exported, ledger) : 0;
      console.log("");
      console.log(formatExportSummary(res, recorded));
    } catch (err) {
      process.exitCode = 1;
      console.error(`\nExcel export FAILED: ${(err as Error).message}`);
    }
  }
}

const program = new Command()
  .name("linkedin-mcp-engine")
  .description("Source leads, run the 5 verification gates, and report the results.");

program
  .command("info")
  .description("Load a campaign file and print its settings")
  .requiredOption("-c, --campaign <path>", "path to campaign JSON")
  .action(async (o: { campaign: string }) => {
    const c = await loadCampaign(o.campaign);
    console.log(`Campaign: ${c.campaign_name}`);
    console.log(`Mode: ${c.mode} | Provider: ${c.sourcing_provider}`);
    console.log(`Titles: ${c.decision_maker_titles.join(", ")}`);
    console.log(`Geography: ${c.target_geography.join(", ")}`);
  });

program
  .command("ping")
  .description("Send one tiny request to the configured LLM and report how long it took")
  .action(async () => {
    const llm = getLLM();
    const model = llm.name === "gemini" ? process.env.GEMINI_MODEL || "gemini-3.8-flash" : process.env.OLLAMA_MODEL;
    console.log(`Pinging ${llm.name} (${model})...`);
    const t = Date.now();
    try {
      const reply = await llm.generateText("Reply with the single word: ok", { thinking: "low" });
      console.log(`OK in ${((Date.now() - t) / 1000).toFixed(1)} s. Reply: ${reply.trim().slice(0, 40)}`);
    } catch (err) {
      console.log(`FAILED after ${((Date.now() - t) / 1000).toFixed(1)} s: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("verify")
  .description("Source leads (CSV or search) and run them through all 5 gates")
  .requiredOption("-c, --campaign <path>", "path to campaign JSON")
  .option("--csv <path>", "CSV or XLSX lead file (overrides the campaign's sourcing_provider)")
  .option("-l, --limit <n>", "max leads to source", "50")
  .option("-o, --out <dir>", "folder for the JSON report", "out")
  .action(async (o: { campaign: string; csv?: string; limit: string; out: string }) => {
    const cfg = await loadCampaign(o.campaign);
    const ledger = openLedger();
    try {
      console.log(`Running... (LLM: ${process.env.LLM_PROVIDER ?? "ollama"}, mailbox: ${process.env.MAILBOX_VERIFIER ?? "zerobounce"})`);
      const gates = buildAsyncGates(cfg);
      const report = await runVerify(
        cfg,
        { limit: Number(o.limit), csvPath: o.csv },
        { ledger, gates, ...(o.csv ? {} : { search: getSearch(process.env, gates.llm) }) },
      );
      const path = await writeReport(report, o.out);
      console.log("");
      console.log(formatSummary(report));
      console.log("");
      console.log(`Report saved: ${path}`);
    } finally {
      ledger.close();
    }
  });

program
  .command("run")
  .description("Source leads, run all 5 gates, and draft an email for every lead that passes")
  .requiredOption("-c, --campaign <path>", "path to campaign JSON")
  .option("--csv <path>", "CSV or XLSX lead file (overrides the campaign's sourcing_provider)")
  .option("-l, --limit <n>", "max leads to source", "50")
  .option("-o, --out <dir>", "folder for the reports", "out")
  .option("--show <n>", "drafts to print on screen", "3")
  .addOption(
    new Option("--export <target>", "also send the result to the Google Sheet (sheet), an Excel file (xlsx), or both")
      .choices(["none", "sheet", "xlsx", "both"])
      .default("none"),
  )
  .action(async (o: { campaign: string; csv?: string; limit: string; out: string; show: string; export: ExportTarget }) => {
    const cfg = await loadCampaign(o.campaign);
    const ledger = openLedger();
    try {
      console.log(`Running... (LLM: ${process.env.LLM_PROVIDER ?? "ollama"}, mailbox: ${process.env.MAILBOX_VERIFIER ?? "zerobounce"})`);
      const gates = buildAsyncGates(cfg);
      const report = await runAll(
        cfg,
        { limit: Number(o.limit), csvPath: o.csv },
        {
          ledger, gates, llm: gates.llm,
          writer: { concurrency: Number(process.env.DRAFT_CONCURRENCY ?? 3) },
          ...(o.csv ? {} : { search: getSearch(process.env, gates.llm) }),
        },
      );
      const path = await writeReport(report, o.out);
      console.log("");
      console.log(formatSummary(report));
      for (const d of (report.drafts ?? []).slice(0, Number(o.show))) {
        console.log(`\n--- ${d.first_name} ${d.last_name} <${d.email}>  [${d.draft_status}]`);
        console.log(`Subject: ${d.email_subject}\n`);
        console.log(d.email_body);
        if (d.draft_issues.length) console.log(`Issues: ${d.draft_issues.join("; ")}`);
      }
      console.log("");
      console.log(`Report saved: ${path}`);
      console.log(`Drafts saved: ${path.replace(/run-([^/\\]+)\.json$/, "drafts-$1.md")}`);
      await exportRun(o.export, report, ledger, o.out);
    } finally {
      ledger.close();
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
