import { z } from "zod";
import { CampaignConfig, type LeadRecord } from "../src/config/schema.js";
import type { LLMProvider } from "../src/lib/llm/provider.js";

export const corporateCfg = CampaignConfig.parse({
  campaign_name: "test-corp", mode: "CORPORATE", sourcing_provider: "csv_import",
  target_geography: ["Ohio"], decision_maker_titles: ["CFO"],
});

export const candidateCfg = CampaignConfig.parse({
  campaign_name: "test-cand", mode: "CANDIDATE", sourcing_provider: "csv_import",
  target_geography: ["Ohio"], decision_maker_titles: ["Engineer"], block_current_employer_domain: true,
});

let n = 0;
export function makeLead(o: Partial<LeadRecord> = {}): LeadRecord {
  n += 1;
  return {
    lead_id: `T${n}`, first_name: "Jane", last_name: "Miller", title: "CFO",
    company_name: "Acme Manufacturing", company_domain: "acme.com", location: "Dayton, OH",
    email: `jane.miller@acme.com`, source: "csv_import", ...o,
  };
}

/** An LLM stand-in that returns a fixed answer (or throws) and records each prompt. */
export function fakeLLM(answer: unknown | (() => never), grounding = false) {
  const prompts: string[] = [];
  const llm: LLMProvider = {
    name: "fake",
    supportsGrounding: grounding,
    async generateJSON<S extends z.ZodType>(prompt: string, schema: S): Promise<z.infer<S>> {
      prompts.push(prompt);
      if (typeof answer === "function") (answer as () => never)();
      return schema.parse(answer);
    },
    async generateText(prompt: string) {
      prompts.push(prompt);
      return String(answer);
    },
  };
  return { llm, prompts };
}
