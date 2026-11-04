/**
 * Cleans a person's name from a data source (Seamless often returns odd capitals or a stray word), so the email
 * greeting reads right: "MAnsi Patel" -> "Mansi Patel", "Mahrm Christy Meijer" (christy.meijer@...) -> "Christy Meijer".
 */

/** Fixes one word's capitals. Keeps names that are already mixed on purpose: McGrath, DeShawn, O'Neil, Jean-Luc. */
export function fixCase(word: string): string {
  return word.split(/([-'’])/).map((part) => {
    if (!/[a-z]/i.test(part)) return part;
    const lower = part.toLowerCase();
    const title = lower.charAt(0).toUpperCase() + lower.slice(1);
    if (part === part.toUpperCase() || part === lower) return title;          // JOHN, john -> John
    if (/^[A-Z]{2,}[a-z]+$/.test(part)) return title;                           // MAnsi -> Mansi
    return part;                                                                 // McGrath, DeShawn
  }).join("");
}

const HONORIFIC = /^(dr|mr|mrs|ms|miss|prof)\.?$/i;
const CREDENTIAL = /^(phd|mba|shrm-?(cp|scp)|phr|sphr|cpa|pmp|rn|md|jr\.?|sr\.?|ii|iii)$/i;

export function cleanPersonName(name: string, email?: string): string {
  let words = name.replace(/[,|]+/g, " ").trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && HONORIFIC.test(words[0]!)) words.shift();
  while (words.length > 1 && CREDENTIAL.test(words[words.length - 1]!.replace(/[.,]$/, ""))) words.pop();
  // A stray first word: the email's name part has the second and last words but not the first.
  const local = (email ?? "").split("@")[0]!.toLowerCase().replace(/[^a-z]/g, "");
  if (local && words.length >= 3) {
    const w = words.map((x) => x.toLowerCase().replace(/[^a-z]/g, ""));
    if (w[0] && !local.includes(w[0]) && w[1] && local.includes(w[1]) && local.includes(w[w.length - 1]!)) words = words.slice(1);
  }
  return words.map(fixCase).join(" ");
}
