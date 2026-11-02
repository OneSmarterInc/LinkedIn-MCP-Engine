import { describe, it, expect } from "vitest";
import type { SheetsGateway, SheetTabInfo } from "../../src/core/exporter.js";
import {
  CAMPAIGN_HEADERS, CAMPAIGNS_TAB, campaignToRow, isCampaignFile, isTrue, rowToCampaign, sheetCampaignStore, splitList,
} from "../../src/config/store.js";
import { corporateCfg } from "../helpers.js";

/** In-memory Sheet. Same shape as the exporter test fake, trimmed to what the store uses. */
function fakeSheets(initial: Record<string, string[][]> = {}) {
  const tabs = new Map<string, { id: number; rows: string[][] }>();
  let nextId = 1;
  for (const [t, rows] of Object.entries(initial)) tabs.set(t, { id: nextId++, rows });
  const batches: object[][] = [];
  const idx = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const parse = (range: string) => {
    const [tab, a = ""] = range.split("!");
    const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(a)!;
    return { tab: tab!, c1: idx(m[1]!), r1: m[2] ? Number(m[2]) - 1 : 0, c2: m[3] ? idx(m[3]) : undefined, r2: m[4] ? Number(m[4]) - 1 : undefined };
  };
  const gw: SheetsGateway = {
    async listTabs(): Promise<SheetTabInfo[]> { return [...tabs].map(([title, t]) => ({ title, sheetId: t.id })); },
    async addTabs(titles) { return titles.map((title) => { const t = { id: nextId++, rows: [] as string[][] }; tabs.set(title, t); return { title, sheetId: t.id }; }); },
    async batchUpdate(requests) { batches.push(requests); },
    async getValues(range) {
      const p = parse(range);
      const rows = tabs.get(p.tab)?.rows ?? [];
      return rows.slice(p.r1, p.r2 === undefined ? undefined : p.r2 + 1)
        .map((r) => r.slice(p.c1, p.c2 === undefined ? p.c1 + 1 : p.c2 + 1)).filter((r) => r.length > 0);
    },
    async writeValues(range, values) {
      const p = parse(range); const t = tabs.get(p.tab)!;
      values.forEach((row, i) => { const r = (t.rows[p.r1 + i] ??= []); row.forEach((v, j) => { r[p.c1 + j] = v; }); });
    },
    async appendValues(range, values) { tabs.get(parse(range).tab)!.rows.push(...values.map((v) => [...v])); },
  };
  return { gw, tabs, batches };
}

const H = [...CAMPAIGN_HEADERS];
const goodRow = (over: Partial<Record<(typeof CAMPAIGN_HEADERS)[number], string>> = {}) => {
  const cells: Record<string, string> = {
    Name: "Ohio TPAs", Active: "TRUE", Mode: "CORPORATE", Provider: "gemini_xray", States: "Ohio, Indiana",
    Titles: "CFO; VP of Human Resources", Keywords: "TPA, Healthcare", SignalQuery: "", Persona: "",
    SenderCompany: "One Smarter", Offer: "a 15-minute call to compare how claims are reviewed",
    MeetingMinutes: "15", DailyCap: "20", BlockEmployerDomain: "", CsvPath: "", Status: "", UpdatedAt: "", ...over,
  };
  return H.map((h) => cells[h] ?? "");
};

describe("cell helpers", () => {
  it("splits lists on commas, semicolons and newlines", () => {
    expect(splitList("Ohio, Indiana ;Michigan\nKentucky")).toEqual(["Ohio", "Indiana", "Michigan", "Kentucky"]);
    expect(splitList("")).toEqual([]);
  });
  it("reads checkbox-ish values", () => {
    expect(["TRUE", "yes", "1", "x"].map(isTrue)).toEqual([true, true, true, true]);
    expect(["FALSE", "", "no"].map(isTrue)).toEqual([false, false, false]);
  });
  it("tells files from names", () => {
    expect(isCampaignFile("campaigns/b2b_healthcare.json")).toBe(true);
    expect(isCampaignFile("Ohio TPAs")).toBe(false);
  });
});

describe("rowToCampaign", () => {
  it("builds a valid config from a good row", () => {
    const p = rowToCampaign(H, goodRow());
    expect(p.error).toBeUndefined();
    expect(p.active).toBe(true);
    expect(p.config).toMatchObject({
      campaign_name: "Ohio TPAs", mode: "CORPORATE", target_geography: ["Ohio", "Indiana"],
      decision_maker_titles: ["CFO", "VP of Human Resources"], sender_company: "One Smarter",
      calendar_duration_minutes: 15, daily_send_cap: 20, block_current_employer_domain: false,
    });
  });
  it("derives block_current_employer_domain from CANDIDATE mode", () => {
    expect(rowToCampaign(H, goodRow({ Mode: "candidate" })).config?.block_current_employer_domain).toBe(true);
    expect(rowToCampaign(H, goodRow({ Mode: "CANDIDATE", BlockEmployerDomain: "FALSE" })).config?.block_current_employer_domain).toBe(false);
  });
  it("explains problems in plain words, all at once", () => {
    const p = rowToCampaign(H, goodRow({ Offer: "", States: "", Mode: "B2B" }));
    expect(p.config).toBeUndefined();
    expect(p.error).toContain("Offer is empty");
    expect(p.error).toContain("States is empty");
    expect(p.error).toContain("Mode must be one of: CORPORATE, CANDIDATE");
  });
  it("uses defaults when optional cells are blank", () => {
    const p = rowToCampaign(H, goodRow({ MeetingMinutes: "", DailyCap: "", Provider: "" }));
    expect(p.config).toMatchObject({ calendar_duration_minutes: 15, daily_send_cap: 20, sourcing_provider: "gemini_xray" });
  });
});

describe("campaignToRow", () => {
  it("round-trips through rowToCampaign", () => {
    const row = campaignToRow(corporateCfg, true, "OK", new Date("2026-11-02T00:00:00Z"));
    expect(row).toHaveLength(CAMPAIGN_HEADERS.length);
    const back = rowToCampaign(H, row.map((c, i) => (H[i] === "Offer" ? "a short call about the thing" : H[i] === "SenderCompany" ? "One Smarter" : c)));
    expect(back.error).toBeUndefined();
    expect(back.config?.campaign_name).toBe(corporateCfg.campaign_name);
    expect(back.active).toBe(true);
  });
});

describe("sheetCampaignStore", () => {
  it("creates the tab with headers, dropdowns and checkboxes on first use", async () => {
    const { gw, tabs, batches } = fakeSheets({ Pipeline: [["Company"]] });
    const store = sheetCampaignStore(gw);
    expect(await store.list()).toEqual([]);
    expect(tabs.get(CAMPAIGNS_TAB)!.rows[0]).toEqual(H);
    const reqs = batches.flat() as Array<{ setDataValidation?: { rule: { condition: { type: string } } } }>;
    const kinds = reqs.filter((r) => r.setDataValidation).map((r) => r.setDataValidation!.rule.condition.type);
    expect(kinds).toEqual(["ONE_OF_LIST", "ONE_OF_LIST", "BOOLEAN", "BOOLEAN"]);
  });

  it("refuses a tab whose headers were changed by hand", async () => {
    const { gw } = fakeSheets({ [CAMPAIGNS_TAB]: [["Name", "Wrong"]] });
    await expect(sheetCampaignStore(gw).list()).rejects.toThrow(/unexpected headers/);
  });

  it("lists, gets by name (case-insensitive), and reports invalid rows without throwing on list", async () => {
    const { gw } = fakeSheets({ [CAMPAIGNS_TAB]: [H, goodRow(), goodRow({ Name: "Broken", Offer: "" })] });
    const store = sheetCampaignStore(gw);
    const list = await store.list();
    expect(list.map((c) => [c.name, c.active, c.status.startsWith("OK")])).toEqual([["Ohio TPAs", true, true], ["Broken", true, false]]);
    expect((await store.get("ohio tpas")).campaign_name).toBe("Ohio TPAs");
    await expect(store.get("Broken")).rejects.toThrow(/Offer is empty/);
    await expect(store.get("Nope")).rejects.toThrow(/No campaign named "Nope".*Ohio TPAs/);
  });

  it("writes the error into the Status cell when a bad row is requested", async () => {
    const { gw, tabs } = fakeSheets({ [CAMPAIGNS_TAB]: [H, goodRow({ Name: "Broken", States: "" })] });
    await sheetCampaignStore(gw).get("Broken").catch(() => undefined);
    expect(tabs.get(CAMPAIGNS_TAB)!.rows[1]![H.indexOf("Status")]).toMatch(/^ERROR: .*States is empty/);
  });

  it("saves a new campaign as a paused row and replaces an existing one by name", async () => {
    const { gw, tabs } = fakeSheets({ [CAMPAIGNS_TAB]: [H, goodRow()] });
    const store = sheetCampaignStore(gw);
    const added = await store.save({ ...corporateCfg, campaign_name: "KY CFOs", offer: "a 15-minute call", sender_company: "One Smarter" });
    expect(added).toMatchObject({ name: "KY CFOs", active: false, rowNumber: 3, status: "OK" });
    expect(tabs.get(CAMPAIGNS_TAB)!.rows).toHaveLength(3);

    const replaced = await store.save({ ...corporateCfg, campaign_name: "Ohio TPAs", offer: "a new offer line", sender_company: "One Smarter" });
    expect(replaced.rowNumber).toBe(2);
    expect(replaced.active).toBe(true); // keeps the row's existing Active flag
    expect(tabs.get(CAMPAIGNS_TAB)!.rows).toHaveLength(3);
    expect(tabs.get(CAMPAIGNS_TAB)!.rows[1]![H.indexOf("Offer")]).toBe("a new offer line");
  });

  it("activates valid rows and refuses to activate a broken one", async () => {
    const { gw, tabs } = fakeSheets({ [CAMPAIGNS_TAB]: [H, goodRow({ Active: "FALSE" }), goodRow({ Name: "Broken", Titles: "" })] });
    const store = sheetCampaignStore(gw);
    await store.setActive("Ohio TPAs", true);
    expect(tabs.get(CAMPAIGNS_TAB)!.rows[1]![H.indexOf("Active")]).toBe("TRUE");
    await expect(store.setActive("Broken", true)).rejects.toThrow(/Cannot activate.*Titles is empty/);
    await store.setActive("Ohio TPAs", false);
    expect(tabs.get(CAMPAIGNS_TAB)!.rows[1]![H.indexOf("Active")]).toBe("FALSE");
  });

  it("validateAll stamps every row and skips blank ones", async () => {
    const { gw, tabs } = fakeSheets({ [CAMPAIGNS_TAB]: [H, goodRow(), H.map(() => ""), goodRow({ Name: "Broken", SenderCompany: "" })] });
    const out = await sheetCampaignStore(gw).validateAll();
    expect(out.map((r) => r.status.startsWith("OK"))).toEqual([true, false]);
    const rows = tabs.get(CAMPAIGNS_TAB)!.rows;
    expect(rows[1]![H.indexOf("Status")]).toBe("OK");
    expect(rows[3]![H.indexOf("Status")]).toMatch(/SenderCompany is empty/);
    expect(rows[1]![H.indexOf("UpdatedAt")]).toMatch(/^\d{4}-/);
  });
});
