import { describe, it, expect } from "vitest";
import { cleanPersonName, fixCase } from "../../src/core/names.js";
import { jobToLead } from "../../src/core/jobs/job-outreach.js";

// Made-up people.

describe("cleanPersonName", () => {
  it.each([
    ["MAnsi Patel", "mansi.patel@sci.example", "Mansi Patel"],
    ["Mahrm Christy Meijer", "christy.meijer@reyes.example", "Christy Meijer"],
    ["JOHN SMITH", "jsmith@acme.example", "John Smith"],
    ["jane doe", undefined, "Jane Doe"],
    ["Kelli McGrath", "kmcgrath@maverick.example", "Kelli McGrath"],
    ["DeShawn O'Neil", undefined, "DeShawn O'Neil"],
    ["Dr. Ana Ruiz, PhD", "ana@clinic.example", "Ana Ruiz"],
    ["Mary Ann Lopez", "mlopez@acme.example", "Mary Ann Lopez"],   // middle name kept: email has no "ann"
    ["Jean-luc Picard", undefined, "Jean-Luc Picard"],
  ])("%s -> %s", (raw, email, want) => expect(cleanPersonName(raw, email)).toBe(want));

  it("keeps a single word", () => expect(fixCase("MAnsi")).toBe("Mansi"));

  it("a job lead greets the right first name", () => {
    const lead = jobToLead({
      job_title: "Sales Manager", company: "Reyes", location: "MI", posted_date_unconfirmed: null, description: "",
      url: "https://www.indeed.com/viewjob?jk=1", email: "christy.meijer@reyes.example", email_source: "seamless_recruiter",
      contact_name: "Mahrm Christy Meijer", contact_title: "VP HR",
    });
    expect(lead.first_name).toBe("Christy");
    expect(lead.last_name).toBe("Meijer");
  });
});
