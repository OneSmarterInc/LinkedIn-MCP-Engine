/**
 * Staffing agencies, recruiting firms and IT consulting or outsourcing companies are One Smarter's competitors:
 * a job they post is usually for a client, and they do not buy developers from us. Job search skips them before any
 * Seamless lookup, so they cost no credits and the run keeps looking for other companies.
 *
 * Add more names with SKIP_COMPANIES in .env (comma-separated, matched anywhere in the company name).
 */

/** Large IT services, consulting and staffing companies, matched as whole words in the company name. */
export const KNOWN_FIRMS = [
  "accenture", "capgemini", "infosys", "wipro", "tata consultancy", "tcs", "hcl", "hcltech", "cognizant", "tech mahindra",
  "ltimindtree", "mindtree", "mphasis", "hexaware", "persistent systems", "cyient", "ust global", "virtusa", "ntt data",
  "dxc", "deloitte", "kpmg", "pwc", "ernst & young", "ey", "genpact", "zensar", "birlasoft", "coforge", "sonata software",
  "igate", "syntel", "kforce", "robert half", "randstad", "adecco", "manpowergroup", "teksystems", "insight global",
  "apex systems", "aerotek", "kelly services", "modis", "akkodis", "hays", "collabera", "cybercoders", "dice",
  "motion recruitment", "experis", "allegis", "yoh", "judge group", "mastech", "igate", "slalom", "globant", "epam",
  "thoughtworks", "ibm consulting", "clarkston",
];

/** Words in a company name that mark a staffing or consulting firm. */
const NAME = /\b(staffing|recruit(ing|ment|ers)?|consult(ing|ancy|ants?)|outsourc(ing|e)|manpower|placements?|resourcing|talent (solutions|partners|group)|infotech|infosystems|it services|it solutions|tech solutions|software solutions)\b/i;

/** Words in a company's web domain that mark the same. */
const DOMAIN = /(staffing|recruit|consult|infotech|talent|manpower|placement)/i;

/** Phrases in a job post that show it is written for a client, or for contractors. */
const POST = /\b(our client|on behalf of (our|a|the) client|client of ours|for one of our clients|staffing (firm|agency|company)|recruiting (firm|agency)|consulting (firm|company)|it consulting|implementation partner|c2c|corp[- ]?to[- ]?corp|w2 only|bench sales|h1b transfer|we are a (global )?(it )?(staffing|consulting|services) (firm|company))\b/i;

/** Contact titles that only staffing firms use. Checked after Seamless, so the job is not emailed. */
const CONTACT = /\b(bench sales|us it recruit\w*|it bench|c2c)\b/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface StaffingCheck {
  /** Why the company was skipped, in plain words, or undefined when it looks like a real employer. */
  reason(company: { name: string; domain?: string; text?: string }): string | undefined;
  contact(title?: string): boolean;
}

export function staffingCheck(env: NodeJS.ProcessEnv = process.env): StaffingCheck {
  const extra = (env.SKIP_COMPANIES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const known = new RegExp(`\\b(${KNOWN_FIRMS.map(escape).join("|")})\\b`, "i");
  return {
    reason({ name, domain, text }) {
      const n = name.toLowerCase();
      const added = extra.find((x) => n.includes(x));
      if (added) return `on the skip list (${added})`;
      if (known.test(name)) return "a known IT services, consulting or staffing company";
      if (NAME.test(name)) return "a staffing or consulting firm (by its name)";
      if (domain && DOMAIN.test(domain)) return "a staffing or consulting firm (by its website)";
      if (text && POST.test(text)) return "the post is written for a client or for contractors";
      return undefined;
    },
    contact: (title) => Boolean(title && CONTACT.test(title)),
  };
}
