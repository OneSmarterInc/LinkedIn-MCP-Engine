import type { LeadRecord } from "../../config/schema.js";

/**
 * Turns a person + company domain into an email address.
 * LinkedIn search gives names, not emails, so gemini_xray leads need one of these.
 * "none" keeps whatever email the search returned; leads without one fail Gate 1 with MISSING_EMAIL.
 * A Hunter / Prospeo finder plugs in here later without touching any other file.
 */
export interface EmailFinder {
  readonly name: string;
  find(lead: LeadRecord): Promise<string | undefined>;
}

export const noEmailFinder: EmailFinder = {
  name: "none",
  async find(lead) {
    return lead.email;
  },
};

export function getEmailFinder(env: NodeJS.ProcessEnv = process.env): EmailFinder {
  const choice = (env.EMAIL_FINDER ?? "none").toLowerCase();
  if (choice === "none") return noEmailFinder;
  throw new Error(`Unknown EMAIL_FINDER "${choice}". Only "none" is built so far.`);
}
