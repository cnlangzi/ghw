# ghw

> GitHub team workflow automation - auto-driven PR review with label-based state machine.

`ghw` is a skill for [OpenClaw](https://github.com/openclaw/openclaw) that automates the PR review lifecycle using GitHub labels. No session state, no wip.json - just a repo pool and a label protocol.

## Features

- **Auto-driven review** - `/ghw review` picks a repo and PR automatically, agent reviews the diff.
- **Label-based state machine** - PR state tracked via mutually exclusive `ghw/*` labels.
- **Round-robin** - Reviews are distributed across repos evenly.
- **Zero session state** - No wip.json, no workdir context. Just repos and labels.
- **Auto label creation** - `ghw/*` labels are created on first use.
- **No npm dependencies** - Pure Node.js built-ins.

## Installation

```bash
git clone https://github.com/cnlangzi/ghw.git
cp -r ghw ~/workspace/skills/
```

Configure your GitHub Personal Access Token in `~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "entries": {
      "ghw": {
        "enabled": true,
        "env": {
          "GITHUB_ACCESS_TOKEN": "ghp_your_token_here"
        }
      }
    }
  }
}
```

## Label System

All `ghw/*` labels are mutually exclusive - only one can exist on a PR at a time:

| Label | Meaning | Who sets it |
|-------|---------|-------------|
| `ghw/ready` | Waiting for review | Developer (`/ghw pr`) |
| `ghw/wip` | Review in progress | Agent (`/ghw review`) |
| `ghw/lgtm` | Approved | Agent (`/ghw review #<pr> approved`) |
| `ghw/revise` | Changes requested | Agent (`/ghw review #<pr> revise`) |

## Quick Start

### 1. Add repos to automation pool

```bash
/ghw auto add owner/repo1
/ghw auto add owner/repo2
/ghw auto list
```

### 2. Create a PR

```bash
# Work on your feature
cd ~/code/myproject
git checkout -b fix/123

# After your changes
/ghw pr ~/code/myproject
# -> Pushes branch, creates PR with ghw/ready label
```

### 3. Review

```bash
# Agent picks up the PR automatically
/ghw review
# -> Claims ghw/ready PR, sets ghw/wip, returns diff

# After reviewing the diff and linked issue:
/ghw review #45 approved   # -> ghw/lgtm
/ghw review #45 revise     # -> ghw/revise
```

## Command Reference

### Automation Pool

```
/ghw auto add owner/repo    Add repo to pool (creates ghw/* labels on first use)
/ghw auto remove owner/repo Remove repo from pool
/ghw auto list              List all repos in pool
```

### Review

```
/ghw review                     Pick repo + PR, claim (ghw/wip), return diff
/ghw review #<pr> approved     Approve: ghw/wip -> ghw/lgtm
/ghw review #<pr> revise       Request changes: ghw/wip -> ghw/revise
```

### Git Operations

```
/ghw fix <workdir> [name]      Fetch/rebase main, create branch
/ghw pr <workdir> [title]     Push branch, create PR with ghw/ready
/ghw push <workdir>            Stage changes (git add -A)
/ghw confirm <workdir> [msg]   Commit and push
```

### Info

```
/ghw issue owner/repo [--state=open]   List issues
/ghw show #<pr>                        Show PR details
/ghw config                             Show auto repos and token status
```

## Workflow Diagram

```
Developer                  Agent                    GitHub
   |                        |                        |
   |-- /ghw pr ------------>|                        |
   |                        |-- push + PR + ghw/ready -->|
   |                        |                        |
   |                        |-- /ghw review -------->|
   |                        |<--- PR diff + issue ----|
   |                        |                        |
   |<-- review result -----|                        |
   |                        |-- ghw/wip label ------->|
   |                        |                        |
   |  (code changes)        |                        |
   |                        |                        |
   |                        |-- /ghw review #<pr> ->|
   |                        |   lgtm|revise     |
   |                        |-- ghw/lgtm/ghw/revise ->|
   |                        |                        |
```

## Architecture

```
~/.openclaw/ghw/
├── token.json       # OAuth access token (0600)
└── auto-repos.json # Automation pool {"repos": [], "lastRepo": null}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_ACCESS_TOKEN` | Yes | GitHub Personal Access Token |
| `GITHUB_CLIENT_ID` | No | For OAuth Device Flow (instead of PAT) |
| `GITHUB_CLIENT_SECRET` | No | For OAuth Device Flow |

## Cron Setup

Set up periodic review polling:

```bash
openclaw cron add \
  --name "ghw-review" \
  --cron "*/15 * * * *" \
  --session main \
  --system-event "/ghw review" \
  --enabled
```

## Contributing

Contributions follow [Conventional Commits](https://www.conventionalcommits.org/).
