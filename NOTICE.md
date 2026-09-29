# Notices

`carryforward` launches local coding agents and reads their session files. Context extraction is performed by a pinned copy of [cli-continues](https://github.com/yigitkonur/cli-continues). The built runtime ships in this repository under `third_party/cli-continues` and is not part of CarryForward's application code.

## cli-continues

Copyright (c) 2025-2026 Yigit Konur

Licensed under the MIT License. The full permission notice is in `third_party/cli-continues/LICENSE`. That copyright notice and permission notice must stay with any copy or substantial portion of cli-continues.

The installed library is pinned in `third_party/cli-continues/VENDOR.json`:

- package: cli-continues
- upstream: https://github.com/yigitkonur/cli-continues
- version: 4.1.1
- commit: `e486cd22a592d89d890cff056624647fbe9cbe80`

`carryforward` does not rename, re-author, or relicense that library. Its license file stays as upstream published it. The compiled `dist` and the production dependencies from that commit's lockfile are included unmodified. Each dependency keeps the license file that shipped with it.

## This repository

CarryForward is MIT licensed. See `LICENSE`.

Copyright (c) 2026 sergestack
