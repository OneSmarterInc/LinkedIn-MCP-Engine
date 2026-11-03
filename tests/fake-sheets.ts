import type { SheetTabInfo, SheetsGateway } from "../src/core/exporter.js";

/** An in-memory Google Sheet. Records every call so tests can check what was written and how. */
export function fakeSheets(initial: Record<string, string[][]> = {}) {
  const tabs = new Map<string, { id: number; rows: string[][] }>();
  let nextId = 1;
  for (const [t, rows] of Object.entries(initial)) tabs.set(t, { id: nextId++, rows });
  const log = { batches: [] as object[][], writes: [] as { range: string; mode: string }[], appends: [] as { range: string; values: string[][] }[] };

  const idx = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const parse = (range: string) => {
    const [tab, a = ""] = range.split("!");
    const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(a)!;
    return { tab: tab!, c1: idx(m[1]!), r1: m[2] ? Number(m[2]) - 1 : 0, c2: m[3] ? idx(m[3]) : undefined, r2: m[4] ? Number(m[4]) - 1 : undefined };
  };

  const gw: SheetsGateway = {
    async listTabs(): Promise<SheetTabInfo[]> {
      return [...tabs].map(([title, t]) => ({ title, sheetId: t.id }));
    },
    async addTabs(titles) {
      return titles.map((title) => {
        const t = { id: nextId++, rows: [] as string[][] };
        tabs.set(title, t);
        return { title, sheetId: t.id };
      });
    },
    async batchUpdate(requests) { log.batches.push(requests); },
    async getValues(range) {
      const p = parse(range);
      const rows = tabs.get(p.tab)?.rows ?? [];
      const out = rows.slice(p.r1, p.r2 === undefined ? undefined : p.r2 + 1)
        .map((r) => r.slice(p.c1, p.c2 === undefined ? p.c1 + 1 : p.c2 + 1));
      return out.filter((r) => r.length > 0);
    },
    async writeValues(range, values, mode) {
      log.writes.push({ range, mode });
      const p = parse(range);
      const t = tabs.get(p.tab)!;
      values.forEach((row, i) => {
        const r = (t.rows[p.r1 + i] ??= []);
        row.forEach((v, j) => { r[p.c1 + j] = v; });
      });
    },
    async appendValues(range, values) {
      log.appends.push({ range, values });
      tabs.get(parse(range).tab)!.rows.push(...values.map((v) => [...v]));
    },
  };
  return { gw, tabs, log };
}
