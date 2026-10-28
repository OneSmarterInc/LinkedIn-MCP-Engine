import type { CampaignConfig } from "../../config/schema.js";
import { getLLM } from "../../lib/llm/index.js";
import type { LLMProvider } from "../../lib/llm/provider.js";
import { logger } from "../../lib/logger.js";
import type { AsyncGates } from "../verifier.js";
import { makeEntityCheck } from "./entity.js";
import { devSkipVerifier, makeMailboxCheck, zeroBounceVerifier, type MailboxVerifier } from "./mailbox.js";

export { makeEntityCheck, EntityVerdict, emailMatchesName } from "./entity.js";
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
): AsyncGates {
  const minConfidence = Number(env.ENTITY_MIN_CONFIDENCE ?? 0.7);
  return {
    entityCheck: makeEntityCheck(llm, cfg, { minConfidence }),
    mailboxCheck: makeMailboxCheck({ verifier: getMailboxVerifier(env) }),
  };
}
