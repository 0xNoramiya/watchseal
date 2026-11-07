/**
 * Turns backend failures into messages that say what went wrong and what to do next.
 * The raw message is kept at the end for debugging.
 */
export function humanizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = String((err as { code?: unknown })?.code ?? "");
  const text = `${code} ${raw}`;
  const hint = (() => {
    if (/429|RESOURCE_EXHAUSTED|rate limit|too many requests/i.test(text))
      return "Tatum rate-limited a burst of requests. Wait a few seconds and try again.";
    if (/UNAUTHENTICATED|PERMISSION_DENIED|401|403|invalid api key/i.test(text))
      return "Tatum rejected the API key. Check TATUM_API_KEY in .env.";
    if (/UNAVAILABLE|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|DEADLINE_EXCEEDED|fetch failed|socket hang up/i.test(text))
      return "Could not reach the backend in time. Check the network connection and try again.";
    if (/archival GraphQL/i.test(text)) return "The archival Sui GraphQL endpoint did not answer. Try again in a moment.";
    if (/NOT_FOUND|not found/i.test(text) && /package|object/i.test(text))
      return "Sui Mainnet has no package with that ID. Paste the original (v1) package ID.";
    if (/relayer|memwal|walrus/i.test(text)) return "Walrus Memory did not answer. Memories already written are safe; try again in a moment.";
    return null;
  })();
  if (!hint) return raw;
  return raw && !raw.includes(hint) ? `${hint} (${raw.slice(0, 160)})` : hint;
}
