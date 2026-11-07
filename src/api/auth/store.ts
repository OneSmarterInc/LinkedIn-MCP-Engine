/**
 * Users, sessions, recovery codes, sign-in attempts and the audit trail, in one SQLite file (data/users.sqlite).
 * The Google Sheet stays the record of emails; this file is the record of people.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { newId, sha256 } from "./crypto.js";

export type Role = "admin" | "member";
export type UserStatus = "pending" | "active" | "disabled";
export type SessionStage = "password" | "enroll" | "full";

export interface User {
  id: string; email: string; full_name: string; role: Role; status: UserStatus;
  password_hash: string; totp_secret_enc: string | null; created_at: string; totp_last_step?: number | null;
  approved_by: string | null; approved_at: string | null; rejected_reason: string | null; last_sign_in_at: string | null;
}
export interface Session { id: string; user_id: string; stage: SessionStage; created_at: string; last_seen_at: string; ip: string; user_agent: string; pending_secret: string | null }
export interface AuditRow { id: number; at: string; actor_id: string | null; actor: string; action: string; target: string | null; detail: string | null; ip: string | null }

const now = () => new Date().toISOString();

export class AuthStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','member')),
        status TEXT NOT NULL CHECK (status IN ('pending','active','disabled')),
        password_hash TEXT NOT NULL, totp_secret_enc TEXT, created_at TEXT NOT NULL,
        approved_by TEXT, approved_at TEXT, rejected_reason TEXT, last_sign_in_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, stage TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '', pending_secret TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS recovery_codes (user_id TEXT NOT NULL, code_hash TEXT NOT NULL, used_at TEXT, PRIMARY KEY (user_id, code_hash));
      CREATE TABLE IF NOT EXISTS login_attempts (email TEXT NOT NULL, at TEXT NOT NULL, ok INTEGER NOT NULL, ip TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS login_attempts_email ON login_attempts(email, at);
      CREATE TABLE IF NOT EXISTS password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL,
        target TEXT, detail TEXT, ip TEXT
      );
    `);
    // Added 7 Nov 2026: the last accepted two-factor step, so one code works once. Older databases get the column here.
    const cols = (this.db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("totp_last_step")) this.db.exec("ALTER TABLE users ADD COLUMN totp_last_step INTEGER");
  }

  // ---- users ----
  userByEmail(email: string): User | undefined {
    return this.db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as User | undefined;
  }
  userById(id: string): User | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
  }
  createUser(u: { email: string; full_name: string; password_hash: string; role: Role; status: UserStatus; approved_by?: string }): User {
    const id = newId().slice(0, 22);
    const t = now();
    this.db.prepare("INSERT INTO users (id,email,full_name,role,status,password_hash,created_at,approved_by,approved_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, u.email.trim().toLowerCase(), u.full_name.trim(), u.role, u.status, u.password_hash, t, u.approved_by ?? null, u.status === "active" ? t : null);
    return this.userById(id)!;
  }
  listUsers(): User[] {
    return this.db.prepare("SELECT * FROM users ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, created_at DESC").all() as unknown as User[];
  }
  countPending(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").get() as { n: number }).n);
  }
  setStatus(id: string, status: UserStatus, by: string, reason?: string): void {
    this.db.prepare("UPDATE users SET status = ?, approved_by = CASE WHEN ? = 'active' THEN ? ELSE approved_by END, approved_at = CASE WHEN ? = 'active' THEN ? ELSE approved_at END, rejected_reason = ? WHERE id = ?")
      .run(status, status, by, status, now(), reason ?? null, id);
    if (status !== "active") this.endSessionsFor(id);
  }
  setRole(id: string, role: Role): void { this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id); }
  deleteUser(id: string): void { this.endSessionsFor(id); this.db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(id); this.db.prepare("DELETE FROM users WHERE id = ?").run(id); }
  setTotp(id: string, secretEnc: string): void { this.db.prepare("UPDATE users SET totp_secret_enc = ?, totp_last_step = NULL WHERE id = ?").run(secretEnc, id); }
  /**
   * Records a two-factor step as used. False when this step, or a later one, was already used: the code is refused,
   * so a code seen over someone's shoulder cannot be typed in again.
   */
  acceptTotpStep(id: string, step: number): boolean {
    const r = this.db.prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)").run(step, id, step);
    return Number(r.changes) > 0;
  }
  /** Lost phone: forget the authenticator and the recovery codes; the next sign-in shows a new QR code. */
  resetTwoFactor(id: string): void {
    this.db.prepare("UPDATE users SET totp_secret_enc = NULL, totp_last_step = NULL WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(id);
    this.endSessionsFor(id);
  }
  touchSignIn(id: string): void { this.db.prepare("UPDATE users SET last_sign_in_at = ? WHERE id = ?").run(now(), id); }

  // ---- sessions ----
  createSession(userId: string, stage: SessionStage, ip: string, userAgent: string, pendingSecret?: string): Session {
    const id = newId();
    const t = now();
    this.db.prepare("INSERT INTO sessions (id,user_id,stage,created_at,last_seen_at,ip,user_agent,pending_secret) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, userId, stage, t, t, ip.slice(0, 64), userAgent.slice(0, 200), pendingSecret ?? null);
    return this.session(id)!;
  }
  session(id: string): Session | undefined { return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Session | undefined; }
  setStage(id: string, stage: SessionStage): void { this.db.prepare("UPDATE sessions SET stage = ?, pending_secret = NULL, last_seen_at = ? WHERE id = ?").run(stage, now(), id); }
  touchSession(id: string): void { this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now(), id); }
  endSession(id: string): void { this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id); }
  endSessionsFor(userId: string): void { this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId); }
  /** Drops sessions idle for more than `idleMs` or older than `maxMs`. */
  sweepSessions(idleMs: number, maxMs: number): void {
    const t = Date.now();
    this.db.prepare("DELETE FROM sessions WHERE last_seen_at < ? OR created_at < ?").run(new Date(t - idleMs).toISOString(), new Date(t - maxMs).toISOString());
  }

  // ---- recovery codes ----
  setRecoveryCodes(userId: string, codes: string[]): void {
    this.db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
    const ins = this.db.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)");
    for (const c of codes) ins.run(userId, sha256(c));
  }
  /** Marks a recovery code used; true when it was valid and unused. */
  useRecoveryCode(userId: string, code: string): boolean {
    const r = this.db.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").run(now(), userId, sha256(code));
    return Number(r.changes) === 1;
  }
  recoveryCodesLeft(userId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").get(userId) as { n: number }).n);
  }

  // ---- sign-in attempts and lockout ----
  recordAttempt(email: string, ok: boolean, ip: string): void {
    this.db.prepare("INSERT INTO login_attempts (email, at, ok, ip) VALUES (?,?,?,?)").run(email.trim().toLowerCase(), now(), ok ? 1 : 0, ip.slice(0, 64));
    this.db.prepare("DELETE FROM login_attempts WHERE at < ?").run(new Date(Date.now() - 24 * 3_600_000).toISOString());
  }
  /**
   * Seconds until this address may try this account again, or 0. Failures since the last success in the last 15
   * minutes count. With `ip`: five from that address lock it out (a stranger elsewhere cannot lock the real person
   * out), and twenty from all addresses together lock the account for everyone (a spread-out guessing attack).
   * Without `ip`: five from anywhere, as before.
   */
  lockedFor(email: string, ip?: string, perAddress = 5, windowMs = 15 * 60_000, allAddresses = 20): number {
    const rows = this.db.prepare("SELECT at, ok, ip FROM login_attempts WHERE email = ? AND at > ? ORDER BY at DESC")
      .all(email.trim().toLowerCase(), new Date(Date.now() - windowMs).toISOString()) as unknown as Array<{ at: string; ok: number; ip: string }>;
    const failed: Array<{ at: string; ip: string }> = [];
    for (const r of rows) { if (r.ok) break; failed.push(r); }
    const mine = ip === undefined ? failed : failed.filter((r) => r.ip === ip.slice(0, 64));
    const hit = mine.length >= perAddress ? mine : failed.length >= (ip === undefined ? perAddress : allAddresses) ? failed : undefined;
    if (!hit) return 0;
    return Math.max(1, Math.ceil((Date.parse(hit[0]!.at) + windowMs - Date.now()) / 1000));
  }

  // ---- password reset ----
  createReset(userId: string, tokenHash: string, ttlMs: number): void {
    this.db.prepare("DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?").run(userId, now());
    this.db.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)").run(tokenHash, userId, new Date(Date.now() + ttlMs).toISOString());
  }
  /** The user a live, unused reset token belongs to, without using it up. */
  peekReset(tokenHash: string): User | undefined {
    const r = this.db.prepare("SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").get(tokenHash, now()) as { user_id: string } | undefined;
    return r ? this.userById(r.user_id) : undefined;
  }
  /** The user a live, unused reset token belongs to; marks it used. */
  consumeReset(tokenHash: string): User | undefined {
    const r = this.db.prepare("SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").get(tokenHash, now()) as { user_id: string } | undefined;
    if (!r) return undefined;
    this.db.prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ?").run(now(), tokenHash);
    return this.userById(r.user_id);
  }
  setPassword(userId: string, hash: string): void {
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
    this.endSessionsFor(userId);
  }

  // ---- audit ----
  audit(e: { actor_id?: string | null; actor: string; action: string; target?: string; detail?: string; ip?: string }): void {
    this.db.prepare("INSERT INTO audit (at, actor_id, actor, action, target, detail, ip) VALUES (?,?,?,?,?,?,?)")
      .run(now(), e.actor_id ?? null, e.actor, e.action, e.target ?? null, e.detail ?? null, e.ip ?? null);
  }
  auditRows(limit = 200): AuditRow[] {
    return this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit) as unknown as AuditRow[];
  }

  close(): void { this.db.close(); }
}
