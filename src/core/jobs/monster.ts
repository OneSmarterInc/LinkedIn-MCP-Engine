/**
 * Monster job posts, read with a real browser.
 *
 * Monster draws its search results with JavaScript, so a plain HTTP read returns an empty page and JobSpy has no
 * Monster reader. This module opens the search page in headless Chromium (Playwright), takes the results JSON
 * the page fetches for itself, and falls back to the job cards on screen (their data-testid attributes) when no
 * JSON is seen. It returns the same shape JobSpy rows have, so everything after it (Seamless, gates, drafts,
 * Sheet) is unchanged.
 *
 * Turned on with JOBSPY_SITES=indeed,linkedin,monster. Needs once: npm i playwright && npx playwright install chromium.
 * A Monster failure is reported as a board error, like a LinkedIn 429; the other boards' jobs are kept.
 */
import { logger } from "../../lib/logger.js";
import type { JobSpyRow } from "./jobspy.js";

export interface MonsterOptions {
  location: string;
  hoursOld: number;
  timeoutMs: number;
  /** Pages to read at most (about 9-25 posts each). */
  maxPages?: number;
  /** Show the browser window. In this mode the reader waits up to two minutes on the first page, so a person can pass Monster's check by hand. */
  headless?: boolean;
  /** Folder that keeps cookies between runs, so a passed check is remembered. Default out/monster-profile. */
  profileDir?: string;
  /** "chrome" uses the installed Google Chrome (looks least like a robot); "chromium" the bundled browser. Default: chrome, then chromium. */
  channel?: "chrome" | "chromium";
  /** Test hook: another site that behaves like Monster. */
  baseUrl?: string;
}

/** The small part of Playwright this module touches, so tests can pass a fake or another Playwright. */
export interface BrowserLike {
  newPage(opts?: Record<string, unknown>): Promise<PageLike>;
  close(): Promise<void>;
}
export interface PageLike {
  on(event: "response", cb: (r: { url(): string; ok(): boolean; json(): Promise<unknown> }) => void): unknown;
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  waitForSelector(sel: string, opts?: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  $$eval<T>(sel: string, fn: (els: Element[]) => T): Promise<T>;
  close(): Promise<void>;
}
export interface LaunchOptions { headless: boolean; profileDir: string; channel?: "chrome" | "chromium" }
export type LaunchBrowser = (opts: LaunchOptions) => Promise<BrowserLike>;

const MONSTER = "https://www.monster.com";
const CARD = 'article[data-testid="svx_jobCard"]';
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/**
 * Default launcher. Opens a persistent browser profile (cookies survive between runs, so a check passed once by
 * hand is remembered), prefers the installed Google Chrome over Playwright's Chromium, and removes the two
 * automation tells Monster's bot check reads first: the "controlled by automated software" flag and
 * navigator.webdriver. Imported lazily so the backend starts without Playwright installed.
 */
export const launchChromium: LaunchBrowser = async ({ headless, profileDir, channel }) => {
  type Ctx = BrowserLike & { addInitScript(fn: () => void): Promise<void> };
  let pw: { chromium: { launchPersistentContext(dir: string, o: Record<string, unknown>): Promise<Ctx> } };
  try {
    pw = (await import("playwright")) as unknown as typeof pw;
  } catch {
    throw new MonsterSetupError('Playwright is not installed. In the backend folder run: npm i playwright  then  npx playwright install chromium');
  }
  const base = {
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
  };
  const tries: Array<"chrome" | "chromium"> = channel ? [channel] : ["chrome", "chromium"];
  let lastErr: Error | undefined;
  for (const ch of tries) {
    try {
      const ctx = await pw.chromium.launchPersistentContext(profileDir, ch === "chrome" ? { ...base, channel: "chrome" } : { ...base, userAgent: UA });
      await ctx.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
      logger.info({ channel: ch, headless, profileDir }, "monster browser");
      return ctx;
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw new MonsterSetupError(`No browser could be started for Monster (run: npx playwright install chromium, or install Google Chrome). ${(lastErr?.message ?? "").split("\n")[0]}`);
};

export class MonsterSetupError extends Error {}

/** "3 days ago", "Posted today", "2 hours ago", "30+ days ago" -> YYYY-MM-DD; undefined when unreadable. */
export function dateFromRecency(text: string | null | undefined, now = new Date()): string | undefined {
  const t = (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  const d = new Date(now);
  if (/\b(today|just now|moments? ago|hours? ago|minutes? ago|an hour ago)\b/.test(t)) return iso(d);
  if (/\byesterday\b/.test(t)) { d.setDate(d.getDate() - 1); return iso(d); }
  const m = /(\d+)\+?\s*(day|week|month)s?\s*ago/.exec(t);
  if (m) {
    const n = Number(m[1]) * (m[2] === "week" ? 7 : m[2] === "month" ? 30 : 1);
    d.setDate(d.getDate() - n);
    return iso(d);
  }
  const abs = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return abs ? abs[0] : undefined;
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** True when the post date is within `hoursOld` of now (a date-only post counts from the start of its day). Unknown dates pass. */
export function withinHours(datePosted: string | undefined, hoursOld: number, now = new Date()): boolean {
  if (!datePosted) return true;
  const t = Date.parse(datePosted.length === 10 ? `${datePosted}T00:00:00` : datePosted);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t <= hoursOld * 3_600_000 + 86_400_000; // a full extra day, since most posts carry a date without a time
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const pick = (o: unknown, ...keys: string[]): unknown => {
  for (const k of keys) {
    const v = k.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), o);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

/**
 * Rows from the JSON Monster's page fetches for itself. Field names follow the page's schema.org-style payload
 * (jobPosting.title, hiringOrganization.name, datePosted, jobLocation, url); a few spellings are accepted so a
 * small change on Monster's side does not blank the reader. Items without a title or link are dropped.
 */
export function rowsFromApiJson(json: unknown): JobSpyRow[] {
  const list = (pick(json, "jobResults", "results", "jobs", "data.jobResults", "data.results") ?? []) as unknown[];
  if (!Array.isArray(list)) return [];
  const out: JobSpyRow[] = [];
  for (const item of list) {
    const p = (pick(item, "jobPosting") ?? item) as Record<string, unknown>;
    const title = str(pick(p, "title", "jobTitle", "name"));
    const company = str(pick(p, "hiringOrganization.name", "company.name", "companyName", "company", "hiringOrganization"));
    const id = str(pick(item, "jobId", "id", "jobPosting.identifier.value"));
    const url = str(pick(p, "url", "jobUrl", "detailsUrl", "canonicalUrl")) || (id ? `${MONSTER}/job-openings/${id}` : "");
    if (!title || !url) continue;
    const loc = pick(p, "jobLocation") as unknown;
    const locObj = (Array.isArray(loc) ? loc[0] : loc) as Record<string, unknown> | undefined;
    const addr = (locObj?.address ?? locObj) as Record<string, unknown> | undefined;
    const location = [str(addr?.addressLocality), str(addr?.addressRegion)].filter(Boolean).join(", ") || str(pick(p, "location", "formattedLocation"));
    const date = str(pick(p, "datePosted", "postedDate", "dateCreated", "publishedDate"));
    out.push({
      site: "monster", title, company: company || "Unknown company", location,
      date_posted: date ? date.slice(0, 10) : "",
      job_url: url.startsWith("http") ? url : `${MONSTER}${url}`,
      description: str(pick(p, "description")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

/** What the on-screen card parser returns for one card. */
export interface CardText { title: string; href: string; company: string; location: string; recency: string }

export function rowsFromCards(cards: CardText[], now = new Date()): JobSpyRow[] {
  return cards
    .filter((c) => c.title && c.href)
    .map((c) => ({
      site: "monster", title: c.title.trim(), company: c.company.trim() || "Unknown company", location: c.location.trim(),
      date_posted: dateFromRecency(c.recency, now) ?? "",
      job_url: c.href.startsWith("http") ? c.href : `${MONSTER}${c.href}`,
    }));
}

// Runs inside the page; must not reference anything outside its own body.
const readCards = (els: Element[]): CardText[] => els.map((el) => {
  const q = (s: string) => el.querySelector(s);
  const a = q('a[data-testid="jobTitle"]') as HTMLAnchorElement | null;
  return {
    title: a?.textContent?.trim() ?? "",
    href: a?.getAttribute("href") ?? "",
    company: q('[data-testid="company"]')?.textContent?.trim() ?? "",
    location: q('[data-testid="jobDetailLocation"]')?.textContent?.trim() ?? "",
    recency: q('[data-testid="jobDetailDateRecency"]')?.textContent?.trim() ?? "",
  };
});

const dedupe = (rows: JobSpyRow[]): JobSpyRow[] => {
  const seen = new Set<string>();
  return rows.filter((r) => { const k = (r.job_url ?? "").replace(/[?#].*$/, ""); if (seen.has(k)) return false; seen.add(k); return true; });
};

/**
 * Reads up to `resultsWanted` Monster posts for `term`, newest pages first. Never throws for a Monster-side
 * problem: that comes back as `error`, and whatever was read before it is still returned.
 */
export async function searchMonster(
  term: string, resultsWanted: number, opts: MonsterOptions, launch: LaunchBrowser = launchChromium, now = new Date(),
): Promise<{ rows: JobSpyRow[]; error?: string }> {
  const base = (opts.baseUrl ?? MONSTER).replace(/\/$/, "");
  const maxPages = Math.max(1, opts.maxPages ?? 3);
  const perPage = Math.max(15_000, Math.floor(opts.timeoutMs / (maxPages + 1)));
  const rows: JobSpyRow[] = [];
  let browser: BrowserLike | undefined;
  const fail = (msg: string) => ({ rows: dedupe(rows).slice(0, resultsWanted), error: msg });
  const headless = opts.headless !== false;
  // With the window visible a person may be passing Monster's check by hand: give the first page two minutes.
  const firstPageWait = headless ? perPage : Math.max(perPage, 120_000);
  try {
    browser = await launch({ headless, profileDir: opts.profileDir ?? "out/monster-profile", ...(opts.channel ? { channel: opts.channel } : {}) });
    const page = await browser.newPage();
    const captured: unknown[] = [];
    page.on("response", (r) => {
      if (!r.ok() || !/search-jobs|samsearch|jobs-svx|\/api\/.*jobs/i.test(r.url())) return;
      r.json().then((j) => captured.push(j)).catch(() => { /* not JSON */ });
    });
    for (let n = 1; n <= maxPages && rows.length < resultsWanted; n++) {
      captured.length = 0;
      const url = `${base}/jobs/search?q=${encodeURIComponent(term)}&where=${encodeURIComponent(opts.location)}&page=${n}&so=m.h.sh`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: perPage });
      const seen = await page.waitForSelector(CARD, { timeout: n === 1 ? firstPageWait : perPage }).then(() => true).catch(() => false);
      if (!seen) {
        const blocked = await page.$$eval("body", (b) => /verify you are human|verification required|slide right|access denied|unusual (traffic|activity)|captcha/i.test(b[0]?.textContent ?? "")).catch(() => false);
        if (blocked) return fail(headless
          ? "Monster showed a bot check instead of results. Run once with MONSTER_HEADLESS=false and pass the check by hand; the pass is remembered in out/monster-profile"
          : "Monster showed a bot check and it was not passed within two minutes (drag the slider when the window shows it)");
        if (n === 1) return fail("Monster showed no job cards (page layout may have changed or the search had no results)");
        break;
      }
      await page.waitForTimeout(400); // the JSON response usually lands just before the cards draw
      const fromJson = dedupe(captured.flatMap((j) => rowsFromApiJson(j)));
      const pageRows = fromJson.length ? fromJson : rowsFromCards(await page.$$eval(CARD, readCards), now);
      const fresh = pageRows.filter((r) => withinHours(r.date_posted || undefined, opts.hoursOld, now));
      logger.info({ term, page: n, cards: pageRows.length, fresh: fresh.length, source: fromJson.length ? "json" : "cards" }, "monster page");
      rows.push(...fresh);
      if (pageRows.length === 0 || fresh.length < pageRows.length / 2) break; // mostly old posts: later pages are older still
    }
    return { rows: dedupe(rows).slice(0, resultsWanted) };
  } catch (err) {
    if (err instanceof MonsterSetupError) throw err;
    return fail(`Monster read failed: ${(err as Error).message.split("\n")[0]}`);
  } finally {
    await browser?.close().catch(() => { /* ignore */ });
  }
}
