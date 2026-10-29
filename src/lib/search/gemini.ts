import { z } from "zod";
import type { LLMProvider } from "../llm/provider.js";
import { PersonHit, type PeopleQuery, type SearchProvider } from "./provider.js";

const SearchResult = z.object({ people: z.array(PersonHit) });

const SYSTEM = [
  "You find real, current professionals using Google Search.",
  "Only return people whose public LinkedIn profile URL you actually found in search results.",
  "Never invent names, URLs, or domains. If you find fewer people than asked, return fewer.",
  "company_domain is the company's official website domain, never linkedin.com or a directory site.",
].join(" ");

export function buildXrayQuery(q: PeopleQuery): string {
  const kw = q.keywords.length ? ` (${q.keywords.map((k) => `"${k}"`).join(" OR ")})` : "";
  return `site:linkedin.com/in/ "${q.title}" "${q.location}"${kw}`;
}

/** Cookieless LinkedIn X-Ray: Gemini runs a Google search and returns structured people. */
export class GeminiSearchProvider implements SearchProvider {
  readonly name = "gemini";

  constructor(private readonly llm: LLMProvider) {
    if (!llm.supportsGrounding) {
      throw new Error(
        `Live LinkedIn search needs web search, and "${llm.name}" has it switched off or does not offer it. ` +
        `For Gemini: turn on billing and set GEMINI_GROUNDING=true. Or use --csv / SEARCH_PROVIDER=fixture.`,
      );
    }
  }

  async findPeople(query: PeopleQuery, limit: number): Promise<PersonHit[]> {
    const prompt = [
      `Search Google with: ${buildXrayQuery(query)}`,
      query.signal ? `Prefer companies matching this signal: ${query.signal}` : "",
      `Return up to ${limit} people currently holding the title "${query.title}" in ${query.location}.`,
      "For each person give full_name, title, company_name, company_domain, location (City, State), linkedin_url.",
    ].filter(Boolean).join("\n");

    const result = await this.llm.generateJSON(prompt, SearchResult, { grounded: true, system: SYSTEM });
    return result.people.slice(0, limit);
  }
}
