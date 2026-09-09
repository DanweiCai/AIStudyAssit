/**
 * Resolves the API base URL. Trailing slashes are stripped so callers can
 * always join paths with a single leading slash.
 */
export function apiBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.NEXT_PUBLIC_API_BASE_URL;
  if (raw === undefined || raw.trim() === "") {
    throw new Error("NEXT_PUBLIC_API_BASE_URL is not set — see .env.example");
  }
  return raw.trim().replace(/\/+$/, "");
}
