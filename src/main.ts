import "dotenv/config";
import { Command } from "commander";
import { loadCampaign } from "./config/load.js";

const program = new Command()
  .name("linkedin-mcp-engine")
  .requiredOption("-c, --campaign <path>", "path to campaign JSON")
  .option("-l, --limit <n>", "max leads to source", "10")
  .option("--dry-run", "load and validate only", false)
  .parse();

const opts = program.opts<{ campaign: string; limit: string; dryRun: boolean }>();

const campaign = await loadCampaign(opts.campaign);
console.log(`Campaign: ${campaign.campaign_name}`);
console.log(`Mode: ${campaign.mode} | Provider: ${campaign.sourcing_provider} | Limit: ${opts.limit}`);