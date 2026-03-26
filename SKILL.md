---
name: gtw
description: gtw - Git Team Workflow automation with auto-driven PR review. Label-based state machine.
metadata: {"openclaw":{"user-invocable":true,"emoji":"🔧"}}
---

# gtw - Git Team Workflow

Session-based issue generation, git operations, and auto-driven PR review via CLI.

## Core Design

**Two-phase confirm pattern**: all write operations are drafts until `/gtw confirm`:
- `/gtw on` + `/gtw new/fix/pr` write drafts to `wip.json` (no API calls)
- `/gtw confirm` executes all pending actions at once, then clears

**Label-based review**: agents claim PRs via `ghw/wip`, verdict via `ghw/lgtm` or `ghw/revise`.

---

## Session Commands (write to wip.json)

```
/gtw on <workdir>
    Set workdir and repo in session context. Required first step.

/gtw new [title] [body]
    Create an issue draft in session context. No API call.

/gtw update #<id> [title]
    Update an existing issue draft in session context. No API call.

/gtw confirm
    Execute all pending actions from session:
    - issue (create/update)
    - GitHub branch ref (if branch.name + issue.id)
    - PR (if pr.title)
    Then clear session.
```

---

## Git Operations

```
/gtw fix [branch-name]
    Create local branch (fetch/rebase main + checkout -b).
    Writes branch to session. No push, no GitHub ref.

/gtw pr [title]
    Push branch to origin. Generate PR draft in session.
    No PR created on GitHub until /gtw confirm.

/gtw push
    git add -A, show diff. Writes to session.
    Use /gtw confirm to commit and push.
```

---

## Automation Pool

```
/gtw auto add <owner/repo>
    Add repo to automation pool. Creates ghw/* labels on first use.

/gtw auto remove <owner/repo>
    Remove repo from automation pool.

/gtw auto list
    List all repos in the automation pool.
```

---

## Auto-Driven Review

```
/gtw review
    Pick a repo (round-robin), find oldest ghw/ready PR, claim it
    (ghw/ready -> ghw/wip), return PR diff + linked issue for review.

/gtw review #<pr> lgtm|revise
    - lgtm  -> ghw/wip -> ghw/lgtm
    - revise -> ghw/wip -> ghw/revise
```

Review flow:
1. PR created with ghw/ready label
2. `/gtw review` -> agent claims ghw/wip, returns diff
3. Agent reviews diff + linked issue
4. `/gtw review #<pr> lgtm` or `revise` -> updates label only
5. Developer fixes -> re-adds ghw/ready -> loop

---

## Info

```
/gtw issue [owner/repo] [--state=open|closed|all]
    List open issues in repo. Uses session repo context if not provided.

/gtw show #<pr>
    Show PR/issue details. Uses session or review context.

/gtw config
    Show config status: token, session (wip.json), pool repos.
```

---

## Full Workflow

```
# Developer: create PR via session
/gtw on ~/code/project
/gtw new "Add OAuth login" "## Description\n..."
/gtw fix feature/123
  -> coding...
/gtw push
/gtw confirm "feat: add oauth login"
  -> commits and pushes (via push session)
  -> creates issue (via new session)
  -> creates GitHub branch + PR (via confirm)

# Agent: review via automation pool
/gtw auto add owner/project
/gtw review
  -> claims PR, returns diff
  -> agent reviews
/gtw review #45 lgtm
  -> ghw/lgtm label applied
```
