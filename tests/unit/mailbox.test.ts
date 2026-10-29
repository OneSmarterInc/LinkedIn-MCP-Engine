import { describe, it, expect, vi } from "vitest";
import { makeMailboxCheck, zeroBounceVerifier, type MailboxVerifier, type MxResolver } from "../../src/core/gates/mailbox.js";
import { getMailboxVerifier } from "../../src/core/gates/index.js";
import { makeLead } from "../helpers.js";

const goodMx: MxResolver = async () => [{ exchange: "mx.acme.com", priority: 10 }];
const validVerifier: MailboxVerifier = { name: "test", verify: async () => null };

function dnsError(code: string) {
  return Object.assign(new Error(code), { code });
}

describe("gate 5: MX check", () => {
  // Fails for every domain except the gmail.com DNS canary, like a real "domain does not exist".
  const onlyGmail = (code: string): MxResolver => async (d) => {
    if (d === "gmail.com") return [{ exchange: "gmail-smtp-in.l.google.com", priority: 5 }];
    throw dnsError(code);
  };

  it("rejects a domain with no MX record", async () => {
    const check = makeMailboxCheck({ verifier: validVerifier, resolveMx: onlyGmail("ENOTFOUND") });
    expect(await check(makeLead())).toBe("NO_MX_RECORD");
  });

  it("treats ENODATA as no MX record", async () => {
    const check = makeMailboxCheck({ verifier: validVerifier, resolveMx: onlyGmail("ENODATA") });
    expect(await check(makeLead())).toBe("NO_MX_RECORD");
  });

  it("holds leads back (GATE_ERROR) when DNS itself is down", async () => {
    const check = makeMailboxCheck({ verifier: validVerifier, resolveMx: async () => { throw dnsError("ENOTFOUND"); } });
    expect(await check(makeLead())).toBe("GATE_ERROR");
  });

  it("treats a resolver failure (ESERVFAIL) as GATE_ERROR, not a missing domain", async () => {
    const check = makeMailboxCheck({ verifier: validVerifier, resolveMx: onlyGmail("ESERVFAIL") });
    expect(await check(makeLead())).toBe("GATE_ERROR");
  });

  it("rejects a null MX (RFC 7505)", async () => {
    const check = makeMailboxCheck({ verifier: validVerifier, resolveMx: async () => [{ exchange: ".", priority: 0 }] });
    expect(await check(makeLead())).toBe("NO_MX_RECORD");
  });

  it("fails closed on a DNS timeout", async () => {
    const check = makeMailboxCheck({ verifier: validVerifier, resolveMx: async () => { throw dnsError("ETIMEOUT"); } });
    expect(await check(makeLead())).toBe("GATE_ERROR");
  });

  it("looks up each domain only once per run", async () => {
    const resolveMx = vi.fn(goodMx);
    const check = makeMailboxCheck({ verifier: validVerifier, resolveMx });
    await check(makeLead({ email: "a@acme.com" }));
    await check(makeLead({ email: "b@acme.com" }));
    expect(resolveMx).toHaveBeenCalledTimes(1);
  });

  it("does not call the paid verifier when MX fails", async () => {
    const verify = vi.fn(async () => null);
    const check = makeMailboxCheck({ verifier: { name: "t", verify }, resolveMx: async () => [] });
    await check(makeLead());
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("gate 5: ZeroBounce", () => {
  const respond = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it.each([
    ["valid", null],
    ["invalid", "MAILBOX_INVALID"],
    ["catch-all", "MAILBOX_CATCH_ALL"],
    ["unknown", "MAILBOX_UNKNOWN"],
    ["spamtrap", "MAILBOX_DO_NOT_MAIL"],
    ["do_not_mail", "MAILBOX_DO_NOT_MAIL"],
    ["something_new", "MAILBOX_UNKNOWN"],
  ])("status %s -> %s", async (status, expected) => {
    const check = makeMailboxCheck({ verifier: zeroBounceVerifier("k", respond({ status })), resolveMx: goodMx });
    expect(await check(makeLead())).toBe(expected);
  });

  it("fails closed when credits run out", async () => {
    const check = makeMailboxCheck({ verifier: zeroBounceVerifier("k", respond({ error: "Out of credits" })), resolveMx: goodMx });
    expect(await check(makeLead())).toBe("GATE_ERROR");
  });

  it("fails closed on a bad API key (401), without retrying", async () => {
    const fetchFn = respond({}, 401);
    const check = makeMailboxCheck({ verifier: zeroBounceVerifier("bad", fetchFn), resolveMx: goodMx });
    expect(await check(makeLead())).toBe("GATE_ERROR");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("getMailboxVerifier", () => {
  it("refuses dev_skip in production", () => {
    expect(() => getMailboxVerifier({ MAILBOX_VERIFIER: "dev_skip", NODE_ENV: "production" })).toThrow(/not allowed/);
  });
  it("requires a ZeroBounce key", () => {
    expect(() => getMailboxVerifier({ MAILBOX_VERIFIER: "zerobounce" })).toThrow(/ZEROBOUNCE_API_KEY/);
  });
  it("allows dev_skip in development", () => {
    expect(getMailboxVerifier({ MAILBOX_VERIFIER: "dev_skip", NODE_ENV: "development" }).name).toBe("dev_skip");
  });
});
