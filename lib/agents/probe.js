import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function canExecute(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// PATH entries may contain spaces. Split only on the platform delimiter.
export function which(command, pathValue = '') {
  return whichAll(command, pathValue)[0] || null;
}

export function whichAll(command, pathValue = '') {
  if (!command) return [];
  if (command.includes('/') || command.includes('\\')) {
    return canExecute(command) ? [command] : [];
  }
  const found = [];
  for (const dir of String(pathValue).split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (canExecute(candidate)) found.push(candidate);
  }
  return found;
}

export function readTextHead(file, max = 4096) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    const text = buf.slice(0, n).toString('utf8');
    if (text.includes('\0')) return null;
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function fileAssignsEnv(file, name) {
  const text = readTextHead(file);
  if (!text) return false;
  return new RegExp(`\\b${name}\\s*=`).test(text);
}

// Follow one `exec` line in a small wrapper script. $HOME is the probe home.
export function wrapperExecTarget(file, home) {
  const text = readTextHead(file);
  if (!text) return null;
  const match = text.match(/^\s*exec\s+(?:"([^"]+)"|'([^']+)'|(\S+))/m);
  if (!match) return null;
  const raw = (match[1] || match[2] || match[3]).replaceAll('$HOME', home).replace(/^~(?=\/)/, home);
  const bin = raw.split(/\s+/)[0];
  return canExecute(bin) ? bin : null;
}

export function readVersion(executable) {
  try {
    const result = execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return firstLine(result);
  } catch (err) {
    return firstLine(`${err.stdout || ''}\n${err.stderr || ''}`);
  }
}

function firstLine(text) {
  const line = String(text)
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  return line || null;
}

export function machineProbe(env = process.env) {
  const versions = new Map();
  return {
    home: os.homedir(),
    env,
    which(command) {
      return which(command, env.PATH ?? '');
    },
    whichAll(command) {
      return whichAll(command, env.PATH ?? '');
    },
    assignsEnv(file, name) {
      return fileAssignsEnv(file, name);
    },
    execTarget(file) {
      return wrapperExecTarget(file, os.homedir());
    },
    version(executable) {
      if (!executable) return null;
      if (versions.has(executable)) return versions.get(executable);
      const version = readVersion(executable);
      versions.set(executable, version);
      return version;
    },
    exists(filePath) {
      try {
        fs.accessSync(filePath);
        return true;
      } catch {
        return false;
      }
    },
    isDirectory(filePath) {
      try {
        return fs.statSync(filePath).isDirectory();
      } catch {
        return false;
      }
    },
    listDir(dir) {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}
