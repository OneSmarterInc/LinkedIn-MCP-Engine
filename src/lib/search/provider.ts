import { z } from "zod";

/** One person found by a people search. LinkedIn data almost never includes an email. */
export const PersonHit = z.object({
  full_name: z.string().min(1),
  title: z.string(),
  company_name: z.string(),
  company_domain: z.string().nullish().describe("Official company website domain, e.g. acme.com"),
  location: z.string().describe("City, State"),
  linkedin_url: z.string().describe("Public profile URL, https://www.linkedin.com/in/..."),
  email: z.string().nullish(),
});
export type PersonHit = z.infer<typeof PersonHit>;

export interface PeopleQuery {
  title: string;
  location: string;
  keywords: string[];
  signal?: string;
}

/** Contract for every people-search backend (fixture today, Gemini grounded search in production). */
export interface SearchProvider {
  readonly name: string;
  findPeople(query: PeopleQuery, limit: number): Promise<PersonHit[]>;
}
