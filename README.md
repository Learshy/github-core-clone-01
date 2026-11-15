# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Learshy/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Learshy/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process, stdlib only: git smart HTTP (upload-pack protocol v2, receive-pack v0, packs built and parsed by hand), the REST v3 API for repositories, issues, pull requests and contents, the GraphQL v4 API, and a Model Context Protocol endpoint. Deterministic state, no git binary, no outside service. Built for make.fun's "Build a GitHub-compatible git forge" bounty.

## Run it

```sh
node --experimental-strip-types main.ts
```

The forge binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL`, and serves with the shop token in `$MAKEFUN_SHOP_TOKEN` until the suite reports done.

---

<sub>Entered on [make.fun](https://make.fun/?ref=fefh13fc&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
