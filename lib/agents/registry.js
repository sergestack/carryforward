import { discover as discoverClaude } from './claude.js';
import { discover as discoverCodex } from './codex.js';
import { discover as discoverCopilot } from './copilot.js';
import { discover as discoverGemini } from './gemini.js';
import { discover as discoverGrok } from './grok.js';
import { discover as discoverOpenCode } from './opencode.js';

// Order is the display order of `carryforward agents`.
const providers = [
  discoverCodex,
  discoverClaude,
  discoverGrok,
  discoverGemini,
  discoverOpenCode,
  discoverCopilot,
];

export function discoverAgents(probe) {
  return providers.flatMap((discover) => discover(probe));
}
