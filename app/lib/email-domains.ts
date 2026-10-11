export function normalizeEmailDomains(value: string): string[] {
  return [...new Set(value.split(",").map(domain => domain.trim().toLowerCase()).filter(Boolean))]
}
