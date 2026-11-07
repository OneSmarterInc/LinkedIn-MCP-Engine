import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { PIPELINE_HEADERS } from "../../src/core/exporter.js";
import { openLedger } from "../../src/core/db.js";
import { buildApp } from "../../src/api/app.js";
import {
  hashPassword, verifyPassword, passwordProblem, newTotpSecret, totpCode, totpMatches, base32Decode, base32Encode,
  encryptText, decryptText, newRecoveryCodes, otpauthUrl,
} from "../../src/api/auth/crypto.js";
import { AuthStore } from "../../src/api/auth/store.js";

const gw = () => ({
  listTabs: async () => [{ title: "Jobs_Pipeline", sheetId: 1 }, { title: "Pipeline", sheetId: 2 }, { title: "Config", sheetId: 3 }],
  addTabs: async () => {}, batchUpdate: async () => {},
  getValues: async (r: string) => r.startsWith("Config") ? [["Key", "Value"]] : [[...PIPELINE_HEADERS]],
  writeValues: async () => {}, appendValues: async () => {},
}) as never;
const ENV = { SUPERUSER_EMAIL: "vikram@onesmarter.com, pete@onesmarter.com", AUTH_SECRET: "0123456789abcdef0123456789abcdef", API_TOKEN: "svc-token" };
const PW = "correct horse battery staple 9";

/** A tiny browser: keeps the session cookie between calls and always sends the console's header. */
function client(app: FastifyInstance) {
  let cookie = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: Record<string, unknown>): Promise<{ status: number; body: any }> => {
    const res = await app.inject({ method, url, ...(payload !== undefined ? { payload } : {}), headers: { cookie, "x-requested-with": "outreach-console", ...(payload !== undefined ? { "content-type": "application/json" } : {}) } });
    const set = res.headers["set-cookie"];
    const first = Array.isArray(set) ? set[0] : set;
    if (first) cookie = first.split(";")[0]!;
    return { status: res.statusCode, body: res.json() };
  };
  return { call, forgetCookie: () => { cookie = ""; }, cookie: () => cookie };
}

describe("auth crypto", () => {
  it("hashes and checks passwords; rejects weak ones", async () => {
    const h = await hashPassword(PW);
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword(PW, h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(passwordProblem("short1")).toMatch(/12 characters/);
    expect(passwordProblem("password1234")).toMatch(/too common/);
    expect(passwordProblem("hansavahini-rocks-2026", "hansavahini@onesmarter.com")).toMatch(/email name/);
    expect(passwordProblem(PW)).toBeUndefined();
  });
  it("TOTP matches Google Authenticator's scheme (RFC 6238 test vector) and allows one step of drift", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890")); // RFC 6238 SHA-1 test secret
    expect(totpCode(secret, 59_000)).toBe("287082");
    expect(totpCode(secret, 1_111_111_109_000)).toBe("081804");
    const s = newTotpSecret();
    expect(base32Decode(s)).toHaveLength(20);
    const at = 1_700_000_000_000;
    expect(totpMatches(s, totpCode(s, at), at)).toBe(true);
    expect(totpMatches(s, totpCode(s, at - 30_000), at)).toBe(true);
    expect(totpMatches(s, totpCode(s, at - 90_000), at)).toBe(false);
    expect(totpMatches(s, "12 34 56x", at)).toBe(false);
    expect(otpauthUrl(s, "a@b.com")).toMatch(/^otpauth:\/\/totp\/Outreach%20Console:a%40b\.com\?secret=/);
  });
  it("encrypts secrets at rest and makes ten recovery codes", () => {
    const enc = encryptText("JBSWY3DPEHPK3PXP", ENV.AUTH_SECRET);
    expect(enc).not.toContain("JBSWY3DP");
    expect(decryptText(enc, ENV.AUTH_SECRET)).toBe("JBSWY3DPEHPK3PXP");
    expect(() => decryptText(enc, "another-secret-another-secret")).toThrow();
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);
  });
});

describe("auth store", () => {
  it("locks after five failures in fifteen minutes and clears on success", () => {
    const s = new AuthStore(":memory:");
    for (let i = 0; i < 4; i++) s.recordAttempt("a@b.com", false, "1.1.1.1");
    expect(s.lockedFor("a@b.com")).toBe(0);
    s.recordAttempt("a@b.com", false, "1.1.1.1");
    expect(s.lockedFor("a@b.com")).toBeGreaterThan(800);
    s.recordAttempt("a@b.com", true, "1.1.1.1");
    expect(s.lockedFor("a@b.com")).toBe(0);
  });
  it("B6: failures from one address do not lock out another; twenty from many addresses lock everyone", () => {
    const s = new AuthStore(":memory:");
    for (let i = 0; i < 5; i++) s.recordAttempt("admin@x.com", false, "6.6.6.6");
    expect(s.lockedFor("admin@x.com", "6.6.6.6")).toBeGreaterThan(800);
    expect(s.lockedFor("admin@x.com", "10.0.0.1")).toBe(0); // the real admin still signs in
    for (let i = 0; i < 15; i++) s.recordAttempt("admin@x.com", false, `7.7.7.${i}`);
    expect(s.lockedFor("admin@x.com", "10.0.0.1")).toBeGreaterThan(800);
  });
  it("recovery codes are single use", () => {
    const s = new AuthStore(":memory:");
    s.setRecoveryCodes("u1", ["abcde-fghjk", "mnpqr-stuvw"]);
    expect(s.useRecoveryCode("u1", "ABCDE FGHJK")).toBe(true);
    expect(s.useRecoveryCode("u1", "abcde-fghjk")).toBe(false);
    expect(s.recoveryCodesLeft("u1")).toBe(1);
  });
});

describe("accounts mode: register -> approve -> sign in with two-factor", () => {
  const mk = async () => buildApp({ gw, ledger: openLedger(":memory:"), env: ENV, authDbPath: ":memory:" });

  it("refuses to start without AUTH_SECRET", async () => {
    await expect(buildApp({ gw, ledger: openLedger(":memory:"), env: { SUPERUSER_EMAIL: "v@x.com" }, authDbPath: ":memory:" })).rejects.toThrow(/AUTH_SECRET/);
  });

  it("without a session every /api route is 401; health says accounts are on; the service token still works", async () => {
    const app = await mk();
    expect((await app.inject({ method: "GET", url: "/api/pipeline" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({ accounts: true, auth: false });
    expect((await app.inject({ method: "GET", url: "/api/pipeline", headers: { authorization: "Bearer svc-token" } })).statusCode).toBe(200);
    await app.close();
  });

  it("the superuser registers as an approved admin; a member waits; the admin approves; both sign in with a code", async () => {
    const app = await mk();
    const sup = client(app);
    const mem = client(app);

    // register
    let r = await sup.call("POST", "/api/auth/register", { full_name: "Vikram Sethi", email: "Vikram@OneSmarter.com", password: PW, confirm: PW });
    expect(r.status).toBe(201); expect(r.body.status).toBe("active");
    r = await mem.call("POST", "/api/auth/register", { full_name: "Hansa V", email: "hansa@onesmarter.com", password: PW, confirm: PW });
    expect(r.status).toBe(201); expect(r.body.status).toBe("pending");
    r = await mem.call("POST", "/api/auth/register", { full_name: "Hansa V", email: "hansa@onesmarter.com", password: PW, confirm: PW });
    expect(r.status).toBe(409);
    r = await mem.call("POST", "/api/auth/register", { full_name: "X Y", email: "x@onesmarter.com", password: PW, confirm: "different" });
    expect(r.status).toBe(400); expect(r.body.error).toMatch(/do not match/);

    // pending member cannot sign in
    r = await mem.call("POST", "/api/auth/login", { email: "hansa@onesmarter.com", password: PW });
    expect(r.status).toBe(403); expect(r.body.code).toBe("PENDING");

    // superuser: first sign-in enrolls two-factor
    r = await sup.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    expect(r.status).toBe(200); expect(r.body.next).toBe("enroll"); expect(r.body.otpauth_url).toMatch(/^otpauth:/);
    const supSecret = r.body.secret as string;
    expect((await sup.call("GET", "/api/pipeline")).status).toBe(401); // not full yet
    r = await sup.call("POST", "/api/auth/2fa/enroll", { code: "000000" });
    expect(r.status).toBe(400);
    r = await sup.call("POST", "/api/auth/2fa/enroll", { code: totpCode(supSecret) });
    expect(r.status).toBe(200); expect((r.body.recovery_codes as string[]).length).toBe(10);
    expect((r.body.user as { role: string }).role).toBe("admin");
    const supCodes = r.body.recovery_codes as string[];
    const supRecovery = supCodes[0]!;

    // signed in: data routes work, me shows the pending count
    expect((await sup.call("GET", "/api/pipeline")).status).toBe(200);
    r = await sup.call("GET", "/api/auth/me");
    expect(r.body).toMatchObject({ stage: "full", superuser: true, pending_users: 1 });

    // approve the member
    r = await sup.call("GET", "/api/users");
    const pending = (r.body.users as Array<{ id: string; email: string; status: string }>).find((u) => u.email === "hansa@onesmarter.com")!;
    expect(pending.status).toBe("pending");
    r = await sup.call("POST", `/api/users/${pending.id}/approve`, { role: "member" });
    expect(r.status).toBe(200); expect((r.body.user as { status: string }).status).toBe("active");

    // member signs in, enrolls, then is a member (no admin routes)
    r = await mem.call("POST", "/api/auth/login", { email: "hansa@onesmarter.com", password: PW });
    expect(r.body.next).toBe("enroll");
    const memSecret = r.body.secret as string;
    r = await mem.call("POST", "/api/auth/2fa/enroll", { code: totpCode(memSecret) });
    expect(r.status).toBe(200);
    expect((await mem.call("GET", "/api/pipeline")).status).toBe(200);
    expect((await mem.call("GET", "/api/users")).status).toBe(403);
    expect((await mem.call("PUT", "/api/settings", { DryRun: true })).status).toBe(200); // members may change automation

    // a later sign-in: password then code; a recovery code also works once
    sup.forgetCookie();
    r = await sup.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    expect(r.body.next).toBe("totp");
    expect((await sup.call("GET", "/api/pipeline")).status).toBe(401);
    // The enrol code's step is used up, so this sign-in uses the next step (allowed: one step of drift).
    r = await sup.call("POST", "/api/auth/2fa/verify", { code: totpCode(supSecret) });
    expect(r.status).toBe(400); expect(r.body.error).toMatch(/already used/);
    r = await sup.call("POST", "/api/auth/2fa/verify", { code: totpCode(supSecret, Date.now() + 30_000) });
    expect(r.status).toBe(200); expect(r.body.recovery_codes_left).toBe(10);
    sup.forgetCookie();
    await sup.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    r = await sup.call("POST", "/api/auth/2fa/verify", { code: supRecovery });
    expect(r.status).toBe(200); expect(r.body.recovery_codes_left).toBe(9);
    sup.forgetCookie();
    await sup.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    expect((await sup.call("POST", "/api/auth/2fa/verify", { code: supRecovery })).status).toBe(400); // used

    // actions carry the actor; audit lists them; sign out ends the session
    await sup.call("POST", "/api/auth/2fa/verify", { code: supCodes[1]! });
    await sup.call("POST", "/api/pipeline/someone%40acme.com/approve").catch(() => {});
    r = await sup.call("GET", "/api/audit");
    const actions = (r.body.rows as Array<{ action: string; actor: string }>).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["register_superuser", "register", "two_factor_enrolled", "sign_in", "approve_user", "sign_in_recovery_code", "change_settings"]));
    expect((r.body.rows as Array<{ action: string; actor: string }>).find((x) => x.action === "approve_user")!.actor).toContain("vikram@onesmarter.com");
    expect((await sup.call("POST", "/api/auth/logout")).status).toBe(200);
    expect((await sup.call("GET", "/api/pipeline")).status).toBe(401);
    await app.close();
  });

  it("wrong passwords lock the account after five tries; errors never say which part was wrong", async () => {
    const app = await mk();
    const c = client(app);
    await c.call("POST", "/api/auth/register", { full_name: "Vikram Sethi", email: "vikram@onesmarter.com", password: PW, confirm: PW });
    for (let i = 0; i < 5; i++) {
      const r = await c.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: "nope-nope-nope" });
      expect(r.status).toBe(401); expect(r.body.error).toBe("Email or password is wrong.");
    }
    const locked = await c.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    expect(locked.status).toBe(429); expect(locked.body.error).toMatch(/Try again in/);
    const unknown = await c.call("POST", "/api/auth/login", { email: "nobody@onesmarter.com", password: PW });
    expect(unknown.status).toBe(401); expect(unknown.body.error).toBe("Email or password is wrong.");
    await app.close();
  });

  it("admin guard rails: superuser cannot be rejected, disabled or demoted; nobody disables themselves; disabled users are signed out", async () => {
    const app = await mk();
    const sup = client(app); const mem = client(app);
    await sup.call("POST", "/api/auth/register", { full_name: "Vikram Sethi", email: "vikram@onesmarter.com", password: PW, confirm: PW });
    await mem.call("POST", "/api/auth/register", { full_name: "Hansa V", email: "hansa@onesmarter.com", password: PW, confirm: PW });
    let r = await sup.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    await sup.call("POST", "/api/auth/2fa/enroll", { code: totpCode(r.body.secret as string) });
    const users = (await sup.call("GET", "/api/users")).body.users as Array<{ id: string; email: string; superuser: boolean }>;
    const me = users.find((u) => u.email === "vikram@onesmarter.com")!;
    const h = users.find((u) => u.email === "hansa@onesmarter.com")!;
    expect(me.superuser).toBe(true);
    expect((await sup.call("POST", `/api/users/${me.id}/disable`)).status).toBe(409);
    expect((await sup.call("POST", `/api/users/${me.id}/role`, { role: "member" })).status).toBe(409);
    await sup.call("POST", `/api/users/${h.id}/approve`, { role: "admin" });
    r = await mem.call("POST", "/api/auth/login", { email: "hansa@onesmarter.com", password: PW });
    await mem.call("POST", "/api/auth/2fa/enroll", { code: totpCode(r.body.secret as string) });
    expect((await mem.call("GET", "/api/users")).status).toBe(200); // now an admin
    expect((await mem.call("POST", `/api/users/${me.id}/role`, { role: "member" })).status).toBe(409); // superuser stays admin
    expect((await sup.call("POST", `/api/users/${h.id}/disable`)).status).toBe(200);
    expect((await mem.call("GET", "/api/pipeline")).status).toBe(401); // her session ended at once
    r = await mem.call("POST", "/api/auth/login", { email: "hansa@onesmarter.com", password: PW });
    expect(r.status).toBe(403); expect(r.body.code).toBe("DISABLED");
    expect((await sup.call("POST", `/api/users/${h.id}/enable`)).status).toBe(200);
    await app.close();
  });

  it("a change without the console's header is refused (cross-site form protection)", async () => {
    const app = await mk();
    const c = client(app);
    await c.call("POST", "/api/auth/register", { full_name: "Vikram Sethi", email: "vikram@onesmarter.com", password: PW, confirm: PW });
    const r = await c.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    await c.call("POST", "/api/auth/2fa/enroll", { code: totpCode(r.body.secret as string) });
    const withHeader = await app.inject({ method: "PUT", url: "/api/settings", payload: { DryRun: true }, headers: { cookie: c.cookie(), "x-requested-with": "outreach-console" } });
    expect(withHeader.statusCode).toBe(200);
    const noHeader = await app.inject({ method: "PUT", url: "/api/settings", payload: { DryRun: true }, headers: { cookie: c.cookie() } });
    expect(noHeader.statusCode).toBe(403);
    const read = await app.inject({ method: "GET", url: "/api/pipeline", headers: { cookie: c.cookie() } });
    expect(read.statusCode).toBe(200); // reads need no header
    await app.close();
  });
});

describe("account emails and password reset", () => {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const sendMail = async (m: { to: string; subject: string; text: string }) => { if (m.to === "bounce@onesmarter.com") throw new Error("550 mailbox unavailable"); sent.push(m); };
  const MAIL_ENV = { ...ENV, SMTP_HOST: "smtp.ionos.com", SMTP_PORT: "587", SMTP_USER: "akshay.kumar@onesmarter.com", SMTP_PASS: "x", MAIL_FROM: "OneSmarter Support <support@onesmarter.com>", ADMIN_NOTIFY: "vikram@onesmarter.com", PORTAL_URL: "https://outreach.onesmarter.com/" };
  const mk = async (env = MAIL_ENV) => buildApp({ gw, ledger: openLedger(":memory:"), env, authDbPath: ":memory:", sendMail });
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("register mails the admins; approve and reject mail the person; links use PORTAL_URL", async () => {
    sent.length = 0;
    const app = await mk();
    const sup = client(app); const mem = client(app);
    await sup.call("POST", "/api/auth/register", { full_name: "Vikram Sethi", email: "vikram@onesmarter.com", password: PW, confirm: PW });
    await mem.call("POST", "/api/auth/register", { full_name: "Hansa V", email: "hansa@onesmarter.com", password: PW, confirm: PW });
    await settle();
    expect(sent.map((m) => [m.to, m.subject])).toEqual([["vikram@onesmarter.com", "Access request: Hansa V"]]);
    expect(sent[0]!.text).toContain("https://outreach.onesmarter.com/#users");
    let r = await sup.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    await sup.call("POST", "/api/auth/2fa/enroll", { code: totpCode(r.body.secret as string) });
    const h = ((await sup.call("GET", "/api/users")).body.users as Array<{ id: string; email: string }>).find((u) => u.email === "hansa@onesmarter.com")!;
    await sup.call("POST", `/api/users/${h.id}/approve`, { role: "member" });
    await settle();
    expect(sent.at(-1)).toMatchObject({ to: "hansa@onesmarter.com", subject: "Your Outreach Console access is approved" });
    expect(sent.at(-1)!.text).toContain("https://outreach.onesmarter.com/#signin");
    await mem.call("POST", "/api/auth/register", { full_name: "Nope N", email: "nope@onesmarter.com", password: PW, confirm: PW });
    const n = ((await sup.call("GET", "/api/users")).body.users as Array<{ id: string; email: string }>).find((u) => u.email === "nope@onesmarter.com")!;
    await sup.call("POST", `/api/users/${n.id}/reject`, { reason: "Not on the team" });
    await settle();
    expect(sent.at(-1)).toMatchObject({ to: "nope@onesmarter.com", subject: "Your Outreach Console request" });
    expect(sent.at(-1)!.text).toContain("Not on the team");
    const audit = (await sup.call("GET", "/api/audit")).body.rows as Array<{ action: string; target: string }>;
    expect(audit.filter((a) => a.action === "mail_sent").length).toBeGreaterThanOrEqual(3);
    // test mail from the Users page
    r = await sup.call("POST", "/api/auth/test-mail", {});
    expect(r.status).toBe(200); expect(sent.at(-1)).toMatchObject({ to: "vikram@onesmarter.com", subject: "Outreach Console test email" });
    expect((await app.inject({ method: "GET", url: "/api/health" })).json().mail).toBe(true);
    await app.close();
  });

  it("forgot -> link -> new password: generic answer, single-use 30-minute token, every session ended", async () => {
    sent.length = 0;
    const app = await mk();
    const c = client(app);
    await c.call("POST", "/api/auth/register", { full_name: "Vikram Sethi", email: "vikram@onesmarter.com", password: PW, confirm: PW });
    let r = await c.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    const secret = r.body.secret as string;
    await c.call("POST", "/api/auth/2fa/enroll", { code: totpCode(secret) });
    expect((await c.call("GET", "/api/pipeline")).status).toBe(200);
    const stranger = client(app);
    const unknown = await stranger.call("POST", "/api/auth/forgot", { email: "nobody@onesmarter.com" });
    const known = await stranger.call("POST", "/api/auth/forgot", { email: "vikram@onesmarter.com" });
    expect(unknown.body).toEqual(known.body); // same words either way
    await settle();
    expect(sent).toHaveLength(1);
    const token = decodeURIComponent(/#reset=([^\s]+)/.exec(sent[0]!.text)![1]!);
    const NEW = "a brand new passphrase 2026";
    expect((await stranger.call("POST", "/api/auth/reset", { token, password: "short", confirm: "short" })).status).toBe(400); // weak: link stays usable
    expect((await stranger.call("POST", "/api/auth/reset", { token, password: NEW, confirm: NEW })).status).toBe(200);
    expect((await stranger.call("POST", "/api/auth/reset", { token, password: NEW, confirm: NEW })).status).toBe(400); // used
    expect((await c.call("GET", "/api/pipeline")).status).toBe(401); // old session ended
    expect((await c.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW })).status).toBe(401);
    r = await c.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: NEW });
    expect(r.body.next).toBe("totp"); // authenticator unchanged
    await app.close();
  });

  it("a failing mail server never breaks register or approve; the failure is in the audit", async () => {
    sent.length = 0;
    const app = await mk({ ...MAIL_ENV, ADMIN_NOTIFY: "bounce@onesmarter.com" });
    const c = client(app);
    const r = await c.call("POST", "/api/auth/register", { full_name: "Hansa V", email: "hansa@onesmarter.com", password: PW, confirm: PW });
    expect(r.status).toBe(201);
    await settle();
    const sup = client(app);
    await sup.call("POST", "/api/auth/register", { full_name: "Vikram Sethi", email: "vikram@onesmarter.com", password: PW, confirm: PW });
    const l = await sup.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    await sup.call("POST", "/api/auth/2fa/enroll", { code: totpCode(l.body.secret as string) });
    const audit = (await sup.call("GET", "/api/audit")).body.rows as Array<{ action: string; detail: string }>;
    expect(audit.find((a) => a.action === "mail_failed")!.detail).toMatch(/550 mailbox unavailable/);
    await app.close();
  });

  it("without SMTP settings nothing is sent and forgot says so", async () => {
    const app = await buildApp({ gw, ledger: openLedger(":memory:"), env: ENV, authDbPath: ":memory:" });
    const c = client(app);
    const r = await c.call("POST", "/api/auth/forgot", { email: "x@y.com" });
    expect(r.body.message).toMatch(/not set up/);
    expect((await app.inject({ method: "GET", url: "/api/health" })).json().mail).toBe(false);
    await app.close();
  });
});

describe("review 7 Nov 2026 fixes", () => {
  const mk = async (env: Record<string, string> = ENV, sendMail?: (m: { to: string; subject: string; text: string }) => Promise<void>) =>
    buildApp({ gw, ledger: openLedger(":memory:"), env, authDbPath: ":memory:", ...(sendMail ? { sendMail } : {}) });
  const signUp = async (app: FastifyInstance) => {
    const sup = client(app);
    await sup.call("POST", "/api/auth/register", { full_name: "Vikram Sethi", email: "vikram@onesmarter.com", password: PW, confirm: PW });
    const l = await sup.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    await sup.call("POST", "/api/auth/2fa/enroll", { code: totpCode(l.body.secret as string) });
    return sup;
  };

  it("A2: an admin resets a person's two-factor; the next sign-in shows a new QR code; not for your own account", async () => {
    const app = await mk();
    const sup = await signUp(app);
    const mem = client(app);
    await mem.call("POST", "/api/auth/register", { full_name: "Hansa V", email: "hansa@onesmarter.com", password: PW, confirm: PW });
    const users = (await sup.call("GET", "/api/users")).body.users as Array<{ id: string; email: string }>;
    const h = users.find((u) => u.email === "hansa@onesmarter.com")!;
    const me = users.find((u) => u.email === "vikram@onesmarter.com")!;
    await sup.call("POST", `/api/users/${h.id}/approve`, { role: "member" });
    const l = await mem.call("POST", "/api/auth/login", { email: "hansa@onesmarter.com", password: PW });
    await mem.call("POST", "/api/auth/2fa/enroll", { code: totpCode(l.body.secret as string) });
    expect((await mem.call("GET", "/api/pipeline")).status).toBe(200);

    expect((await sup.call("POST", `/api/users/${h.id}/reset-2fa`, {})).status).toBe(200);
    expect((await mem.call("GET", "/api/pipeline")).status).toBe(401); // signed out at once
    const again = await mem.call("POST", "/api/auth/login", { email: "hansa@onesmarter.com", password: PW });
    expect(again.body.next).toBe("enroll");
    expect((await sup.call("POST", `/api/users/${me.id}/reset-2fa`, {})).status).toBe(409);
    const audit = (await sup.call("GET", "/api/audit")).body.rows as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toContain("reset_two_factor");
    await app.close();
  });

  it("A3: a made-up X-Forwarded-For does not get around the sign-in limit", async () => {
    const app = await mk();
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": `10.0.0.${i}`, "x-requested-with": "x", "content-type": "application/json" }, payload: { email: "a@b.com", password: "wrong wrong wrong" } });
      codes.push(res.statusCode);
    }
    expect(codes).toContain(429);
    await app.close();
  });

  it("A4: open mode refuses changes without the console header and sends no CORS header", async () => {
    const app = await buildApp({ gw, ledger: openLedger(":memory:"), env: {} });
    const evil = await app.inject({ method: "POST", url: "/api/pipeline/x%40y.com/approve", headers: { origin: "https://evil.example" } });
    expect(evil.statusCode).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const read = await app.inject({ method: "GET", url: "/api/health", headers: { origin: "https://evil.example" } });
    expect(read.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("B3: test-mail needs the two-factor step, not only the password", async () => {
    const sent: unknown[] = [];
    const env = { ...ENV, SMTP_HOST: "smtp.x.com", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "p", MAIL_FROM: "x@onesmarter.com" };
    const app = await mk(env, async (m) => { sent.push(m); });
    const sup = await signUp(app);
    sup.forgetCookie();
    await sup.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW }); // password only
    expect((await sup.call("POST", "/api/auth/test-mail", {})).status).toBe(401);
    expect(sent).toHaveLength(0);
    await app.close();
  });

  it("B4: the same authenticator code works once", async () => {
    const app = await mk();
    const sup = client(app);
    await sup.call("POST", "/api/auth/register", { full_name: "Vikram Sethi", email: "vikram@onesmarter.com", password: PW, confirm: PW });
    const l = await sup.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    const secret = l.body.secret as string;
    await sup.call("POST", "/api/auth/2fa/enroll", { code: totpCode(secret) });
    sup.forgetCookie();
    await sup.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    const next = totpCode(secret, Date.now() + 30_000);
    expect((await sup.call("POST", "/api/auth/2fa/verify", { code: next })).status).toBe(200);
    sup.forgetCookie();
    await sup.call("POST", "/api/auth/login", { email: "vikram@onesmarter.com", password: PW });
    const again = await sup.call("POST", "/api/auth/2fa/verify", { code: next });
    expect(again.status).toBe(400); expect(again.body.error).toMatch(/already used/);
    await app.close();
  });

  it("B2: checking a reset link does not use it up; only a good password does", () => {
    const s = new AuthStore(":memory:");
    const u = s.createUser({ email: "a@onesmarter.com", full_name: "A B", password_hash: "x", role: "member", status: "active" });
    s.createReset(u.id, "hash-1", 60_000);
    expect(s.peekReset("hash-1")?.id).toBe(u.id);
    expect(s.peekReset("hash-1")?.id).toBe(u.id); // still there: a weak password changes nothing
    expect(s.consumeReset("hash-1")?.id).toBe(u.id);
    expect(s.peekReset("hash-1")).toBeUndefined();
  });

  it("B5: a bad or unknown search or run id is 400 or 404, not 500", async () => {
    const app = await buildApp({ gw, ledger: openLedger(":memory:"), env: {} });
    expect((await app.inject({ method: "GET", url: "/api/search/not-an-id" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/search/jobs-00000000-0000-0000-0000-000000000000" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/runs/not-an-id" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/runs/mcp-00000000-0000-0000-0000-000000000000" })).statusCode).toBe(404);
    await app.close();
  });
});
