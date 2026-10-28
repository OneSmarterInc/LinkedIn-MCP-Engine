const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g;
const NAME_PREFIX = /^(dr|mr|mrs|ms|prof)\.?\s+/i;
const CREDENTIALS = new Set([
  "md", "phd", "cpa", "esq", "mba", "jr", "sr", "ii", "iii", "iv",
  "rn", "cfa", "jd", "sphr", "phr", "shrm-cp", "shrm-scp",
  "dds", "dmd", "pharmd", "msn", "bsn", "facs", "facp",
]);
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanText(s: string | undefined): string {
  return (s ?? "").normalize("NFC").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

function isCredential(token: string): boolean {
  const t = token.replace(/[.,]/g, "");
  if (t === "DO") return true; // uppercase only, so the surname "Do" is kept
  return CREDENTIALS.has(t.toLowerCase());
}

export function cleanFirstName(s: string | undefined): string {
  let out = cleanText(s);
  while (NAME_PREFIX.test(out)) out = out.replace(NAME_PREFIX, "");
  return out.replace(/[,.]+$/, "").trim();
}

export function cleanLastName(s: string | undefined): string {
  const beforeComma = cleanText(s).split(",")[0] ?? "";
  const tokens = beforeComma.split(" ").filter(Boolean);
  while (tokens.length > 1 && isCredential(tokens[tokens.length - 1] ?? "")) tokens.pop();
  return tokens.join(" ").replace(/[,.]+$/, "").trim();
}

export function normalizeEmail(s: string | undefined): string | undefined {
  const e = cleanText(s).replace(/^mailto:/i, "").replace(/[<>]/g, "").toLowerCase();
  return EMAIL_SHAPE.test(e) ? e : undefined;
}

export function normalizeDomain(s: string | undefined): string | undefined {
  const d = cleanText(s).toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  return d ? d : undefined;
}

export function emailParts(email: string): { local: string; domain: string } {
  const at = email.lastIndexOf("@");
  return { local: email.slice(0, at), domain: email.slice(at + 1) };
}