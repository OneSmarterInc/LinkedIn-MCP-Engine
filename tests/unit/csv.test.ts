import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { readLeadFile } from "../../src/core/sources/csv.js";
import { normalizeLinkedinUrl, splitFullName } from "../../src/core/sources/types.js";

const dir = mkdtempSync(join(tmpdir(), "csv-test-"));
function csv(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

describe("csv_import", () => {
  it("reads the dirty fixture and skips blank and company-less rows", async () => {
    const r = await readLeadFile("tests/fixtures/dirty_leads.csv");
    expect(r.leads).toHaveLength(18);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(["BLANK_ROW", "MISSING_COMPANY"]);
  });

  it("joins City + State into location", async () => {
    const r = await readLeadFile("tests/fixtures/dirty_leads.csv");
    expect(r.leads[0]!.location).toBe("Dayton, OH");
  });

  it("accepts other header spellings", async () => {
    const p = csv("alias.csv", "Full Name,Job Title,Organization,Company Website,Location,Email Address\nJane Q Miller,CFO,Acme,acme.com,\"Dayton, OH\",jane@acme.com\n");
    const [l] = (await readLeadFile(p)).leads;
    expect(l).toMatchObject({ first_name: "Jane", last_name: "Q Miller", title: "CFO", company_name: "Acme", company_domain: "acme.com", location: "Dayton, OH", email: "jane@acme.com" });
  });

  it("skips rows with no name", async () => {
    const p = csv("noname.csv", "First Name,Last Name,Company,Email\n,,Acme,x@acme.com\n");
    expect((await readLeadFile(p)).skipped[0]!.reason).toBe("MISSING_NAME");
  });

  it("handles a UTF-8 BOM from Excel", async () => {
    const p = csv("bom.csv", "﻿First Name,Last Name,Company,Email\nJane,Miller,Acme,jane@acme.com\n");
    expect((await readLeadFile(p)).leads).toHaveLength(1);
  });

  it("respects --limit", async () => {
    expect((await readLeadFile("tests/fixtures/dirty_leads.csv", 5)).leads).toHaveLength(5);
  });

  it("gives the same person the same lead_id on every run", async () => {
    const a = await readLeadFile("tests/fixtures/dirty_leads.csv");
    const b = await readLeadFile("tests/fixtures/dirty_leads.csv");
    expect(a.leads.map((l) => l.lead_id)).toEqual(b.leads.map((l) => l.lead_id));
  });

  it("reads .xlsx files", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Leads");
    ws.addRow(["First Name", "Last Name", "Company", "Email"]);
    ws.addRow(["Jane", "Miller", "Acme", "jane@acme.com"]);
    const p = join(dir, "leads.xlsx");
    await wb.xlsx.writeFile(p);
    const r = await readLeadFile(p);
    expect(r.leads[0]).toMatchObject({ first_name: "Jane", company_name: "Acme", email: "jane@acme.com" });
  });

  it("rejects other file types", async () => {
    await expect(readLeadFile(csv("x.pdf", ""))).rejects.toThrow(/Unsupported/);
  });
});

describe("helpers", () => {
  it.each([
    ["https://www.linkedin.com/in/Jane-Doe/", "https://www.linkedin.com/in/jane-doe"],
    ["http://in.linkedin.com/in/jane?trk=x", "https://www.linkedin.com/in/jane"],
    ["https://www.linkedin.com/company/acme", undefined],
    ["https://example.com/in/jane", undefined],
    ["", undefined],
  ])("normalizeLinkedinUrl(%s)", (input, expected) => {
    expect(normalizeLinkedinUrl(input)).toBe(expected);
  });

  it("splits full names and drops a leading Dr.", () => {
    expect(splitFullName("Dr. Helen Brooks")).toEqual({ first: "Helen", last: "Brooks" });
    expect(splitFullName("Mary Ann van der Berg")).toEqual({ first: "Mary", last: "Ann van der Berg" });
  });
});
