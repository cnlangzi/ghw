# gtw - Git Team Workflow

> Session-based GitHub workflow automation with auto-driven PR review.

`gtw` brings structured GitHub workflows to your OpenClaw chat interface. Issues and PRs are drafted first, confirmed later — no accidental API calls. Review is auto-driven via label state machine.

## Features

- **Session-based**: `/gtw on` sets context; all write ops are drafts until `/gtw confirm`
- **Two-phase confirm**: issue drafts, branch creation, and PR creation all deferred to `/gtw confirm`
- **Auto-driven review**: `/gtw review` picks oldest ghw/ready PR, agent reviews diff, verdict via label
- **Label protocol**: ghw/ready → ghw/wip → ghw/lgtm | ghw/revise
- **No dependencies**: pure Node.js, no npm packages needed

## Installation

```bash
# Clone and link
git clone https://github.com/cnlangzi/gtw.git
cp -r gtw ~/workspace/skills/

# Configure token
# Add to ~/.openclaw/openclaw.json:
# "skills": { "entries": { "gtw": { "enabled": true, "env": { "GITHUB_ACCESS_TOKEN": "ghp_xxx" } } } }
```

## Commands

### Session Setup
| Command | Description |
|---------|-------------|
| `/gtw on <workdir>` | Set workdir + repo in session |
| `/gtw new [title] [body]` | Issue draft (no API) |
| `/gtw update #<id> [title]` | Update issue draft (no API) |
| `/gtw confirm` | Execute all: issue + branch + PR, then clear |

### Git Operations
| Command | Description |
|---------|-------------|
| `/gtw fix [name]` | Create local branch (rebased on main) |
| `/gtw pr [title]` | Push branch, PR draft in session |
| `/gtw push` | Stage diff, commit via confirm |

### Review
| Command | Description |
|---------|-------------|
| `/gtw review` | Claim oldest ghw/ready PR |
| `/gtw review #<pr> lgtm\|revise` | Verdict: ghw/lgtm or ghw/revise |

### Pool & Info
| Command | Description |
|---------|-------------|
| `/gtw auto add\|remove\|list` | Manage automation pool |
| `/gtw issue [owner/repo]` | List open issues |
| `/gtw show #<pr>` | Show PR/issue details |
| `/gtw config` | Show token + wip.json + pool |

## Label States

| Label | State | Set By |
|-------|-------|--------|
| `ghw/ready` | Waiting for review | Developer (`/gtw confirm`) |
| `ghw/wip` | Review in progress | Agent (`/gtw review`) |
| `ghw/lgtm` | Approved | Agent (`/gtw review # pr lgtm`) |
| `ghw/revise` | Changes requested | Agent (`/gtw review # pr revise`) |

## Workflow

```
# Developer creates PR
/gtw on ~/code/project
/gtw new "Add OAuth login" "..."
/gtw fix feature/123
  -> coding...
/gtw push
/gtw confirm "feat: add oauth"
  -> creates issue + GitHub branch + PR with ghw/ready

# Agent reviews
/gtw auto add owner/project   # one-time pool setup
/gtw review
  -> ghw/wip Claimed PR #45 with diff
  -> agent reviews
/gtw review #45 lgtm
  -> ghw/lgtm applied
```

## Session File

```
~/.openclaw/gtw/
├── config.json   # automation pool repos + lastRepo
├── token.json    # GitHub OAuth token
└── wip.json      # session context (workdir, repo, issue/branch/pr drafts)
```
