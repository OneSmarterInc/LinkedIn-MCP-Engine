import { describe, it } from "vitest";

describe("verifier", () => {
  it.todo("gate 1: strips credentials and newlines");
  it.todo("gate 2: quarantines shared emails");
  it.todo("gate 3: blocks consumer domains and role prefixes in CORPORATE");
  it.todo("gate 3: blocks current employer domain in CANDIDATE");
  it.todo("gate 4: quarantines out-of-state name collisions");
  it.todo("gate 5: rejects domains with no MX record");
});