import type { SheetsGateway } from "../../core/exporter.js";

/**
 * The "Config" tab is AutoBooker's settings (sender, signature, daily cap, working hours, DryRun).
 * The UI's Automation page reads and writes the same cells, so the Sheet and the UI never disagree.
 * Keys and defaults mirror CONFIG_KEYS in apps_script/AutoBooker.gs.
 */
export const CONFIG_TAB = "Config";

export const CONFIG_DEFAULTS: Array<[key: string, value: string, help: string]> = [
  ["DryRun", "TRUE", "TRUE logs every action instead of doing it. Set FALSE to go live."],
  ["TimeZone", "America/New_York", "Zone for working hours and offered times."],
  ["DailySendCap", "20", "Max first-touch emails per calendar day."],
  ["MeetingMinutes", "15", "Length of the booked call."],
  ["WorkStartHour", "9", "First slot offered (24h)."],
  ["WorkEndHour", "17", "Last slot must end by this hour."],
  ["SenderName", "", "Signature line 1."],
  ["SenderTitle", "", "Signature line 2."],
  ["SenderCompany", "One Smarter", "Signature line 2."],
  ["Street", "", "Postal address line (required by CAN-SPAM)."],
  ["CityStateZip", "Dayton, OH 45402", "Postal address line (required by CAN-SPAM)."],
  ["Phone", "", "Optional."],
  ["OptOutLine", "If you would rather not hear from me again, reply with the word unsubscribe and I will remove you.", "Required by CAN-SPAM."],
  ["MeetingTitle", "Intro call: {company} and {sender_company}", "Calendar event title."],
];
const KNOWN = new Set(CONFIG_DEFAULTS.map(([k]) => k));

export type ConfigMap = Record<string, string>;

async function ensureTab(gw: SheetsGateway): Promise<void> {
  if ((await gw.listTabs()).some((t) => t.title === CONFIG_TAB)) return;
  await gw.addTabs([CONFIG_TAB]);
  await gw.writeValues(`${CONFIG_TAB}!A1:C${CONFIG_DEFAULTS.length + 1}`, [["Key", "Value", "What it does"], ...CONFIG_DEFAULTS.map(([k, v, h]) => [k, v, h])], "raw");
}

export async function readConfig(gw: SheetsGateway): Promise<ConfigMap> {
  await ensureTab(gw);
  const rows = await gw.getValues(`${CONFIG_TAB}!A1:B`);
  const out: ConfigMap = Object.fromEntries(CONFIG_DEFAULTS.map(([k, v]) => [k, v]));
  for (const r of rows.slice(1)) {
    const k = (r[0] ?? "").trim();
    if (k) out[k] = (r[1] ?? "").trim();
  }
  return out;
}

/** Writes only known keys. Unknown keys are refused so a typo cannot create a silent new setting. */
export async function writeConfig(gw: SheetsGateway, patch: ConfigMap): Promise<ConfigMap> {
  const bad = Object.keys(patch).filter((k) => !KNOWN.has(k));
  if (bad.length) throw Object.assign(new Error(`Unknown setting(s): ${bad.join(", ")}`), { statusCode: 400 });
  await ensureTab(gw);
  const rows = await gw.getValues(`${CONFIG_TAB}!A1:B`);
  const index = new Map<string, number>();
  rows.slice(1).forEach((r, i) => { const k = (r[0] ?? "").trim(); if (k) index.set(k, i + 2); });
  let nextRow = rows.length + 1;
  for (const [k, v] of Object.entries(patch)) {
    const rowNo = index.get(k);
    if (rowNo) await gw.writeValues(`${CONFIG_TAB}!B${rowNo}`, [[String(v)]], "raw");
    else { await gw.writeValues(`${CONFIG_TAB}!A${nextRow}:B${nextRow}`, [[k, String(v)]], "raw"); nextRow += 1; }
  }
  return readConfig(gw);
}
