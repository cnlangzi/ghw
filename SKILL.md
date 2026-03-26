---
name: ghw
description: ghw - GitHub team workflow automation with auto-driven PR review. Label-based state machine.
metadata: {"openclaw":{"user-invocable":true,"emoji":"🔧"}}
---

# ghw

GitHub team workflow automation. Auto-driven PR review with label-based state machine.

## Usage

```
/ghw <command> [args]
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

### Automation Pool

```
/ghw auto add <owner/repo>
    Add repo to automation pool. Creates ghw/* labels on first use.

/ghw auto remove <owner/repo>
    Remove repo from automation pool.

/ghw auto list
    List all repos in the automation pool.
```

### Review

```
/ghw review
    Pick a repo from the automation pool (round-robin), find the oldest
    ghw/ready PR, claim it (replace ghw/ready -> ghw/wip), return PR
    details and diff for agent review.

/ghw review #<pr> approved|revise
    Submit review verdict on the PR:
    - approved  -> ghw/wip -> ghw/lgtm, submit APPROVED review
    - revise    -> ghw/wip -> ghw/revise, submit CHANGES_REQUESTED review
```

Review flow:
1. ghw/ready PR created by developer
2. /ghw review -> agent picks it up, sets ghw/wip
3. Agent reviews diff + linked issue
4. /ghw review #<pr> approved|revise -> updates label + submits review
5. Developer fixes -> re-adds ghw/ready -> loop

### Git Operations

```
/ghw fix <workdir> [branch-name]
    Fetch/rebase main, create new branch. Returns branch name.

/ghw pr <workdir> [title]
    Push branch, create PR with ghw/ready label, link to issue if branch
    name contains issue number (e.g. fix/123).

/ghw push <workdir>
    git add -A, show diff summary. Use /ghw confirm to commit and push.

/ghw confirm <workdir> [commit-msg]
    Commit staged changes and push.
```

### Info

```
/ghw issue <owner/repo> [--state=open|closed|all]
    List open issues in a repo.

/ghw show #<pr>
    Show PR/issue details and labels. Uses last-reviewed repo context.

/ghw config
    Show automation pool repos and token status.
```

---

## Implementation

- Entry: `scripts/index.js` (Node.js, no dependencies)
- Token: PAT or OAuth Device Flow
- Auto repos: `~/.openclaw/ghw/auto-repos.json`
- Labels: auto-created on first use
- Mutual exclusion: only one ghw/* label per PR
