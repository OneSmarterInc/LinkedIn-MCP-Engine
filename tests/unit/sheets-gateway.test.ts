import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSheetsGateway, parseSheetId } from "../../src/lib/google/sheets.js";

describe("parseSheetId", () => {
  it("takes a bare ID as is", () => {
    expect(parseSheetId("  1AbC_d-EfG  ")).toBe("1AbC_d-EfG");
  });
  it("pulls the ID out of a full Sheet URL", () => {
    expect(parseSheetId("https://docs.google.com/spreadsheets/d/1AbC_d-EfG/edit#gid=0")).toBe("1AbC_d-EfG");
  });
});

describe("createSheetsGateway setup errors", () => {
  it("asks for GOOGLE_SHEET_ID when it is empty", () => {
    expect(() => createSheetsGateway({ GOOGLE_SHEET_ID: "" })).toThrow(/GOOGLE_SHEET_ID/);
  });
  it("says where it looked when the key file is missing", () => {
    expect(() => createSheetsGateway({ GOOGLE_SHEET_ID: "abc", GOOGLE_SA_JSON_PATH: "nope/missing.json" }))
      .toThrow(/nope\/missing\.json/);
  });
  it("rejects a key file that is not JSON", () => {
    const p = join(mkdtempSync(join(tmpdir(), "sa-")), "key.json");
    writeFileSync(p, "not json");
    expect(() => createSheetsGateway({ GOOGLE_SHEET_ID: "abc", GOOGLE_SA_JSON_PATH: p })).toThrow(/not valid JSON/);
  });
});
