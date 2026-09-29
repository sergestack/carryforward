import { unknownUsage } from './state.js';

// Claude Code 2.1.x has no usage subcommand. The subscription meter that
// other tools read comes from OAuth credentials. CarryForward does not open those.
// A status-line snapshot is historical and is not treated as current quota.
export function collectClaudeUsage(profile) {
  return unknownUsage(
    profile?.target || 'claude',
    'Claude Code has no native usage command that reports subscription quota without reading OAuth credentials',
  );
}
