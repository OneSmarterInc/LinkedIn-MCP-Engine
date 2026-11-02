import type { LeadRecord } from "../../config/schema.js";
import { logger } from "../../lib/logger.js";
import { apolloMatch, guessEmail } from "./apollo-finder.js";
import { seamlessMatch, type SeamlessOptions } from "./seamless-finder.js";

/**
 * Turns a person + company domain into an email address.
 * LinkedIn search gives names, not emails, so gemini_xray leads need one of these.
 * Every finder keeps an email the lead already has, and labels where a new one came from.
 */
export interface EmailFinder {
  readonly name: string;
  find(lead: LeadRecord): Promise<Pick<LeadRecord, "email" | "email_source">>;
}

/** Keeps whatever email the search returned. Leads without one fail Gate 1 with MISSING_EMAIL. */
export const noEmailFinder: EmailFinder = {
  name: "none",
  async find(lead) {
    return lead.email ? { email: lead.email, email_source: lead.email_source ?? "search" } : {};
  },
};

export interface ApolloFinderOptions {
  apiKey: string;
  /** Also guess first.last@domain when Apollo has nothing. Guesses must pass ZeroBounce at Gate 5. */
  guessPattern: boolean;
  fetchFn?: typeof fetch;
}

export function apolloEmailFinder(opts: ApolloFinderOptions): EmailFinder {
  return {
    name: opts.guessPattern ? "apollo+pattern" : "apollo",
    async find(lead) {
      if (lead.email) return { email: lead.email, email_source: lead.email_source ?? "search" };

      const found = await apolloMatch(lead, opts.apiKey, opts.fetchFn);
      if (found) return { email: found, email_source: "apollo" };

      if (opts.guessPattern) {
        const guess = guessEmail(lead);
        if (guess) {
          logger.debug({ lead_id: lead.lead_id }, "email guessed from pattern");
          return { email: guess, email_source: "pattern" };
        }
      }
      return {};
    },
  };
}

export interface SeamlessFinderOptions {
  apiKey: string;
  /** Also guess first.last@domain when Seamless has nothing. Guesses must pass ZeroBounce at Gate 5. */
  guessPattern: boolean;
  fetchFn?: typeof fetch;
  poll?: SeamlessOptions;
}

export function seamlessEmailFinder(opts: SeamlessFinderOptions): EmailFinder {
  return {
    name: opts.guessPattern ? "seamless+pattern" : "seamless",
    async find(lead) {
      if (lead.email) return { email: lead.email, email_source: lead.email_source ?? "search" };

      const found = await seamlessMatch(lead, opts.apiKey, opts.fetchFn, opts.poll);
      if (found) return { email: found, email_source: "seamless" };

      if (opts.guessPattern) {
        const guess = guessEmail(lead);
        if (guess) {
          logger.debug({ lead_id: lead.lead_id }, "email guessed from pattern");
          return { email: guess, email_source: "pattern" };
        }
      }
      return {};
    },
  };
}

/**
 * EMAIL_FINDER:
 *  - none            keep the search's email (default)
 *  - apollo          Apollo people/match only
 *  - apollo_pattern  Apollo, then a first.last@domain guess (needs MAILBOX_VERIFIER=zerobounce to pass)
 *  - seamless        Seamless.AI Contact Research only
 *  - seamless_pattern Seamless, then the same first.last@domain guess
 */
export function getEmailFinder(env: NodeJS.ProcessEnv = process.env): EmailFinder {
  const choice = (env.EMAIL_FINDER ?? "none").trim().toLowerCase();
  if (choice === "none") return noEmailFinder;
  if (choice === "apollo" || choice === "apollo_pattern") {
    const apiKey = env.APOLLO_API_KEY?.trim();
    if (!apiKey) throw new Error(`EMAIL_FINDER=${choice} but APOLLO_API_KEY is empty`);
    return apolloEmailFinder({ apiKey, guessPattern: choice === "apollo_pattern" });
  }
  if (choice === "seamless" || choice === "seamless_pattern") {
    const apiKey = env.SEAMLESS_API_KEY?.trim();
    if (!apiKey) throw new Error(`EMAIL_FINDER=${choice} but SEAMLESS_API_KEY is empty`);
    return seamlessEmailFinder({ apiKey, guessPattern: choice === "seamless_pattern" });
  }
  throw new Error(`Unknown EMAIL_FINDER "${choice}". Use none, apollo, apollo_pattern, seamless, or seamless_pattern.`);
}
