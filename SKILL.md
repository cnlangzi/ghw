---
name: gtw
description: gtw - Git Team Workflow automation with auto-driven PR review. Label-based state machine.
metadata: {"openclaw":{"user-invocable":true,"emoji":"🔧"}}
---

# ghw

Git Team Workflow automation. Auto-driven PR review with label-based state machine.

## Usage

```
/gtw <command> [args]
```

## Configuration

```json
"skills": {
  "entries": {
    "ghw": {
      "env": {
        "GITHUB_ACCESS_TOKEN": "ghp_xxx"
      }
    }
  }
}
```

## Label System

PR state is tracked via mutually exclusive `ghw/*` labels:

| Label | Meaning |
|-------|---------|
| `ghw/ready` | PR created, waiting for review |
| `ghw/wip` | Review in progress |
| `ghw/lgtm` | Approved |
| `ghw/revise` | Changes requested |

Only one `ghw/*` label can exist on a PR at a time.

---

## Commands

### Session Context

All git operations share the same workdir/repo context once set.

```
/gtw on <workdir>
    Set workdir and repo in session context (wip.json).

/gtw new [title] [body]
    Create an issue draft in session context.

/gtw update #<id> [title]
    Update an existing issue draft in session context.

/gtw confirm
    Execute all pending actions (create/update issue, create PR, etc.)
    stored in session context, then clear.
```

### Automation Pool

```
/gtw auto add <owner/repo>
    Add repo to automation pool. Creates ghw/* labels on first use.

/gtw auto remove <owner/repo>
    Remove repo from automation pool.

/gtw auto list
    List all repos in the automation pool.
```

### Review

```
/gtw review
    Pick a repo from the automation pool (round-robin), find the oldest
    ghw/ready PR, claim it (replace ghw/ready -> ghw/wip), return PR
    details and diff for agent review.

/gtw review #<pr> lgtm|revise
    Submit review verdict on the PR:
    - lgtm   -> ghw/wip -> ghw/lgtm
    - revise -> ghw/wip -> ghw/revise
```

Review flow:
1. ghw/ready PR created by developer
2. /gtw review -> agent picks it up, sets ghw/wip
3. Agent reviews diff + linked issue
4. /gtw review #<pr> lgtm|revise -> updates label only
5. Developer fixes -> re-adds ghw/ready -> loop

### Git Operations

```
/gtw fix [branch-name]
    Fetch/rebase main, create new branch. Uses session workdir from /gtw on.

/gtw pr [title]
    Push branch, create PR with ghw/ready label, link to issue if branch
    name contains issue number (e.g. fix/123).

/gtw push
    git add -A, show diff summary. Uses session workdir from /gtw on.

/gtw confirm [commit-msg]
    Commit staged changes and push.
```

### Info

```
/gtw issue <owner/repo> [--state=open|closed|all]
    List open issues in a repo.

/gtw show #<pr>
    Show PR/issue details and labels. Uses last-reviewed repo context.

/gtw config
    Show automation pool repos and token status.
```

---

## Implementation

- Entry: `scripts/index.js` (Node.js, no dependencies)
- Token: PAT or OAuth Device Flow
- Auto repos: `~/.openclaw/ghw/config.json`
- Labels: auto-created on first use
- Mutual exclusion: only one ghw/* label per PR
