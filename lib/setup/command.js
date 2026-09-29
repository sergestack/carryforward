import { createInterface } from 'node:readline/promises';
import { discoverAgents } from '../agents/registry.js';
import { machineProbe } from '../agents/probe.js';
import { validateFallback, writeFallback } from '../policy/config.js';
import { collectMany } from '../usage/registry.js';
import { buildSetupPlan, chainLines, renderSetup } from './plan.js';

const HELP = `carryforward setup — find agents and save an automatic Codex chain

  carryforward setup
  carryforward setup --yes

Lists installed agents and profiles. Codex profiles that share one
allowance are one quota pool. The suggested chain keeps one profile
from each independent pool: the profile named default when that pool
has one, otherwise the profile name that sorts first. The account id
is not used to choose and is not saved.

Claude and Grok stay manual. --yes saves the suggestion without waiting.
Answer n to pick a different profile from a shared pool.
`;

function streams(options) {
  return {
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr,
  };
}

function parseSetup(argv) {
  let yes = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    return { error: `Unknown argument: ${arg}` };
  }
  return { yes };
}

function accepted(answer) {
  const value = String(answer ?? '').trim().toLowerCase();
  return value === '' || value === 'y' || value === 'yes';
}

async function ask(options, stdout, prompt, acceptYes = false) {
  if (acceptYes && options.yes) {
    stdout.write(`${prompt}\n`);
    return 'y';
  }
  if (Array.isArray(options.answers)) {
    stdout.write(`${prompt}\n`);
    if (!options.answers.length) return null;
    return options.answers.shift();
  }
  if (typeof options.answer === 'string' && !options._usedAnswer) {
    options._usedAnswer = true;
    stdout.write(`${prompt}\n`);
    return options.answer;
  }
  const input = options.stdin || process.stdin;
  if (!input.isTTY) {
    stdout.write(`${prompt}\n`);
    return null;
  }
  const rl = createInterface({ input, output: stdout });
  try {
    return await rl.question(`${prompt} `);
  } finally {
    rl.close();
  }
}

async function identitiesFor(profiles, options) {
  if (options.identities) return options.identities;
  const identities = {};
  await collectMany(profiles, {
    ...(options.deps || {}),
    captureIdentity(target, accountId) {
      identities[target] = accountId;
    },
  });
  return identities;
}

function leaks(text, secretValues) {
  return secretValues.some((id) => text.includes(id));
}

function saveOrder(plan, agents, options, stdout, stderr, secretValues) {
  const validated = validateFallback(plan.order, agents);
  if (!validated.ok) {
    stderr.write(`${validated.errors.join('\n')}\n`);
    return 1;
  }
  const saved = JSON.stringify(validated.fallback);
  if (leaks(saved, secretValues)) {
    stderr.write('CarryForward: refused to save an account identifier.\n');
    return 1;
  }
  writeFallback({ version: 1, fallback: validated.fallback }, options);
  stdout.write(`\nSaved.\n\nStart with:\n  carryforward run ${validated.fallback[0]}\n`);
  return 0;
}

export async function runSetup(argv, options = {}) {
  const { stdout, stderr } = streams(options);
  const parsed = parseSetup(argv);
  if (parsed.help) {
    stdout.write(HELP);
    return 0;
  }
  if (parsed.error) {
    stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const agents = options.agents || discoverAgents(options.probe || machineProbe());
  const codex = agents.filter((profile) => profile.agent === 'codex' && profile.handoff?.destination && profile.launch?.command);
  let identities = {};
  if (codex.length) {
    try {
      identities = await identitiesFor(codex, options);
    } catch {
      identities = {};
    }
  }
  const plan = buildSetupPlan(agents, identities);
  const rendered = renderSetup(plan);
  const secretValues = Object.values(identities).filter((id) => typeof id === 'string' && id);
  if (leaks(rendered, secretValues)) {
    stderr.write('CarryForward: refused to print an account identifier.\n');
    return 1;
  }
  stdout.write(rendered);
  if (plan.state !== 'ready') return 0;

  const prompted = { ...options, yes: parsed.yes || options.yes };
  const choice = await ask(prompted, stdout, 'Save this configuration? [Y/n]', true);
  if (choice === null) {
    stdout.write('No configuration saved. Re-run in a terminal or pass --yes.\n');
    return 0;
  }
  if (!accepted(choice)) {
    const shared = plan.groups.filter((group) => group.profiles.length > 1);
    if (!shared.length) {
      stdout.write('No configuration saved.\n\nSet one yourself:\n\n  carryforward fallback set <target> ...\n');
      return 0;
    }
    stdout.write('No configuration saved.\n\nChoose a different profile from a shared quota pool.\n');
    for (const group of shared) {
      const pick = await ask(
        prompted,
        stdout,
        `Quota pool profiles: ${group.profiles.join(', ')} [${group.representative}]`,
      );
      if (pick === null) {
        stdout.write('No configuration saved. Re-run in a terminal or pass --yes.\n');
        return 0;
      }
      const chosen = String(pick).trim();
      if (chosen === '') continue;
      if (!group.profiles.includes(chosen)) {
        stdout.write('Unknown profile. No configuration saved.\n');
        return 0;
      }
      group.representative = chosen;
    }
    plan.order = plan.groups.map((group) => group.representative);
    const chain = `${chainLines(plan.order).join('\n')}\n`;
    if (leaks(chain, secretValues)) {
      stderr.write('CarryForward: refused to print an account identifier.\n');
      return 1;
    }
    stdout.write(`\n${chain}`);
    const again = await ask(prompted, stdout, 'Save this configuration? [Y/n]');
    if (again === null) {
      stdout.write('No configuration saved. Re-run in a terminal or pass --yes.\n');
      return 0;
    }
    if (!accepted(again)) {
      stdout.write('No configuration saved.\n');
      return 0;
    }
  }
  return saveOrder(plan, agents, options, stdout, stderr, secretValues);
}
