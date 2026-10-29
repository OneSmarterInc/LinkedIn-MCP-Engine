import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import type { LeadRecord } from "../../config/schema.js";
import { normalizeLinkedinUrl, splitFullName, stableId, type SkippedRow, type SourceResult } from "./types.js";

type Field =
  | "first_name" | "last_name" | "full_name" | "title" | "company_name" | "company_domain"
  | "location" | "city" | "state" | "linkedin_url" | "email";

/** Accepted spellings for each column. Headers are lower-cased and punctuation becomes spaces. */
const HEADER_ALIASES: Record<Field, string[]> = {
  first_name: ["first name", "firstname", "fname", "given name"],
  last_name: ["last name", "lastname", "lname", "surname", "family name"],
  full_name: ["name", "full name", "contact name", "contact"],
  title: ["title", "job title", "position", "headline", "role"],
  company_name: ["company", "company name", "organization", "organisation", "employer", "account name"],
  company_domain: ["domain", "company domain", "website", "company website", "url", "web"],
  location: ["location", "city state", "geography", "region"],
  city: ["city", "town"],
  state: ["state", "province", "st"],
  linkedin_url: ["linkedin", "linkedin url", "linkedin profile", "profile url", "person linkedin url"],
  email: ["email", "email address", "work email", "e mail", "business email"],
};

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function buildHeaderMap(headers: string[]): Partial<Record<Field, string>> {
  const map: Partial<Record<Field, string>> = {};
  for (const h of headers) {
    const n = normHeader(h);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [Field, string[]][]) {
      if (!map[field] && (n === field.replace("_", " ") || aliases.includes(n))) map[field] = h;
    }
  }
  return map;
}

async function readRows(path: string): Promise<Record<string, string>[]> {
  const ext = extname(path).toLowerCase();
  if (ext === ".csv" || ext === ".txt") {
    const text = await readFile(path, "utf8");
    return parse(text, {
      columns: true, bom: true, trim: true, skip_empty_lines: true, relax_column_count: true,
    }) as Record<string, string>[];
  }
  if (ext === ".xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { headers[col] = String(cell.text ?? "").trim(); });
    const rows: Record<string, string>[] = [];
    ws.eachRow((row, i) => {
      if (i === 1) return;
      const rec: Record<string, string> = {};
      headers.forEach((h, col) => { if (h) rec[h] = String(row.getCell(col).text ?? "").trim(); });
      rows.push(rec);
    });
    return rows;
  }
  throw new Error(`Unsupported lead file type "${ext}". Use .csv or .xlsx.`);
}

/**
 * csv_import: reads a CSV or XLSX lead list and maps its columns to LeadRecord.
 * Rows without a usable name or company are skipped with a reason; everything else goes to the gates.
 */
export async function readLeadFile(path: string, limit?: number): Promise<SourceResult> {
  const rows = await readRows(path);
  const map = buildHeaderMap(Object.keys(rows[0] ?? {}));
  const get = (r: Record<string, string>, f: Field) => (map[f] ? (r[map[f]!] ?? "").trim() : "");

  const leads: LeadRecord[] = [];
  const skipped: SkippedRow[] = [];

  rows.forEach((r, i) => {
    if (limit !== undefined && leads.length >= limit) return;
    const rowNum = i + 2; // +1 for header, +1 for 1-based

    if (Object.values(r).every((v) => !String(v ?? "").trim())) {
      skipped.push({ row: rowNum, reason: "BLANK_ROW" });
      return;
    }

    let first = get(r, "first_name");
    let last = get(r, "last_name");
    if ((!first || !last) && get(r, "full_name")) ({ first, last } = splitFullName(get(r, "full_name")));
    if (!first || !last) { skipped.push({ row: rowNum, reason: "MISSING_NAME" }); return; }

    const company = get(r, "company_name");
    if (!company) { skipped.push({ row: rowNum, reason: "MISSING_COMPANY" }); return; }

    const location = get(r, "location") || [get(r, "city"), get(r, "state")].filter(Boolean).join(", ");
    const email = get(r, "email") || undefined;
    const linkedin = normalizeLinkedinUrl(get(r, "linkedin_url"));

    leads.push({
      lead_id: stableId("csv", linkedin ?? email ?? `${first} ${last}|${company}`),
      first_name: first,
      last_name: last,
      title: get(r, "title"),
      company_name: company,
      company_domain: get(r, "company_domain") || undefined,
      location,
      linkedin_url: linkedin,
      email,
      source: "csv_import",
    });
  });

  return { provider: "csv_import", leads, skipped };
}
