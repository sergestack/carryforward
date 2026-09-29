import { unknownUsage } from './state.js';

// `grok usage <session>` prints tokens and cost for one session. That is not
// remaining account capacity. The billing endpoint needs auth.json.
export function collectGrokUsage(profile) {
  return unknownUsage(
    profile?.target || 'grok',
    'Grok has no supported command for remaining account capacity. Session cost is not a quota meter, and CarryForward does not read auth.json',
  );
}
