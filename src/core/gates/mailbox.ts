import { promises as dns } from "node:dns";
import type { FailureReason, LeadRecord } from "../../config/schema.js";
import { logger } from "../../lib/logger.js";
import { throwForStatus, withRetry } from "../../lib/retry.js";
import { emailParts } from "../sanitize.js";

export type MxResolver = (domain: string) => Promise<{ exchange: string; priority: number }[]>;

/** A paid mailbox check (ZeroBounce, MillionVerifier, ...). Returns null when the mailbox is valid. */
export interface MailboxVerifier {
  readonly name: string;
  verify(email: string): Promise<FailureReason | null>;
}

const ZB_STATUS: Record<string, FailureReason | null> = {
  "valid": null,
  "invalid": "MAILBOX_INVALID",
  "catch-all": "MAILBOX_CATCH_ALL",
  "unknown": "MAILBOX_UNKNOWN",
  "spamtrap": "MAILBOX_DO_NOT_MAIL",
  "abuse": "MAILBOX_DO_NOT_MAIL",
  "do_not_mail": "MAILBOX_DO_NOT_MAIL",
};

export function zeroBounceVerifier(apiKey: string, fetchFn: typeof fetch = fetch): MailboxVerifier {
  return {
    name: "zerobounce",
    async verify(email) {
      const url = new URL("https://api.zerobounce.net/v2/validate");
      url.searchParams.set("api_key", apiKey);
      url.searchParams.set("email", email);
      url.searchParams.set("ip_address", "");

      const data = await withRetry(async () => {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000) });
        throwForStatus(res, "zerobounce");
        return (await res.json()) as { status?: string; error?: string };
      }, "zerobounce.validate");

      if (data.error) throw new Error(`zerobounce: ${data.error}`);
      const status = (data.status ?? "unknown").toLowerCase();
      return status in ZB_STATUS ? ZB_STATUS[status]! : "MAILBOX_UNKNOWN";
    },
  };
}

/** Development only: skips the paid check after MX passes. Refused when NODE_ENV=production. */
export const devSkipVerifier: MailboxVerifier = {
  name: "dev_skip",
  async verify() {
    return null;
  },
};

/** DNS answers that mean "this domain has no mail server". ESERVFAIL is a resolver failure, not an answer. */
const NOT_FOUND_CODES = new Set(["ENOTFOUND", "ENODATA"]);

/** A domain that always has MX records. If it fails too, DNS itself is down. */
const DNS_CANARY = "gmail.com";

export interface MailboxCheckDeps {
  verifier: MailboxVerifier;
  resolveMx?: MxResolver;
}

/**
 * Gate 5: free DNS MX check, then the paid mailbox check.
 * MX results are cached per domain for the run. Fails closed on unexpected errors.
 */
export function makeMailboxCheck(deps: MailboxCheckDeps) {
  const resolveMx = deps.resolveMx ?? dns.resolveMx;
  const mxCache = new Map<string, Promise<boolean>>();
  let dnsCheck: Promise<boolean> | undefined;

  /** Run once per process: confirms DNS works before trusting any "no MX" answer. */
  const dnsWorks = (): Promise<boolean> => {
    dnsCheck ??= resolveMx(DNS_CANARY).then((r) => r.length > 0, () => false);
    return dnsCheck;
  };

  const hasMx = (domain: string): Promise<boolean> => {
    let p = mxCache.get(domain);
    if (!p) {
      p = resolveMx(domain).then(
        // RFC 7505 "null MX" (exchange "" or ".") means the domain accepts no mail.
        (records) => records.some((r) => r.exchange !== "" && r.exchange !== "."),
        async (err: NodeJS.ErrnoException) => {
          if (err.code && NOT_FOUND_CODES.has(err.code)) {
            if (await dnsWorks()) return false;
            throw new Error(`DNS lookups are failing (even ${DNS_CANARY}). Check the network; leads are held back, not rejected.`);
          }
          throw err;
        },
      );
      mxCache.set(domain, p);
    }
    return p;
  };

  return async (lead: LeadRecord): Promise<FailureReason | null> => {
    const email = lead.email!;
    const { domain } = emailParts(email);
    try {
      if (!(await hasMx(domain))) return "NO_MX_RECORD";
      return await deps.verifier.verify(email);
    } catch (err) {
      mxCache.delete(domain);
      logger.error({ lead_id: lead.lead_id, gate: 5, verifier: deps.verifier.name, err: (err as Error).message }, "mailbox check failed");
      return "GATE_ERROR";
    }
  };
}
