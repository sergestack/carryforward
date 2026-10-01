# CarryForward end-to-end demo

[Watch the 1080p MP4](carryforward-demo.mp4) · [README GIF](carryforward-demo.gif)

A 10.7-second recording of the real `carryforward run codex:alpha` CLI, rendered as a dark terminal. The agents and their work are fictional; detection, session binding, quota classification, fallback planning, context extraction, secure payload creation, child shutdown, and successor launch use unchanged production code. The terminal transition lines come directly from CarryForward stdout.

## Isolation and verification

`record.mjs` creates a temporary HOME and an allowlisted PATH containing only Node, CarryForward, the fake Codex executable, and available system process-inspection tools. It builds the child environment from scratch, with no inherited credentials or configuration. Both profiles, fallback config, sessions, and handoff payloads live inside the disposable sandbox, which is removed afterward. No real Codex executable or account is used.

Alpha holds its rollout file open for the production PID/file binder. After three seconds it appends the structured Codex record shape used by the production supervisor tests:

```json
{"timestamp":"<ISO timestamp>","type":"event_msg","payload":{"type":"error","codex_error_info":"usage_limit_exceeded","message":"You have hit your usage limit."}}
```

The fake app-server answers the real usage collector with independent fictional quota pools. Beta reads the real secure payload, verifies its SHA-256, exact source session, task, and prior progress, and checks that Alpha stopped first. Only then does it display the continuation. The fictional coding and test-success lines are simulated agent output.

`recording.json` preserves actual stdout timestamps and the fixture audit. Only the initial shell command is added by the recorder. Output is neither reordered nor retimed. Pillow draws the captured terminal text; FFmpeg encodes H.264 MP4 and a looping 1280px GIF. The frame includes an isolated-demo label. There is no narration or cursor.

## Reproduce

Requires Node 22.5+, Python with Pillow, FFmpeg, and DejaVu fonts. Run from the repository root:

```sh
rtk node assets/demo/record.mjs
rtk python3 assets/demo/render.py
rtk npm test
```

Review both media files before publishing. The renderer also writes a four-frame contact sheet to `/tmp/carryforward-demo-review.png`.
