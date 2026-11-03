
import "dotenv/config";
import { Command, Option } from "commander";
import { defaultSheetsGateway, loadCampaign } from "./config/load.js";
import { fileCampaignStore, sheetCampaignStore, type CampaignSummary } from "./config/store.js";
import { openLedger } from "./core/db.js";
import { buildAsyncGates } from "./core/gates/index.js";
import {
  exportToSheet,
  exportToXlsx,
  formatExportSummary,
  recordExported,
} from "./core/exporter.js";
import {
  formatSummary,
  runAll,
  runVerify,
  writeReport,
  type RunReport,
} from "./core/pipeline.js";
import type { Ledger } from "./core/db.js";
import { getSearch } from "./lib/search/index.js";
import { getLLM } from "./lib/llm/index.js";
import { formatOptOutSync, syncOptOuts } from "./core/optout-sync.js";
import { latestJobSearchId, loadJobSearchRecord, saveJobSearchRecord } from "./core/jobs/job-search.js";
import { exportJobsToSheet, formatJobsExport } from "./core/jobs/jobs-exporter.js";

type ExportTarget = "none" | "sheet" | "xlsx" | "both";

/**
 * Sends a finished run to the Google Sheet and/or a local Excel file.
 * Leads are recorded in the ledger only after the main target succeeds.
 * If the Sheet fails, an Excel copy is still written, but nothing is recorded,
 * so the run can simply be repeated.
 */
async function exportRun(
  target: ExportTarget,
  report: RunReport,
  ledger: Ledger,
  outDir: string,
): Promise<void> {
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
      console.error(
        `\nGoogle Sheet export FAILED: ${(err as Error).message}`,
      );
      console.error(
        "Nothing was recorded in the ledger, so you can fix the problem and run again.",
      );
    }
  }

  if (
    target === "xlsx" ||
    target === "both" ||
    (wantSheet && !sheetOk)
  ) {
    try {
      const res = await exportToXlsx(report, outDir);
      const recorded =
        target === "xlsx"
          ? recordExported(report, res.exported, ledger)
          : 0;

      console.log("");
      console.log(formatExportSummary(res, recorded));
    } catch (err) {
      process.exitCode = 1;
      console.error(`\nExcel export FAILED: ${(err as Error).message}`);
    }
  }
}

/**
 * Pulls opt-outs from the Google Sheet into the ledger before any leads are checked.
 * Runs only when a Sheet is configured. If the Sheet cannot be read, it throws,
 * so the run stops instead of possibly emailing someone who said stop.
 */
async function syncOptOutsIfConfigured(ledger: Ledger, skip: boolean): Promise<void> {
  if (skip) {
    console.log("Opt-out sync SKIPPED (--skip-optout-sync).");
    return;
  }
  if (!process.env.GOOGLE_SHEET_ID) return;
  const { createSheetsGateway } = await import("./lib/google/sheets.js");
  try {
    console.log(formatOptOutSync(await syncOptOuts(createSheetsGateway(), ledger)));
  } catch (err) {
    throw new Error(
      `Could not read opt-outs from the Google Sheet, so the run was stopped: ${(err as Error).message}\n` +
      "Fix the Sheet connection, or rerun with --skip-optout-sync if you are sure no one has opted out.",
    );
  }
}

const program = new Command()
  .name("linkedin-mcp-engine")
  .description(
    "Source leads, run the 5 verification gates, and report the results.",
  );

program
  .command("info")
  .description("Load a campaign file and print its settings")
  .requiredOption("-c, --campaign <ref>", "campaign JSON path, or the Name of a row in the Sheet's Campaigns tab")
  .action(async (o: { campaign: string }) => {
    const c = await loadCampaign(o.campaign);

    console.log(`Campaign: ${c.campaign_name}`);
    console.log(`Mode: ${c.mode} | Provider: ${c.sourcing_provider}`);
    console.log(`Titles: ${c.decision_maker_titles.join(", ")}`);
    console.log(`Geography: ${c.target_geography.join(", ")}`);
  });

program
  .command("ping")
  .description(
    "Send one tiny request to the configured LLM and report how long it took",
  )
  .action(async () => {
    const llm = getLLM();

    const model =
      llm.name === "gemini"
        ? process.env.GEMINI_MODEL || "gemini-3.8-flash"
        : process.env.OLLAMA_MODEL;

    console.log(`Pinging ${llm.name} (${model})...`);

    const t = Date.now();

    try {
      const reply = await llm.generateText(
        "Reply with the single word: ok",
        { thinking: "low" },
      );

      console.log(
        `OK in ${((Date.now() - t) / 1000).toFixed(1)} s. Reply: ${reply
          .trim()
          .slice(0, 40)}`,
      );
    } catch (err) {
      console.log(
        `FAILED after ${((Date.now() - t) / 1000).toFixed(1)} s: ${(err as Error).message}`,
      );
      process.exitCode = 1;
    }
  });

program
  .command("sync-optouts")
  .description("Copy Opted Out / Bounced rows from the Google Sheet into the ledger's do-not-contact list")
  .action(async () => {
    if (!process.env.GOOGLE_SHEET_ID) throw new Error("GOOGLE_SHEET_ID is empty, so there is no Sheet to read.");
    const ledger = openLedger();
    try {
      const { createSheetsGateway } = await import("./lib/google/sheets.js");
      const r = await syncOptOuts(createSheetsGateway(), ledger);
      console.log(formatOptOutSync(r));
      for (const e of r.addedEmails) console.log(`  + ${e}`);
    } finally {
      ledger.close();
    }
  });

program
  .command("verify")
  .description("Source leads (CSV or search) and run them through all 5 gates")
  .requiredOption("-c, --campaign <ref>", "campaign JSON path, or the Name of a row in the Sheet's Campaigns tab")
  .option(
    "--csv <path>",
    "CSV or XLSX lead file (overrides the campaign's sourcing_provider)",
  )
  .option("-l, --limit <n>", "max leads to source", "50")
  .option("-o, --out <dir>", "folder for the JSON report", "out")
  .option("--skip-optout-sync", "do not read opt-outs from the Google Sheet first", false)
  .action(
    async (o: {
      campaign: string;
      csv?: string;
      limit: string;
      out: string;
      skipOptoutSync: boolean;
    }) => {
      const cfg = await loadCampaign(o.campaign);
      const ledger = openLedger();

      try {
        await syncOptOutsIfConfigured(ledger, o.skipOptoutSync);
        console.log(
          `Running... (LLM: ${process.env.LLM_PROVIDER ?? "ollama"}, mailbox: ${process.env.MAILBOX_VERIFIER ?? "zerobounce"})`,
        );

        const gates = buildAsyncGates(cfg);

        const report = await runVerify(
          cfg,
          { limit: Number(o.limit), csvPath: o.csv },
          {
            ledger,
            gates,
            ...(o.csv ? {} : { search: getSearch(process.env, gates.llm) }),
          },
        );

        const path = await writeReport(report, o.out);

        console.log("");
        console.log(formatSummary(report));
        console.log("");
        console.log(`Report saved: ${path}`);
      } finally {
        ledger.close();
      }
    },
  );

program
  .command("run")
  .description(
    "Source leads, run all 5 gates, and draft an email for every lead that passes",
  )
  .requiredOption("-c, --campaign <ref>", "campaign JSON path, or the Name of a row in the Sheet's Campaigns tab")
  .option(
    "--csv <path>",
    "CSV or XLSX lead file (overrides the campaign's sourcing_provider)",
  )
  .option("-l, --limit <n>", "max leads to source", "50")
  .option("-o, --out <dir>", "folder for the reports", "out")
  .option("--show <n>", "drafts to print on screen", "3")
  .addOption(
    new Option(
      "--export <target>",
      "also send the result to the Google Sheet (sheet), an Excel file (xlsx), or both",
    )
      .choices(["none", "sheet", "xlsx", "both"])
      .default("none"),
  )
  .option("--skip-optout-sync", "do not read opt-outs from the Google Sheet first", false)
  .action(
    async (o: {
      campaign: string;
      csv?: string;
      limit: string;
      out: string;
      show: string;
      export: ExportTarget;
      skipOptoutSync: boolean;
    }) => {
      const cfg = await loadCampaign(o.campaign);
      const ledger = openLedger();

      try {
        await syncOptOutsIfConfigured(ledger, o.skipOptoutSync);
        console.log(
          `Running... (LLM: ${process.env.LLM_PROVIDER ?? "ollama"}, mailbox: ${process.env.MAILBOX_VERIFIER ?? "zerobounce"})`,
        );

        const gates = buildAsyncGates(cfg);

        const report = await runAll(
          cfg,
          { limit: Number(o.limit), csvPath: o.csv },
          {
            ledger,
            gates,
            llm: gates.llm,
            writer: {
              concurrency: Number(process.env.DRAFT_CONCURRENCY ?? 3),
            },
            ...(o.csv ? {} : { search: getSearch(process.env, gates.llm) }),
          },
        );

        const path = await writeReport(report, o.out);

        console.log("");
        console.log(formatSummary(report));

        for (const d of (report.drafts ?? []).slice(0, Number(o.show))) {
          console.log(
            `\n--- ${d.first_name} ${d.last_name} <${d.email}>  [${d.draft_status}]`,
          );
          console.log(`Subject: ${d.email_subject}\n`);
          console.log(d.email_body);

          if (d.draft_issues.length) {
            console.log(`Issues: ${d.draft_issues.join("; ")}`);
          }
        }

        console.log("");
        console.log(`Report saved: ${path}`);
        console.log(
          `Drafts saved: ${path.replace(/run-([^/\\]+)\.json$/, "drafts-$1.md")}`,
        );

        await exportRun(o.export, report, ledger, o.out);
      } finally {
        ledger.close();
      }
    },
  );

// ---------------------------------------------------------------------------
// campaign: manage the Campaigns tab in the Google Sheet (production home of campaigns)
// ---------------------------------------------------------------------------

function printCampaigns(rows: CampaignSummary[]): void {
  if (!rows.length) { console.log("No campaigns in the Campaigns tab yet. Use `campaign import` or add a row."); return; }
  const w = Math.max(4, ...rows.map((r) => r.name.length));
  console.log(`${"Name".padEnd(w)}  Active  Mode       Status`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(w)}  ${(r.active ? "yes" : "no").padEnd(6)}  ${r.mode.padEnd(9)}  ${r.status}`);
  }
}

const campaign = program.command("campaign").description("List, check, import, activate or pause campaigns in the Sheet");

campaign.command("list").description("Show every row in the Campaigns tab").action(async () => {
  printCampaigns(await sheetCampaignStore(await defaultSheetsGateway()).list());
});

campaign.command("validate").description("Re-check every row and write OK or the problem into its Status cell").action(async () => {
  const rows = await sheetCampaignStore(await defaultSheetsGateway()).validateAll();
  printCampaigns(rows);
  const bad = rows.filter((r) => r.status !== "OK").length;
  console.log(bad ? `\n${bad} row(s) need fixing. The Status cell says what.` : "\nAll rows are valid.");
});

campaign.command("show").description("Print one campaign as the engine sees it").argument("<ref>", "Name in the Sheet, or a JSON path")
  .action(async (ref: string) => { console.log(JSON.stringify(await loadCampaign(ref), null, 2)); });

campaign.command("import").description("Copy JSON campaign files into the Campaigns tab (paused)").argument("<files...>")
  .option("--active", "import as active", false)
  .action(async (files: string[], o: { active: boolean }) => {
    const store = sheetCampaignStore(await defaultSheetsGateway());
    for (const f of files) {
      const cfg = await fileCampaignStore().get(f);
      const s = await store.save(cfg, { active: o.active });
      console.log(`${f} -> row ${s.rowNumber} "${s.name}" (${s.active ? "active" : "paused"})`);
    }
  });

campaign.command("activate").description("Turn a campaign on. It runs on the next `run-active`").argument("<name>")
  .action(async (name: string) => { await sheetCampaignStore(await defaultSheetsGateway()).setActive(name, true); console.log(`"${name}" is active.`); });

campaign.command("pause").description("Turn a campaign off").argument("<name>")
  .action(async (name: string) => { await sheetCampaignStore(await defaultSheetsGateway()).setActive(name, false); console.log(`"${name}" is paused.`); });

program
  .command("run-active")
  .description("Run every active campaign in the Sheet (source, 5 gates, draft, export to Sheet). For the morning schedule.")
  .option("-l, --limit <n>", "max leads to source per campaign", "50")
  .option("-o, --out <dir>", "folder for the reports", "out")
  .addOption(new Option("--export <target>", "where results go").choices(["none", "sheet", "xlsx", "both"]).default("sheet"))
  .action(async (o: { limit: string; out: string; export: ExportTarget }) => {
    const gw = await defaultSheetsGateway();
    const store = sheetCampaignStore(gw);
    const active = (await store.list()).filter((c) => c.active);
    if (!active.length) { console.log("No active campaigns. Nothing to do."); return; }
    console.log(`${active.length} active campaign(s): ${active.map((c) => c.name).join(", ")}`);

    const ledger = openLedger();
    let failures = 0;
    try {
      await syncOptOutsIfConfigured(ledger, false);
      for (const c of active) {
        console.log(`\n=== ${c.name} ===`);
        try {
          const cfg = await store.get(c.name);
          const gates = buildAsyncGates(cfg);
          const report = await runAll(cfg, { limit: Number(o.limit) }, {
            ledger, gates, llm: gates.llm,
            writer: { concurrency: Number(process.env.DRAFT_CONCURRENCY ?? 3) },
            search: getSearch(process.env, gates.llm),
          });
          const path = await writeReport(report, o.out);
          console.log(formatSummary(report));
          console.log(`Report saved: ${path}`);
          await exportRun(o.export, report, ledger, o.out);
        } catch (err) {
          failures += 1;
          console.error(`"${c.name}" failed: ${(err as Error).message}. Moving to the next campaign.`);
        }
      }
    } finally {
      ledger.close();
    }
    if (failures) process.exitCode = 1;
  });

program
  .command("jobs-export")
  .description("Write a finished job search (newest, or --id) to the Google Sheet's Jobs tab")
  .option("--id <search_id>", "a jobs-<uuid> search id")
  .action(async (o: { id?: string }) => {
    const id = o.id ?? (await latestJobSearchId());
    if (!id) throw new Error("No job search found in out/job-searches. Run search_jobs first.");
    const rec = await loadJobSearchRecord(id);
    if (rec.status !== "DONE" || !rec.result) throw new Error(`Search ${id} is ${rec.status}.`);
    const { createSheetsGateway } = await import("./lib/google/sheets.js");
    const res = await exportJobsToSheet(rec.result, createSheetsGateway());
    await saveJobSearchRecord({ ...rec, sheet: res, updated_at: new Date().toISOString() });
    console.log(formatJobsExport(res));
  });

program.parseAsync().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
