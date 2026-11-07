/**
 * Sign-in for the portal: local accounts with a password and a six-digit code from an authenticator app, approved
 * registration, roles, sessions in an HttpOnly cookie, and an audit trail.
 *
 * Turned on by SUPERUSER_EMAIL in .env (one or more addresses, comma-separated). Those addresses register like
 * anyone else but come out approved and admin, so the first administrator needs nobody's approval. AUTH_SECRET
 * (any long random string) must be set too; it encrypts the two-factor secrets at rest.
 *
 * Without SUPERUSER_EMAIL the API behaves as before: open, or guarded by the shared API_TOKEN.
 * With it, every /api route needs a signed-in session (or API_TOKEN as a service token for scripts).
 *
 * Routes (all under /api/auth so the dev proxy covers them):
 *   POST register {full_name,email,password,confirm}   -> {status: "pending" | "active"}
 *   POST login {email,password}                        -> {next: "totp"} | {next: "enroll", otpauth_url, secret}
 *   POST 2fa/enroll {code}  (first sign-in)            -> {user, recovery_codes}
 *   POST 2fa/verify {code}  (code or a recovery code)  -> {user, recovery_codes_left}
 *   POST logout, GET me
 * Admin: GET /api/users, POST /api/users/:id/approve {role} | reject {reason} | disable | enable | reset-2fa | role {role}, GET /api/audit
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { decryptText, encryptText, hashPassword, newId, newRecoveryCodes, newTotpSecret, otpauthUrl, passwordProblem, sha256, totpMatchStep, verifyPassword } from "./crypto.js";
import { templates, type MailMessage, type MailSettings, type SendMail } from "./mail.js";
import { AuthStore, type Role, type Session, type User } from "./store.js";

export interface AuthOptions {
  store: AuthStore;
  superusers: string[];
  authSecret: string;
  /** Shared machine token (API_TOKEN), still accepted for scripts and Claude Desktop. */
  serviceToken?: string;
  cookieSecure?: boolean;
  idleMs?: number;
  maxMs?: number;
  now?: () => number;
  /** Email settings and sender; absent means no mail is sent. */
  mail?: { settings: MailSettings; send: SendMail };
}

export interface Actor { id: string | null; label: string; role: Role | "service" | "anonymous" }
export interface RequestAuth { user?: User; session?: Session; actor: Actor }

const COOKIE = "outreach_session";
const IDLE_MS = 12 * 3_600_000;
const MAX_MS = 7 * 24 * 3_600_000;

const httpError = (status: number, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { statusCode: status, ...extra });

export const publicUser = (u: User) => ({
  id: u.id, email: u.email, full_name: u.full_name, role: u.role, status: u.status,
  two_factor: Boolean(u.totp_secret_enc), created_at: u.created_at, approved_at: u.approved_at, last_sign_in_at: u.last_sign_in_at,
});

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

// req.ip only. Behind a real proxy set TRUST_PROXY in .env, so Fastify reads X-Forwarded-For from that proxy alone;
// a header any client can type must never decide the rate limit.
const ipOf = (req: FastifyRequest): string => req.ip || "";

/** The signed-in person (or the service token, or nobody) behind a request; set by the auth hook. */
export function authOf(req: FastifyRequest): RequestAuth {
  return ((req as FastifyRequest & { auth?: RequestAuth }).auth) ?? { actor: { id: null, label: "anonymous", role: "anonymous" } };
}

/**
 * Registers the hook and routes. Returns `audit(req, action, target, detail)` for the other routes to call, so
 * approvals, runs and settings changes carry the person's name.
 */
export function registerAuth(app: FastifyInstance, o: AuthOptions): { audit: (req: FastifyRequest, action: string, target?: string, detail?: string) => void } {
  const { store } = o;
  const superusers = new Set(o.superusers.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const isSuper = (email: string) => superusers.has(email.toLowerCase());
  const idleMs = o.idleMs ?? IDLE_MS;
  const maxMs = o.maxMs ?? MAX_MS;
  const now = o.now ?? Date.now;
  const audit = (req: FastifyRequest, action: string, target?: string, detail?: string) => {
    const a = authOf(req).actor;
    store.audit({ actor_id: a.id, actor: a.label, action, ...(target ? { target } : {}), ...(detail ? { detail } : {}), ip: ipOf(req) });
  };
  const RESET_MINUTES = 30;
  const portalUrl = o.mail?.settings.portalUrl ?? "";
  /** Sends in the background and records the outcome; a mail problem never fails the request that caused it. */
  const mail = (m: MailMessage, why: string): void => {
    if (!o.mail) return;
    void o.mail.send(m)
      .then(() => store.audit({ actor: "system", action: "mail_sent", target: m.to, detail: why }))
      .catch((err: Error) => store.audit({ actor: "system", action: "mail_failed", target: m.to, detail: `${why}: ${(err.message.split("\n")[0] ?? "").slice(0, 200)}` }));
  };
  const mailAdmins = (m: Omit<MailMessage, "to">, why: string): void => {
    if (!o.mail) return;
    const to = o.mail.settings.adminNotify.length ? o.mail.settings.adminNotify : store.listUsers().filter((u) => u.role === "admin" && u.status === "active").map((u) => u.email);
    for (const t of to) mail({ ...m, to: t }, why);
  };

  // Simple per-address limit on the sign-in and register routes: 10 a minute.
  const recent = new Map<string, number[]>();
  const rateLimited = (ip: string): boolean => {
    const t = now();
    const arr = (recent.get(ip) ?? []).filter((x) => t - x < 60_000);
    arr.push(t); recent.set(ip, arr);
    if (recent.size > 5000) recent.clear();
    return arr.length > 10;
  };

  const setCookie = (reply: FastifyReply, id: string | null) => {
    const secure = o.cookieSecure ? "; Secure" : "";
    reply.header("set-cookie", id
      ? `${COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxMs / 1000)}${secure}`
      : `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  };

  let lastSweep = 0;

  // ---- who is this? ----
  app.addHook("onRequest", async (req, reply) => {
    const r = req as FastifyRequest & { auth?: RequestAuth };
    r.auth = { actor: { id: null, label: "anonymous", role: "anonymous" } };
    if (now() - lastSweep > 10 * 60_000) { store.sweepSessions(idleMs, maxMs); lastSweep = now(); }

    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    if (o.serviceToken && bearer && bearer === o.serviceToken) { r.auth = { actor: { id: null, label: "service", role: "service" } }; return; }

    const sid = readCookie(req, COOKIE);
    if (sid) {
      const s = store.session(sid);
      if (s) {
        const idle = now() - Date.parse(s.last_seen_at) > idleMs;
        const old = now() - Date.parse(s.created_at) > maxMs;
        const user = store.userById(s.user_id);
        if (!idle && !old && user && user.status === "active") {
          store.touchSession(s.id);
          r.auth = { user, session: s, actor: { id: user.id, label: `${user.full_name} <${user.email}>`, role: user.role } };
        } else {
          store.endSession(s.id);
          setCookie(reply, null);
        }
      }
    }

    const url = req.url.split("?")[0]!;
    if (!url.startsWith("/api/")) return;
    if (url === "/api/health" || url.startsWith("/api/auth/")) return;
    const a = r.auth;
    if (a.actor.role === "service") return;
    if (!a.session || a.session.stage !== "full") return reply.code(401).send({ error: "Sign in required." });
    // Cross-site forms cannot set custom headers; the console always sends this one on changes.
    if (req.method !== "GET" && req.method !== "HEAD" && !req.headers["x-requested-with"]) return reply.code(403).send({ error: "Missing request header." });
    if (url.startsWith("/api/users") || url.startsWith("/api/audit")) {
      if (a.user!.role !== "admin") return reply.code(403).send({ error: "Only an administrator can do that." });
    }
  });

  const requireStage = (req: FastifyRequest, stage: Session["stage"]): { user: User; session: Session } => {
    const a = authOf(req);
    if (!a.session || !a.user || a.session.stage !== stage) throw httpError(401, "Sign in first.");
    return { user: a.user, session: a.session };
  };

  // ---- register ----
  app.post("/api/auth/register", async (req, reply) => {
    if (rateLimited(ipOf(req))) throw httpError(429, "Too many attempts from this address. Wait a minute.");
    const b = z.object({ full_name: z.string().trim().min(2).max(100), email: z.string().trim().toLowerCase().email().max(200), password: z.string(), confirm: z.string() }).parse(req.body);
    if (b.password !== b.confirm) throw httpError(400, "The two passwords do not match.");
    const bad = passwordProblem(b.password, b.email);
    if (bad) throw httpError(400, bad);
    if (store.userByEmail(b.email)) throw httpError(409, "An account with this email already exists. Sign in, or ask an administrator.");
    const sup = isSuper(b.email);
    const user = store.createUser({ email: b.email, full_name: b.full_name, password_hash: await hashPassword(b.password), role: sup ? "admin" : "member", status: sup ? "active" : "pending", ...(sup ? { approved_by: "superuser (.env)" } : {}) });
    store.audit({ actor_id: user.id, actor: `${user.full_name} <${user.email}>`, action: sup ? "register_superuser" : "register", ip: ipOf(req) });
    if (!sup) mailAdmins(templates.accessRequested(portalUrl, user), `access request from ${user.email}`);
    return reply.code(201).send({ status: user.status });
  });

  // ---- sign in ----
  app.post("/api/auth/login", async (req, reply) => {
    const ip = ipOf(req);
    if (rateLimited(ip)) throw httpError(429, "Too many attempts from this address. Wait a minute.");
    const b = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) }).parse(req.body);
    const wait = store.lockedFor(b.email);
    if (wait) throw httpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? "s" : ""}.`);
    const user = store.userByEmail(b.email);
    const ok = user ? await verifyPassword(b.password, user.password_hash) : (await verifyPassword(b.password, DUMMY_HASH), false);
    store.recordAttempt(b.email, ok, ip);
    if (!ok || !user) { store.audit({ actor: b.email, action: "sign_in_failed", ip }); throw httpError(401, "Email or password is wrong."); }
    if (user.status === "pending") throw httpError(403, "Your request is waiting for an administrator's approval.", { code: "PENDING" });
    if (user.status === "disabled") throw httpError(403, "This account is disabled. Ask an administrator.", { code: "DISABLED" });
    if (!user.totp_secret_enc) {
      const secret = newTotpSecret();
      const s = store.createSession(user.id, "enroll", ip, String(req.headers["user-agent"] ?? ""), encryptText(secret, o.authSecret));
      setCookie(reply, s.id);
      return { next: "enroll", otpauth_url: otpauthUrl(secret, user.email), secret };
    }
    const s = store.createSession(user.id, "password", ip, String(req.headers["user-agent"] ?? ""));
    setCookie(reply, s.id);
    return { next: "totp" };
  });

  // ---- two-factor: first-time setup ----
  app.post("/api/auth/2fa/enroll", async (req) => {
    const { user, session } = requireStage(req, "enroll");
    const b = z.object({ code: z.string().trim() }).parse(req.body);
    const secret = session.pending_secret ? decryptText(session.pending_secret, o.authSecret) : "";
    const step = secret ? totpMatchStep(secret, b.code, now()) : undefined;
    if (step === undefined) throw httpError(400, "That code did not match. Check the time on your phone and try the next code.");
    store.setTotp(user.id, encryptText(secret, o.authSecret));
    store.acceptTotpStep(user.id, step);
    const codes = newRecoveryCodes();
    store.setRecoveryCodes(user.id, codes);
    store.setStage(session.id, "full");
    store.touchSignIn(user.id);
    store.audit({ actor_id: user.id, actor: `${user.full_name} <${user.email}>`, action: "two_factor_enrolled", ip: ipOf(req) });
    store.audit({ actor_id: user.id, actor: `${user.full_name} <${user.email}>`, action: "sign_in", ip: ipOf(req) });
    return { user: publicUser(user), recovery_codes: codes };
  });

  // ---- two-factor: every sign-in ----
  app.post("/api/auth/2fa/verify", async (req) => {
    const { user, session } = requireStage(req, "password");
    const b = z.object({ code: z.string().trim() }).parse(req.body);
    const secret = user.totp_secret_enc ? decryptText(user.totp_secret_enc, o.authSecret) : "";
    const step = secret ? totpMatchStep(secret, b.code, now()) : undefined;
    const reused = step !== undefined && !store.acceptTotpStep(user.id, step);
    const byApp = step !== undefined && !reused;
    const byRecovery = !byApp && !reused && /^[a-z0-9]{5}-?[a-z0-9]{5}$/i.test(b.code) && store.useRecoveryCode(user.id, b.code);
    if (reused) throw httpError(400, "That code was already used. Wait for the next code in your app.");
    if (!byApp && !byRecovery) {
      store.recordAttempt(user.email, false, ipOf(req));
      const wait = store.lockedFor(user.email);
      if (wait) { store.endSession(session.id); throw httpError(429, "Too many wrong codes. Sign in again in 15 minutes."); }
      throw httpError(400, "That code did not match.");
    }
    store.setStage(session.id, "full");
    store.touchSignIn(user.id);
    store.audit({ actor_id: user.id, actor: `${user.full_name} <${user.email}>`, action: byRecovery ? "sign_in_recovery_code" : "sign_in", ip: ipOf(req) });
    return { user: publicUser(user), recovery_codes_left: store.recoveryCodesLeft(user.id) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const a = authOf(req);
    if (a.session) { store.endSession(a.session.id); if (a.user) store.audit({ actor_id: a.user.id, actor: a.actor.label, action: "sign_out", ip: ipOf(req) }); }
    setCookie(reply, null);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    const a = authOf(req);
    if (!a.session || !a.user) throw httpError(401, "Not signed in.");
    return {
      stage: a.session.stage,
      user: publicUser(a.user),
      superuser: isSuper(a.user.email),
      ...(a.user.role === "admin" && a.session.stage === "full" ? { pending_users: store.countPending() } : {}),
    };
  });

  // ---- forgot password -> mailed link -> new password ----
  app.post("/api/auth/forgot", async (req) => {
    if (rateLimited(ipOf(req))) throw httpError(429, "Too many attempts from this address. Wait a minute.");
    const b = z.object({ email: z.string().trim().toLowerCase().max(200) }).parse(req.body);
    const user = store.userByEmail(b.email);
    // Same answer whether or not the address exists, so the form cannot be used to find accounts.
    const answer = { ok: true, message: o.mail ? "If that address has an account, a reset link is on its way. It works for 30 minutes." : "Email is not set up on this server. Ask an administrator to reset your password." };
    if (!user || user.status !== "active" || !o.mail) { store.audit({ actor: b.email, action: "password_reset_requested", detail: user ? user.status : "no such account", ip: ipOf(req) }); return answer; }
    const token = newId();
    store.createReset(user.id, sha256(token), RESET_MINUTES * 60_000);
    store.audit({ actor_id: user.id, actor: `${user.full_name} <${user.email}>`, action: "password_reset_requested", ip: ipOf(req) });
    mail({ ...templates.passwordReset(portalUrl, user, token, RESET_MINUTES), to: user.email }, "password reset");
    return answer;
  });

  app.post("/api/auth/reset", async (req) => {
    if (rateLimited(ipOf(req))) throw httpError(429, "Too many attempts from this address. Wait a minute.");
    const b = z.object({ token: z.string().min(10).max(200), password: z.string(), confirm: z.string() }).parse(req.body);
    if (b.password !== b.confirm) throw httpError(400, "The two passwords do not match.");
    // Check the password before using up the link: a weak password leaves the link as it was, with its first expiry time.
    const holder = store.peekReset(sha256(b.token));
    if (!holder) throw httpError(400, "This reset link is not valid any more. Ask for a new one.");
    const bad = passwordProblem(b.password, holder.email);
    if (bad) throw httpError(400, bad);
    const user = store.consumeReset(sha256(b.token));
    if (!user) throw httpError(400, "This reset link is not valid any more. Ask for a new one.");
    store.setPassword(user.id, await hashPassword(b.password)); // also ends every session
    store.audit({ actor_id: user.id, actor: `${user.full_name} <${user.email}>`, action: "password_reset", ip: ipOf(req) });
    return { ok: true };
  });

  /** Admin: a test mail to the admin's own address, so SMTP settings can be checked from the portal. */
  app.post("/api/auth/test-mail", async (req) => {
    const a = authOf(req);
    if (!a.session || a.session.stage !== "full") throw httpError(401, "Sign in first.");
    if (!a.user || a.user.role !== "admin") throw httpError(403, "Only an administrator can do that.");
    if (!o.mail) throw httpError(409, "Email is not set up: add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM to .env and restart the backend.");
    try {
      await o.mail.send({ ...templates.test(portalUrl, a.actor.label), to: a.user.email });
    } catch (err) {
      store.audit({ actor: "system", action: "mail_failed", target: a.user.email, detail: `test: ${((err as Error).message.split("\n")[0] ?? "").slice(0, 200)}` });
      throw httpError(502, `The mail server refused: ${((err as Error).message.split("\n")[0] ?? "")}`);
    }
    store.audit({ actor_id: a.user.id, actor: a.actor.label, action: "mail_test", target: a.user.email, ip: ipOf(req) });
    return { ok: true, to: a.user.email, from: o.mail.settings.from };
  });

  // ---- admin: people ----
  const target = (req: FastifyRequest): User => {
    const u = store.userById((req.params as { id: string }).id);
    if (!u) throw httpError(404, "No such user.");
    return u;
  };
  const guardSuper = (u: User, what: string) => { if (isSuper(u.email)) throw httpError(409, `${u.email} is a superuser (SUPERUSER_EMAIL in .env) and cannot be ${what} from here.`); };

  app.get("/api/users", async () => ({ users: store.listUsers().map((u) => ({ ...publicUser(u), superuser: isSuper(u.email), approved_by: u.approved_by })), pending: store.countPending() }));

  app.post("/api/users/:id/approve", async (req) => {
    const u = target(req);
    const b = z.object({ role: z.enum(["admin", "member"]).default("member") }).parse(req.body ?? {});
    if (u.status !== "pending") throw httpError(409, `${u.email} is already ${u.status}.`);
    store.setRole(u.id, b.role);
    store.setStatus(u.id, "active", authOf(req).actor.label);
    audit(req, "approve_user", u.email, `role ${b.role}`);
    mail({ ...templates.approved(portalUrl, u, b.role), to: u.email }, "approved");
    return { user: publicUser(store.userById(u.id)!) };
  });
  app.post("/api/users/:id/reject", async (req) => {
    const u = target(req);
    guardSuper(u, "rejected");
    const b = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    if (u.status !== "pending") throw httpError(409, `${u.email} is ${u.status}; use Disable instead.`);
    store.deleteUser(u.id);
    audit(req, "reject_user", u.email, b.reason);
    mail({ ...templates.rejected(u, b.reason), to: u.email }, "rejected");
    return { ok: true };
  });
  app.post("/api/users/:id/disable", async (req) => {
    const u = target(req);
    guardSuper(u, "disabled");
    if (u.id === authOf(req).user?.id) throw httpError(409, "You cannot disable your own account.");
    store.setStatus(u.id, "disabled", authOf(req).actor.label);
    audit(req, "disable_user", u.email);
    return { user: publicUser(store.userById(u.id)!) };
  });
  app.post("/api/users/:id/enable", async (req) => {
    const u = target(req);
    if (u.status !== "disabled") throw httpError(409, `${u.email} is ${u.status}.`);
    store.setStatus(u.id, "active", authOf(req).actor.label);
    audit(req, "enable_user", u.email);
    return { user: publicUser(store.userById(u.id)!) };
  });
  /** Lost phone and recovery codes: the person's next sign-in sets up a new authenticator. */
  app.post("/api/users/:id/reset-2fa", async (req) => {
    const u = target(req);
    if (u.id === authOf(req).user?.id) throw httpError(409, "Ask another administrator to reset your own two-factor.");
    if (!u.totp_secret_enc) throw httpError(409, `${u.email} has no two-factor set up yet.`);
    store.resetTwoFactor(u.id);
    audit(req, "reset_two_factor", u.email);
    return { user: publicUser(store.userById(u.id)!) };
  });
  app.post("/api/users/:id/role", async (req) => {
    const u = target(req);
    const b = z.object({ role: z.enum(["admin", "member"]) }).parse(req.body);
    if (b.role !== "admin") { guardSuper(u, "demoted"); if (u.id === authOf(req).user?.id) throw httpError(409, "You cannot remove your own admin role."); }
    store.setRole(u.id, b.role);
    audit(req, "change_role", u.email, b.role);
    return { user: publicUser(store.userById(u.id)!) };
  });

  app.get("/api/audit", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    return { rows: store.auditRows(q.limit) };
  });

  return { audit };
}

// A real scrypt hash of a random password, so a sign-in for an unknown email takes as long as a wrong password.
const DUMMY_HASH = "scrypt$32768$k0vS0bS8a1x6Z2wq5E0hLg==$2bM5x3Q6uY6l0c3J1xX8YbQmS8kQxkJ7q4pL1nF0Y3o=";
