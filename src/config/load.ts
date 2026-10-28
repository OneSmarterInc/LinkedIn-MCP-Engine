import { readFile } from "node:fs/promises";
import { CampaignConfig } from "./schema.js";

export async function loadCampaign(path: string): Promise<CampaignConfig> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const result = CampaignConfig.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid campaign file ${path}:\n${result.error.message}`);
  }
  return result.data;
}