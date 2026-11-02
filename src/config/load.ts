import type { SheetsGateway } from "../core/exporter.js";
import { CampaignConfig } from "./schema.js";
import { fileCampaignStore, isCampaignFile, sheetCampaignStore, type CampaignStore } from "./store.js";

/**
 * Loads a campaign by reference.
 *   "campaigns/b2b_healthcare.json"  -> read the file (development, tests)
 *   "Ohio TPAs"                      -> read the row with that Name in the Sheet's Campaigns tab (production)
 * Both return the same CampaignConfig, so callers never know which one happened.
 */
export async function loadCampaign(ref: string, gw?: SheetsGateway): Promise<CampaignConfig> {
  return (await campaignStoreFor(ref, gw)).get(ref);
}

/** The store that matches a reference. The Sheet gateway is created lazily so file-only runs need no Google key. */
export async function campaignStoreFor(ref: string, gw?: SheetsGateway): Promise<CampaignStore> {
  if (isCampaignFile(ref)) return fileCampaignStore();
  return sheetCampaignStore(gw ?? await defaultSheetsGateway());
}

export async function defaultSheetsGateway(): Promise<SheetsGateway> {
  const { createSheetsGateway } = await import("../lib/google/sheets.js");
  return createSheetsGateway();
}

export { CampaignConfig };
