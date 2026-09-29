import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { selectBoundSession } from './bind.js';
import { classifyQuotaRecord } from './quota.js';

const HEADER_BYTES = 256 * 1024;
const SKEW_MS = 2000;

function walkRollouts(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRollouts(full, out);
    else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

export function readSessionHeader(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    const line = nl === -1 ? text : text.slice(0, nl);
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    if (obj?.type !== 'session_meta' || !obj.payload || typeof obj.payload !== 'object') return null;
    const payload = obj.payload;
    const id = typeof payload.id === 'string' ? payload.id : (typeof payload.session_id === 'string' ? payload.session_id : null);
    if (!id) return null;
    return {
      id,
      path: file,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
      timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : (typeof obj.timestamp === 'string' ? obj.timestamp : null),
      source: typeof payload.source === 'string' ? payload.source : '',
      threadSource: typeof payload.thread_source === 'string' ? payload.thread_source : '',
      parentThreadId: typeof payload.parent_thread_id === 'string' ? payload.parent_thread_id : '',
    };
  } finally {
    fs.closeSync(fd);
  }
}

function canonicalPath(file) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

function samePath(left, right) {
  if (!left || !right) return false;
  return canonicalPath(left).replace(/\/+$/, '') === canonicalPath(right).replace(/\/+$/, '');
}

export function sessionCandidates(sessionsDir, { openPaths = [], startedAt, cwd }) {
  const files = [];
  walkRollouts(sessionsDir, files);
  const open = new Set(openPaths.map((file) => canonicalPath(file)));
  const candidates = [];
  for (const file of files) {
    const header = readSessionHeader(file);
    if (!header) continue;
    let bornAt = 0;
    try { bornAt = fs.statSync(file).birthtimeMs || fs.statSync(file).mtimeMs; } catch { bornAt = 0; }
    const bornAfterStart = bornAt >= startedAt - SKEW_MS;
    candidates.push({
      ...header,
      openedByChild: open.has(canonicalPath(file)),
      bornAfterStart,
      cwdMatches: samePath(header.cwd, cwd),
      cliSource: header.source === 'cli' || header.source === 'exec',
    });
  }
  return candidates;
}

function descendantPids(rootPid) {
  return new Promise((resolve) => {
    execFile('ps', ['-ax', '-o', 'pid=', '-o', 'ppid='], { timeout: 2000 }, (err, stdout) => {
      if (err && !stdout) return resolve([rootPid]);
      const edges = new Map();
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!match) continue;
        const pid = Number(match[1]);
        const parent = Number(match[2]);
        if (!edges.has(parent)) edges.set(parent, []);
        edges.get(parent).push(pid);
      }
      const out = [];
      const stack = [rootPid];
      const seen = new Set();
      while (stack.length && out.length < 20) {
        const pid = stack.pop();
        if (seen.has(pid)) continue;
        seen.add(pid);
        out.push(pid);
        for (const child of edges.get(pid) || []) stack.push(child);
      }
      resolve(out);
    });
  });
}

export function filesOpenedByPid(pid, sessionsDir) {
  return new Promise((resolve) => {
    execFile('lsof', ['-n', '-P', '-p', String(pid), '-Fn'], { timeout: 2000 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      let root = path.resolve(sessionsDir);
      try { root = fs.realpathSync(sessionsDir); } catch { /* dir may not exist yet */ }
      const files = [];
      for (const line of String(stdout).split('\n')) {
        if (!line.startsWith('n')) continue;
        const raw = line.slice(1);
        const file = canonicalPath(raw);
        if (file !== root && !file.startsWith(`${root}${path.sep}`)) continue;
        if (!path.basename(file).startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
        files.push(file);
      }
      resolve([...new Set(files)]);
    });
  });
}

export async function openSessionFiles(pid, sessionsDir, listOpenFiles) {
  if (listOpenFiles) return listOpenFiles(pid);
  const pids = await descendantPids(pid);
  const found = [];
  let available = false;
  for (const id of pids) {
    const files = await filesOpenedByPid(id, sessionsDir);
    if (files) {
      available = true;
      found.push(...files);
    }
  }
  return available ? [...new Set(found)] : null;
}

function readAppended(file, offset) {
  const stat = fs.statSync(file);
  let start = offset;
  if (stat.size < start) start = 0;
  if (stat.size === start) return { offset: start, records: [] };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let end = buf.length;
    while (end > 0 && buf[end - 1] !== 10) end -= 1;
    if (end === 0) return { offset: start, records: [] };
    const records = [];
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* incomplete or non-json */ }
    }
    return { offset: start + end, records };
  } finally {
    fs.closeSync(fd);
  }
}

function eventIsCurrent(record, session, startedAt) {
  const stamp = Date.parse(record?.timestamp || '');
  if (Number.isFinite(stamp)) return stamp >= startedAt - SKEW_MS;
  const born = Date.parse(session?.timestamp || '');
  if (Number.isFinite(born) && born < startedAt - SKEW_MS) return false;
  return true;
}

function isPrimary(session) {
  return session.threadSource !== 'subagent' && !session.parentThreadId;
}

function snapshotSizes(sessionsDir) {
  const sizes = new Map();
  const files = [];
  walkRollouts(sessionsDir, files);
  for (const file of files) {
    try { sizes.set(canonicalPath(file), fs.statSync(file).size); } catch { /* gone */ }
  }
  return sizes;
}

function takeRecords(session, offsets, sizesAtStart) {
  const key = canonicalPath(session.path);
  if (!offsets.has(key)) offsets.set(key, sizesAtStart.get(key) || 0);
  const next = readAppended(session.path, offsets.get(key));
  offsets.set(key, next.offset);
  return next.records;
}

export async function waitForSupervisedEvent({
  child,
  sessionsDir,
  cwd,
  startedAt,
  userStop,
  pollMs = 200,
  listOpenFiles,
}) {
  const offsets = new Map();
  // Bytes already on disk when supervision starts are history, not this run.
  const sizesAtStart = snapshotSizes(sessionsDir);
  while (true) {
    if (userStop?.requested) return { type: 'user_stop' };
    let openPaths = [];
    let openFilesAvailable = true;
    try {
      const opened = await openSessionFiles(child.pid, sessionsDir, listOpenFiles);
      if (opened == null) {
        openFilesAvailable = false;
        openPaths = [];
      } else {
        openPaths = opened;
      }
    } catch {
      openPaths = [];
    }
    let candidates = [];
    try {
      candidates = sessionCandidates(sessionsDir, { openPaths, startedAt, cwd });
    } catch {
      candidates = [];
    }
    const bound = selectBoundSession(candidates, { openFilesAvailable });
    try {
      if (bound.status === 'ambiguous') {
        for (const session of (bound.pool || []).filter(isPrimary)) {
          const records = takeRecords(session, offsets, sizesAtStart);
          const hit = records.some((record) => eventIsCurrent(record, session, startedAt) && classifyQuotaRecord(record));
          if (hit) return { type: 'ambiguous' };
        }
      } else if (bound.status === 'bound') {
        const records = takeRecords(bound.session, offsets, sizesAtStart);
        for (const record of records) {
          if (!eventIsCurrent(record, bound.session, startedAt)) continue;
          const quota = classifyQuotaRecord(record);
          if (!quota) continue;
          return {
            type: 'quota',
            code: quota.code,
            session: { id: bound.session.id, path: bound.session.path, cwd: bound.session.cwd },
          };
        }
      }
    } catch {
      // The rollout can appear mid-write. The next poll reads it again.
    }
    if (child.settled) {
      if (userStop?.requested) return { type: 'user_stop' };
      return { type: 'exit', code: child.result?.code ?? 0, signal: child.result?.signal || null };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
