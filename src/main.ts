import "dotenv/config";
import { Command } from "commander";
import { loadCampaign } from "./config/load.js";
import { openLedger } from "./core/db.js";
import { buildAsyncGates } from "./core/gates/index.js";
import { formatSummary, runAll, runVerify, writeReport } from "./core/pipeline.js";
import { getSearch } from "./lib/search/index.js";

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
  .action(async (o: { campaign: string; csv?: string; limit: string; out: string; show: string }) => {
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
    } finally {
      ledger.close();
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
