/**
 * Passwords, one-time codes and secrets for the portal's user accounts. Node's own crypto only: no native module
 * to build on Windows.
 *
 * - Passwords: scrypt with a random 16-byte salt (N=2^15), stored as "scrypt$N$salt$hash", compared in constant time.
 * - Two-factor: TOTP as in RFC 6238 (HMAC-SHA1, 30-second steps, 6 digits), the same scheme Google Authenticator,
 *   Microsoft Authenticator and 1Password use. One step of clock drift either way is accepted.
 * - The TOTP secret is encrypted at rest with AES-256-GCM under AUTH_SECRET from .env.
 * - Recovery codes: ten random codes, stored hashed (SHA-256), each usable once.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const N = 2 ** 15;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !n || !salt || !hash) return false;
  const got = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64"), 32, { N: Number(n), r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const want = Buffer.from(hash, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Why a password is not allowed, or undefined when it is fine. */
export function passwordProblem(password: string, email = ""): string | undefined {
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (password.length > 200) return "Password is too long.";
  const low = password.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(low) || /^(0123456789|1234567890|abcdefghijkl|qwertyuiop)/.test(low)) return "That password is too common. Choose something longer and less predictable.";
  const local = email.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && low.includes(local)) return "Password must not contain your email name.";
  return undefined;
}
const COMMON = new Set(["password1234", "passwordpassword", "123456789012", "qwertyuiop12", "administrator", "letmeinletmein", "welcome12345", "iloveyou1234", "changeme1234", "password2026", "onesmarter123", "outreach1234"]);

// ---- TOTP ----
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export function totpCode(secretB32: string, at = Date.now(), step = 30): string {
  const counter = Math.floor(at / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac("sha1", base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}

/** True when `code` matches the current 30-second step or the one before or after it. */
export function totpMatches(secretB32: string, code: string, at = Date.now()): boolean {
  const c = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  return [-1, 0, 1].some((d) => {
    const want = totpCode(secretB32, at + d * 30_000);
    return want.length === c.length && timingSafeEqual(Buffer.from(want), Buffer.from(c));
  });
}

export function otpauthUrl(secretB32: string, email: string, issuer = "Outreach Console"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---- secrets at rest ----
function key(authSecret: string): Buffer { return createHash("sha256").update(authSecret).digest(); }

export function encryptText(plain: string, authSecret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(authSecret), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${enc.toString("base64")}`;
}
export function decryptText(stored: string, authSecret: string): string {
  const [v, iv, tag, enc] = stored.split(".");
  if (v !== "v1" || !iv || !tag || !enc) throw new Error("Unreadable secret");
  const d = createDecipheriv("aes-256-gcm", key(authSecret), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
}

// ---- recovery codes and ids ----
export function newRecoveryCodes(n = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let s = "";
    for (let j = 0; j < 10; j++) s += "abcdefghjkmnpqrstuvwxyz23456789"[randomInt(31)];
    out.push(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return out;
}
export const sha256 = (s: string): string => createHash("sha256").update(s.replace(/[\s-]/g, "").toLowerCase()).digest("hex");
export const newId = (): string => randomBytes(32).toString("base64url");
