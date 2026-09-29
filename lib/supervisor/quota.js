// Confirmed Codex quota exhaustion recorded in the current rollout.
// `usage_limit_exceeded` is the protocol code for account quota.
// Retryable `rate_limit_exceeded` and other errors are not failover.

const QUOTA_CODE = 'usage_limit_exceeded';

function errorCode(node) {
  if (!node || typeof node !== 'object') return null;
  const info = node.codex_error_info ?? node.codexErrorInfo;
  if (typeof info === 'string') return info;
  if (info && typeof info === 'object' && typeof info.type === 'string') return info.type;
  return null;
}

function stamp(record) {
  return typeof record.timestamp === 'string' ? record.timestamp : null;
}

export function classifyQuotaRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.type === QUOTA_CODE) return { code: QUOTA_CODE, at: stamp(record) };
  if (record.type !== 'event_msg' || !record.payload || typeof record.payload !== 'object') return null;
  const payload = record.payload;
  if (payload.type === QUOTA_CODE) return { code: QUOTA_CODE, at: stamp(record) };
  if (payload.type !== 'error' && payload.type !== 'task_complete') return null;
  const code = errorCode(payload) || errorCode(payload.error);
  if (code !== QUOTA_CODE) return null;
  return { code: QUOTA_CODE, at: stamp(record) };
}
