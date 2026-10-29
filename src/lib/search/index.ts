import { GeminiProvider } from "../llm/gemini.js";
import { FixtureSearchProvider } from "./fixture.js";
import { GeminiSearchProvider } from "./gemini.js";
import type { SearchProvider } from "./provider.js";

export type { SearchProvider, PeopleQuery } from "./provider.js";
export { PersonHit } from "./provider.js";
export { buildXrayQuery } from "./gemini.js";

/** Picks the people-search backend from SEARCH_PROVIDER: "fixture" (offline) or "gemini" (live). */
export function getSearch(env: NodeJS.ProcessEnv = process.env): SearchProvider {
  const choice = (env.SEARCH_PROVIDER ?? "fixture").toLowerCase();
  if (choice === "fixture") {
    return new FixtureSearchProvider(env.SEARCH_FIXTURE_PATH ?? "tests/fixtures/search_people.json");
  }
  if (choice === "gemini") {
    if (!env.GEMINI_API_KEY) throw new Error("SEARCH_PROVIDER=gemini but GEMINI_API_KEY is empty");
    return new GeminiSearchProvider(
      new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL ?? "gemini-2.5-flash" }),
    );
  }
  throw new Error(`Unknown SEARCH_PROVIDER "${choice}". Use "fixture" or "gemini".`);
}
