import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configPath } from '../policy/config.js';
import { packageRoot } from '../runtime.js';

const HELP = `carryforward uninstall — remove CarryForward-owned files

  carryforward uninstall --dry-run
  carryforward uninstall --yes
  carryforward uninstall --delete-config --yes

Removes the carryforward command symlink when it points at this install,
and the CarryForward cache. Codex, Claude, Grok, their configuration,
sessions, and credentials are left in place. The shared extractor
directory is left in place. CarryForward's own fallback file is kept
unless --delete-config is combined with --yes.
`;

function streams(options) {
  return {
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr,
  };
}

function parseUninstall(argv) {
  const flags = { dryRun: false, yes: false, deleteConfig: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--dry-run') { flags.dryRun = true; continue; }
    if (arg === '--yes') { flags.yes = true; continue; }
    if (arg === '--delete-config') { flags.deleteConfig = true; continue; }
    return { error: `Unknown argument: ${arg}` };
  }
  return flags;
}

function describe(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return { kind: 'link' };
    if (stat.isDirectory()) return { kind: 'dir' };
    if (stat.isFile()) return { kind: 'file' };
    return { kind: 'other' };
  } catch {
    return { kind: 'missing' };
  }
}

function pointsAt(file, expected) {
  try {
    return fs.realpathSync(file) === fs.realpathSync(expected);
  } catch {
    return false;
  }
}

export function uninstallPlan(options = {}) {
  const home = options.home || os.homedir();
  const root = options.root || packageRoot();
  const expected = path.join(root, 'bin', 'carryforward');
  const remove = [];
  const keep = [];

  const command = path.join(home, '.local', 'bin', 'carryforward');
  const commandInfo = describe(command);
  if (commandInfo.kind === 'link' && pointsAt(command, expected)) remove.push(command);
  else if (commandInfo.kind !== 'missing') keep.push(command);

  const share = path.join(home, '.local', 'share', 'carryforward');
  const shareInfo = describe(share);
  if (shareInfo.kind === 'link') remove.push(share);
  else if (shareInfo.kind !== 'missing') keep.push(share);

  const cache = path.join(home, '.cache', 'carryforward');
  if (describe(cache).kind !== 'missing') remove.push(cache);

  const config = configPath({ home, env: options.env || {} });
  if (describe(config).kind !== 'missing') {
    if (options.deleteConfig) remove.push(config);
    else keep.push(config);
  }
  return { remove, keep };
}

function discard(file, home) {
  const cache = path.join(home, '.cache', 'carryforward');
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || stat.isFile()) {
    fs.unlinkSync(file);
    return;
  }
  if (stat.isDirectory() && path.resolve(file) === path.resolve(cache)) {
    fs.rmSync(file, { recursive: true });
  }
}

export async function runUninstall(argv, options = {}) {
  const { stdout, stderr } = streams(options);
  const parsed = parseUninstall(argv);
  if (parsed.help) {
    stdout.write(HELP);
    return 0;
  }
  if (parsed.error) {
    stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const home = options.home || os.homedir();
  const plan = uninstallPlan({ ...options, home, deleteConfig: parsed.deleteConfig });
  const lines = [];
  lines.push(plan.remove.length ? 'Would remove:' : 'Would remove:\n  (nothing)');
  for (const file of plan.remove) lines.push(`  ${file}`);
  lines.push('', plan.keep.length ? 'Would keep:' : 'Would keep:\n  (nothing extra)');
  if (plan.keep.length) for (const file of plan.keep) lines.push(`  ${file}`);
  if (parsed.dryRun) {
    lines.push('', 'Dry run. Nothing was removed.');
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
  if (!parsed.yes) {
    if (!plan.remove.length) {
      stdout.write('Nothing to remove.\n');
      return 0;
    }
    lines.push('', 'Re-run with carryforward uninstall --yes to remove the files above.');
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
  for (const file of plan.remove) discard(file, home);
  const done = ['Removed:'];
  for (const file of plan.remove) done.push(`  ${file}`);
  if (plan.keep.length) {
    done.push('', 'Kept:');
    for (const file of plan.keep) done.push(`  ${file}`);
  }
  stdout.write(`${done.join('\n')}\n`);
  return 0;
}
