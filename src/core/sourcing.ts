import type { CampaignConfig } from "../config/schema.js";
import { getSearch } from "../lib/search/index.js";
import type { SearchProvider } from "../lib/search/provider.js";
import { readLeadFile } from "./sources/csv.js";
import { getEmailFinder, type EmailFinder } from "./sources/email-finder.js";
import type { SourceResult } from "./sources/types.js";
import { sourceFromSearch } from "./sources/xray.js";

export type { SourceResult, SkippedRow, SkipReason } from "./sources/types.js";

export interface SourceOptions {
  limit: number;
  /** A CSV/XLSX path. When given, it is used regardless of the campaign's sourcing_provider. */
  csvPath?: string;
}

export interface SourceDeps {
  search?: SearchProvider;
  emailFinder?: EmailFinder;
}

/**
 * Phase 2 entry point. Decides where leads come from:
 *  1. --csv given           -> csv_import from that file
 *  2. csv_import campaign   -> csv_import from campaign.csv_path
 *  3. gemini_xray campaign  -> SEARCH_PROVIDER (fixture offline, gemini live)
 */
export async function sourceLeads(cfg: CampaignConfig, opts: SourceOptions, deps: SourceDeps = {}): Promise<SourceResult> {
  const csvPath = opts.csvPath ?? (cfg.sourcing_provider === "csv_import" ? cfg.csv_path : undefined);

  if (csvPath) return readLeadFile(csvPath, opts.limit);

  switch (cfg.sourcing_provider) {
    case "csv_import":
      throw new Error("csv_import campaign has no csv_path. Pass --csv <file> or add csv_path to the campaign.");
    case "gemini_xray":
      return sourceFromSearch(cfg, opts.limit, deps.search ?? getSearch(), deps.emailFinder ?? getEmailFinder());
    case "apify_or_apollo":
      throw new Error("apify_or_apollo is planned for Phase 8. Use --csv or gemini_xray for now.");
  }
}
