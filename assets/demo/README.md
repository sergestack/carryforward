# CarryForward demo storyboard

Target length: 15 seconds. Record a terminal at a readable size. Use example profile names such as `codex:default` and `codex:east`.

Do not exhaust a real Codex account to record this. Do not show usernames, email addresses, account ids, private paths, or project names.

The GIF is not recorded yet. When it exists, save it as `assets/demo/carryforward-demo.gif` and show it from the README.

## Shots

| Time | What is on screen |
| --- | --- |
| 0–3s | `carryforward status` with two independent Codex pools and `Auto-failover: ready`. |
| 3–6s | `carryforward run codex:default` starting the supervised session. |
| 6–11s | A simulated quota exhaustion. The safe public command is `carryforward run codex:default --simulate-rate-limit`. It plans the switch and does not launch or stop anything. |
| 11–15s | The successor is the next verified pool, with the prior session context carried forward. The failed prompt is not sent again. |

## Lines to show for a live switch

These are the lines `carryforward run` prints after a supervised session records `usage_limit_exceeded`:

```text
CarryForward: codex:default reached its current quota.
CarryForward: continuing with codex:east.
```

Use another verified profile name if `codex:east` is not the next pool. Produce these lines with a scripted `usage_limit_exceeded` event, as the failover screenshot does. Do not provoke a real quota failure.

## Lines the safe command prints

`carryforward run codex:default --simulate-rate-limit` is the command to run in a terminal without touching quota. Its wording is the simulation, not the live switch:

```text
CarryForward: simulation only. No process was launched.
CarryForward: codex:default would be treated as quota exhausted.
CarryForward: next codex:east
```

A public recording can use this command for the middle of the demo. Cut to the live wording above only when it comes from the scripted supervisor, not from a real account limit.
