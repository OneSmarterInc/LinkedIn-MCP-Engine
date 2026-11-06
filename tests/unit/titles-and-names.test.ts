import { describe, expect, it } from "vitest";

import { shortCompanyName } from "../../src/core/enricher.js";
import { bestSearchResultId, titleRank } from "../../src/core/sources/seamless-finder.js";

describe("shortCompanyName keeps names that end in '& Company'", () => {
  it.each([
    ["KALMAN & COMPANY, INC.", "Kalman & Company"],
    ["Smith and Co.", "Smith and Co."],
    ["The Kroger Co.", "Kroger"],
    ["PRC-SALTILLO", "PRC-Saltillo"],
    ["CBRE", "CBRE"],
    ["Tyler Technologies, Inc.", "Tyler Technologies"],
  ])("%s -> %s", (full, short) => expect(shortCompanyName(full)).toBe(short));
});

describe("titleRank: recruiters first, C-level last", () => {
  it("orders the usual titles", () => {
    const titles = ["Chief People Officer", "Vice President Human Resources", "HR Director", "HR Generalist", "Senior Technical Recruiter", "Talent Acquisition Manager"];
    expect(titles.map(titleRank)).toEqual([4, 3, 2, 1, 0, 0]);
    expect(titleRank("Senior EVP of HR and Talent Acquisition")).toBe(4);
    expect(titleRank("Head of Talent")).toBe(3);
    expect(titleRank(undefined)).toBe(2.5);
  });
});

describe("bestSearchResultId", () => {
  it("picks the best title, first on a tie", () => {
    const body = { data: [
      { searchResultId: "a", title: "Chief Human Resources Officer" },
      { searchResultId: "b", title: "HR Manager" },
      { searchResultId: "c", title: "Technical Recruiter" },
      { searchResultId: "d", title: "Talent Acquisition Partner" },
    ] };
    expect(bestSearchResultId(body)).toBe("c");
  });
  it("falls back to the first row when no title is given", () => {
    expect(bestSearchResultId({ data: [{ searchResultId: "x" }, { searchResultId: "y" }] })).toBe("x");
    expect(bestSearchResultId({ data: [] })).toBeUndefined();
  });
});
