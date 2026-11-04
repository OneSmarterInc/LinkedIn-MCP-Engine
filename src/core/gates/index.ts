import type { CampaignConfig } from "../../config/schema.js";
import { getLLM } from "../../lib/llm/index.js";
import type { LLMProvider } from "../../lib/llm/provider.js";
import { logger } from "../../lib/logger.js";
import type { AsyncGates } from "../verifier.js";
import { makeEntityCheck, makeHybridEntityCheck, makeRuleEntityCheck } from "./entity.js";
import { devSkipVerifier, makeMailboxCheck, zeroBounceVerifier, type MailboxVerifier } from "./mailbox.js";

export { makeEntityCheck, makeRuleEntityCheck, makeHybridEntityCheck, domainMatchesCompany, registrableDomain, EntityVerdict, emailMatchesName } from "./entity.js";

/** How Gate 4 decides. rules: no model (default). hybrid: model only for unclear domains. gemini|llm: model for every lead. */
export function getEntityMode(env: NodeJS.ProcessEnv = process.env): "rules" | "hybrid" | "llm" {
  const v = (env.ENTITY_CHECK ?? "rules").toLowerCase();
  if (v === "rules") return "rules";
  if (v === "hybrid") return "hybrid";
  if (v === "llm" || v === "gemini" || v === "ollama" || v === "model") return "llm";
  throw new Error(`Unknown ENTITY_CHECK "${env.ENTITY_CHECK}". Use rules, hybrid or gemini.`);
}
export { makeMailboxCheck, zeroBounceVerifier, devSkipVerifier } from "./mailbox.js";
export type { MailboxVerifier, MxResolver } from "./mailbox.js";

export function getMailboxVerifier(env: NodeJS.ProcessEnv = process.env): MailboxVerifier {
  const choice = (env.MAILBOX_VERIFIER ?? "zerobounce").toLowerCase();
  if (choice === "dev_skip") {
    if (env.NODE_ENV === "production") {
      throw new Error("MAILBOX_VERIFIER=dev_skip is not allowed when NODE_ENV=production");
    }
    logger.warn("Gate 5 paid mailbox check is SKIPPED (MAILBOX_VERIFIER=dev_skip). Development only.");
    return devSkipVerifier;
  }
  if (choice === "zerobounce") {
    if (!env.ZEROBOUNCE_API_KEY) {
      throw new Error("MAILBOX_VERIFIER=zerobounce but ZEROBOUNCE_API_KEY is empty. Set the key, or use dev_skip for local testing.");
    }
    return zeroBounceVerifier(env.ZEROBOUNCE_API_KEY);
  }
  throw new Error(`Unknown MAILBOX_VERIFIER "${choice}". Use "zerobounce" or "dev_skip".`);
}

/** Wires Gates 4 and 5 from environment settings. The CLI and MCP server both call this. */
export function buildAsyncGates(
  cfg: CampaignConfig,
  env: NodeJS.ProcessEnv = process.env,
  llm: LLMProvider = getLLM(env),
): AsyncGates & { llm: LLMProvider } {
  const minConfidence = Number(env.ENTITY_MIN_CONFIDENCE ?? 0.7);
  const mode = getEntityMode(env);
  const entityCheck = mode === "rules" ? makeRuleEntityCheck(cfg) : mode === "hybrid" ? makeHybridEntityCheck(llm, cfg, { minConfidence }) : makeEntityCheck(llm, cfg, { minConfidence });
  return {
    llm,
    entityCheck,
    mailboxCheck: makeMailboxCheck({ verifier: getMailboxVerifier(env) }),
  };
}
