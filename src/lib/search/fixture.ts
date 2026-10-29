import { readFileSync } from "node:fs";
import { z } from "zod";
import { PersonHit, type PeopleQuery, type SearchProvider } from "./provider.js";

const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

/** True when a hit's "City, ST" location falls inside the query location (state name, code, or text). */
export function locationMatches(hitLocation: string, queryLocation: string): boolean {
  const hit = hitLocation.toLowerCase();
  const q = queryLocation.toLowerCase().trim();
  if (q === "remote") return hit.includes("remote");
  const code = STATES[q];
  if (code && new RegExp(`(^|[ ,])${code.toLowerCase()}$`).test(hit)) return true;
  return hit.includes(q);
}

/** Offline search for development and tests: returns people from a JSON file matching title and location. */
export class FixtureSearchProvider implements SearchProvider {
  readonly name = "fixture";
  private readonly people: PersonHit[];

  constructor(path: string) {
    this.people = z.array(PersonHit).parse(JSON.parse(readFileSync(path, "utf8")));
  }

  async findPeople(query: PeopleQuery, limit: number): Promise<PersonHit[]> {
    const title = query.title.toLowerCase();
    return this.people
      .filter((p) => p.title.toLowerCase() === title && locationMatches(p.location, query.location))
      .slice(0, limit);
  }
}
