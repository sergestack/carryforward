import { collectClaudeUsage } from './claude.js';
import { collectCodexUsage } from './codex.js';
import { collectGrokUsage } from './grok.js';
import { unknownUsage } from './state.js';

const collectors = {
  codex: collectCodexUsage,
  claude: collectClaudeUsage,
  grok: collectGrokUsage,
};

export async function collectUsage(profile, deps = {}) {
  const collector = collectors[profile?.agent];
  if (!collector) {
    return unknownUsage(profile?.target || null, `No usage provider for ${profile?.agent || 'this agent'}`);
  }
  try {
    return await collector(profile, deps);
  } catch {
    return unknownUsage(profile?.target || null, 'Usage provider failed');
  }
}

export async function collectMany(profiles, deps = {}) {
  const results = await Promise.all(profiles.map(async (profile) => {
    try {
      return await collectUsage(profile, deps);
    } catch {
      return unknownUsage(profile.target, 'Usage provider failed');
    }
  }));
  return results;
}
