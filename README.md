# CarryForward

CarryForward keeps AI coding work moving when one Codex account reaches its usage limit.

It discovers the coding agents and profiles installed on this machine, learns which Codex profiles share one allowance, and can move the active session to another verified Codex account.

## Install

macOS and Linux. Node.js 22.5 or newer.

```bash
./install.sh
carryforward setup
carryforward run codex:default
```

`install.sh` links `~/.local/bin/carryforward` at this checkout. It does not need sudo, and it does not download anything. An existing CarryForward config is left alone. If `~/.local/bin` is not on `PATH`, the installer prints the full command to run. If the bundled extractor is missing or does not match its pin, the installer stops and leaves `~/.local/bin/carryforward` unchanged.

`carryforward setup` lists what it found, groups Codex profiles that share an allowance, and asks before saving a chain. The chain keeps one profile from each independent quota pool. Within a pool, CarryForward prefers the profile named `default`. Otherwise it uses the profile name that sorts first. The account id is not a sort key and is not written to disk.

## Automatic failover

`carryforward run codex:default` starts that Codex profile in the foreground and watches only the process it started. When that session records `usage_limit_exceeded`, CarryForward plans the next verified Codex profile, writes the prior context, stops only that process, and opens the successor. The failed prompt is not sent again.

```bash
carryforward run codex:default
```

A direct `codex` launch is not supervised. `carryforward <target>` remains a manual handoff.

## Manual handoff

Claude and Grok can receive a session by name. Their remaining quota cannot currently be verified, so they are manual destinations.

```bash
carryforward claude:default
carryforward grok:default
```

## Quota pools

Codex profiles signed into the same account share one allowance. Setup explains that and suggests only one of them for automatic failover. During setup, answer `n` to pick a different profile from that pool.

One Codex account is a supported setup. Automatic failover waits until a second independent Codex account exists. CarryForward does not fill the chain with an agent whose quota it cannot verify.

## Status

```bash
carryforward status
carryforward doctor
```

`carryforward status` answers whether automatic failover is ready. `carryforward doctor` checks Node, this install, session directories, `lsof`, config, and live Codex usage. A missing optional agent is a warning.

## Privacy

CarryForward does not read credential files to group accounts. Codex quota is read from that profile's local app-server usage call. The account id stays in memory for the length of the command and is compared only with other Codex profiles. Config stores profile names:

```json
{
  "version": 1,
  "fallback": ["codex:default", "codex:second"]
}
```

The file is `$CARRYFORWARD_CONFIG_HOME/fallback.json` when that variable is set, otherwise `$XDG_CONFIG_HOME/carryforward/fallback.json`, otherwise `~/.config/carryforward/fallback.json`, mode `0600`. A malformed file or an unsupported `version` is left unchanged.

## Supported agents

| Agent | Detect | Manual handoff | Live quota | Auto failover |
| --- | --- | --- | --- | --- |
| Codex | yes | yes | yes | yes |
| Claude | yes | yes | no | no |
| Grok | yes | yes | no | no |
| Gemini | yes | launch only | no | no |
| OpenCode | yes | no | no | no |
| Copilot | yes | no | no | no |

Gemini can be launched when it is installed. It has no session source. OpenCode and Copilot are discovered only.

## Platforms

macOS and Linux. Node.js 22.5 or newer. Automatic session binding uses `lsof` when it is on `PATH`. Without `lsof`, CarryForward will not guess among several new sessions.

## Limitations

- Automatic failover is Codex to Codex, and only for a process started with `carryforward run`.
- A second independent Codex account is required before a chain can be saved.
- If the active rollout cannot be identified uniquely, CarryForward leaves that session running.
- Claude and Grok have no safe live quota meter.
- `carryforward setup` does not create a chain unless you accept it.

## Configuration

`carryforward fallback` shows the saved chain. `carryforward fallback set codex:default codex:second` replaces it. `carryforward next codex:default` plans the next verified profile and launches nothing.

`carryforward run` with no saved chain stops and tells you to run `carryforward setup`. It does not invent a config file.

## Uninstall

```bash
carryforward uninstall --dry-run
carryforward uninstall --yes
```

This removes CarryForward command links that point at this install, and the CarryForward cache. Codex, Claude, Grok, their configuration, sessions, and credentials stay. CarryForward's fallback file stays unless you pass `--delete-config --yes`.

## Vendored extractor

Context extraction comes from [cli-continues](https://github.com/yigitkonur/cli-continues) v4.1.1, MIT, Copyright (c) 2025-2026 Yigit Konur, pinned at `e486cd22a592d89d890cff056624647fbe9cbe80`. See `NOTICE.md` and `third_party/cli-continues/LICENSE`. CarryForward calls the library parsers only.

That commit's compiled runtime ships in this repository at `third_party/cli-continues`, with its MIT license and the production dependencies the parsers load. Installation does not fetch it. `CARRYFORWARD_VENDOR` can point at another checkout of that same pin.

## License

CarryForward is MIT licensed. See `LICENSE`.

Copyright (c) 2026 sergestack

`cli-continues` is a separate vendored MIT dependency. Its copyright and permission notice stay with that library.
