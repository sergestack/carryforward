import fs from 'node:fs';
import path from 'node:path';

function isSubagent(session) {
  return session.threadSource === 'subagent' || Boolean(session.parentThreadId);
}

function primarySessions(sessions) {
  return sessions.filter((session) => !isSubagent(session));
}

function sameFile(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

// Fail closed. A missing or duplicate match does not guess "newest".
// Birth/cwd matching is used only when the process file listing is unavailable.
export function selectBoundSession(candidates, { openFilesAvailable = true } = {}) {
  const opened = candidates.filter((session) => session.openedByChild);
  const born = candidates.filter((session) => session.bornAfterStart && session.cwdMatches && session.cliSource);
  const pool = opened.length ? opened : (openFilesAvailable ? [] : born);
  if (!pool.length) return { status: 'pending', pool: [] };
  const usable = primarySessions(pool);
  if (usable.length === 1) return { status: 'bound', session: usable[0], pool };
  if (usable.length === 0) return { status: 'pending', pool: [] };
  return { status: 'ambiguous', pool };
}

// Exact id and exact file. A prefix of another session id is not a match.
export function matchBoundSession(sessions, bound) {
  if (!bound?.id || !bound?.path) return { ok: false, error: 'bound session was not found' };
  const hits = (sessions || []).filter((session) => session.id === bound.id);
  if (hits.length !== 1) return { ok: false, error: 'bound session was not found' };
  const session = hits[0];
  if (!session.originalPath || !sameFile(session.originalPath, bound.path)) {
    return { ok: false, error: 'bound session was not found' };
  }
  return { ok: true, session };
}
