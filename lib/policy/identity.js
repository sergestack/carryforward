// Codex `account/rateLimits/read` field `accountId`.
// Same value as `account/read` workspaceRouting.chatgptAccountId on current app-server.
// The account object itself only carries email and plan, which are not used.
// This id is for in-memory equality. Do not render, log, or persist it.

export function quotaAccountId(result) {
  const value = result?.accountId;
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > 128) return null;
  if (/\s/.test(id) || id.includes('@') || id.startsWith('eyJ')) return null;
  return id;
}
