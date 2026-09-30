# Screenshot capture

The PNG files in this directory are renders of CarryForward's own command output. The profiles are the example names `codex:default`, `codex:east`, and `codex:second`. No account id, email, username, private path, or project name is included.

| File | Command output |
| --- | --- |
| `setup.png` | `carryforward setup` with two Codex pools, one shared allowance, and the automatic chain |
| `status.png` | `carryforward status` with quota pools, remaining 5-hour usage, and `Auto-failover: ready` |
| `failover.png` | `carryforward run` after a scripted `usage_limit_exceeded` event |

## Recapture checklist

1. Prefer example profile names. If you capture a real machine, remove usernames, email addresses, account ids, home paths, and project names before committing.
2. Setup must show discovered agents, the shared Codex allowance sentence, and the `Automatic failover` chain. Accepting the prompt is optional in a capture; the saved chain must still be visible.
3. Status must show `Quota pools`, a remaining-usage hint such as `5-hour 40% left`, and `Auto-failover: ready`.
4. Failover must show `CarryForward: codex:default reached its current quota.` and `CarryForward: continuing with` the next verified profile.
5. Do not provoke a real quota failure. `carryforward run <target> --simulate-rate-limit` plans a switch and launches nothing. That command prints `would be treated as quota exhausted`, which is a different screen from the live lines in `failover.png`.
6. The live failover lines come from the supervisor when it is given a scripted `usage_limit_exceeded` event. That path does not start Codex and does not contact an account.
