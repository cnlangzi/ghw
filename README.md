# github-work

> GitHub team workflow automation - session-based issue generation, git operations, and PR review coordination via CLI.

`github-work` is a skill for [OpenClaw](https://github.com/openclaw/openclaw) that brings structured, LLM-assisted GitHub workflows to your chat interface. Define issues from conversations, manage branches and PRs with a two-phase confirm pattern, and coordinate reviews with an emoji protocol.

## Features

- **Session-based workflow** - Draft in `wip.json`, confirm when ready. No accidental API calls.
- **LLM-assisted issue creation** - `/ghw new` reads the conversation and generates a properly structured issue. No copy-paste.
- **Git operations** - `fix`, `push`, and `pr` commands wrap standard git workflows with semantic commit log generation.
- **Emoji review protocol** - eyes claim -> checklist -> approved/changes verdict. No concurrent reviews, no confusion.
- **Multi-repo support** - Configure once, work across all your repos.
- **Zero external dependencies** - Plain Node.js, no npm packages needed.

## Installation

### 1. Clone the repo

```bash
git clone https://github.com/cnlangzi/ghw.git
cd ghw
```

### 2. Install the skill

Copy or symlink the skill to your OpenClaw workspace:

```bash
cp -r . ~/workspace/skills/github-work/
```

Or use the OpenClaw CLI:

```bash
openclaw skills install ./ghw
```

### 3. Configure credentials

Add to `~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "entries": {
      "ghw": {
        "enabled": true,
        "env": {
          "GITHUB_ACCESS_TOKEN": "ghp_your_personal_access_token",
          "GHW_APPROVAL_COUNT": "1"
        }
      }
    }
  }
}
```

#### Getting a GitHub Personal Access Token

1. Go to **GitHub -> Settings -> Developer settings -> Personal access tokens -> Generate new token (classic)**
2. Grant the `repo` scope
3. Copy the token and paste into `GITHUB_ACCESS_TOKEN`

#### Configuring repos

Comma-separated list or JSON array:

```bash
# or
```

### 4. Authenticate (optional, for OAuth Device Flow)

If you prefer OAuth instead of PAT:

1. Create a GitHub OAuth App: **Settings -> Developer settings -> OAuth Apps -> New OAuth App**
   - Callback URL: `http://localhost`
2. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in the skill env
3. Run `/ghw auth` to initiate the OAuth flow

---

## Commands

All commands are invoked via `/ghw <command>` in your OpenClaw chat interface.

### Workflow Setup

```bash
/ghw start <workdir>
```
Resolves the git remote from a local directory and writes it to `wip.json`. All subsequent commands use this repo.

```bash
# Examples
/ghw start ~/code/myproject
/ghw start /absolute/path/to/repo
```

---

### Issue Management

```bash
/ghw new
```
Reads the conversation history, uses LLM to extract and structure a GitHub issue (title + body), and writes it to `wip.json`. **No GitHub API call is made.**

```bash
/ghw update #<id>
```
LLM re-reads the conversation to update Issue `#<id>`'s draft in `wip.json`.

```bash
/ghw confirm
```
Executes all pending operations in `wip.json`:
- `issue.action == 'create'` -> creates a new GitHub Issue
- `issue.action == 'update'` -> updates Issue `#<id>`
- `branch.name` is set -> creates a GitHub branch and links it to the issue
- `pr.title` is set -> creates a Pull Request linked to the issue

After execution, `wip.json` is cleared.

```bash
/ghw issue
```
Lists all open issues in the current repo (from `wip.json`).

```bash
/ghw show #<id>
```
Shows full details of Issue `#<id>`.

---

### Git Operations

```bash
/ghw fix [name]
```
Performs a clean branch workflow:
1. `git fetch origin`
2. `git checkout main`
3. `git pull --rebase origin main`
4. `git checkout -b <name>` (default: `fix/<timestamp>`)

Result is written to `wip.json` as the pending branch.

```bash
/ghw pr
```
1. Pushes the current branch to origin
2. Generates a PR title and body linked to the associated issue
3. Writes to `wip.json` - execute with `/ghw confirm`

```bash
/ghw push
```
1. `git add -A`
2. Shows staged changes summary
3. LLM generates a [Conventional Commits](https://www.conventionalcommits.org/) formatted commit message
4. `git commit && git push`

---

### Code Review

```bash
/ghw review
```
From `wip.json`'s repo, finds the earliest unclaimed open PR and immediately:
1. Posts a eyes claim comment (prevents other reviewers from picking it up)
2. Attaches a review checklist
3. Returns the PR for manual review

**Review Checklist** (written to the PR comment):
```
## Review Checklist

Check each item. Mark [x] when verified:

  - [ ] Does the implementation match the Issue requirements?
  - [ ] Are there any out-of-scope changes?
  - [ ] Are there any missing pieces?

---
_Run /ghw review d after all items are [x]_
```

During review, manually update `[ ]` -> `[x]` in the comment as you verify each item.

```bash
/ghw review d <pr-ref> [approved|changes]
```
Completes the review:
- If not all checklist items are `[x]` -> error listing unchecked items
- If all checked -> deletes the claim comment, posts approved/changes verdict, submits the GitHub Official Review

```bash
# Examples
/ghw review d #45 approved       # Approves PR #45
/ghw review d owner/repo#78 changes  # Requests changes on PR #78 in owner/repo
```

---

### Utilities

```bash
/ghw poll
```
Scans all configured repos for:
- New issues (last 24h)
- Unclaimed PRs (not reviewed yet)
- Merge-ready PRs (approved, waiting for merge)

```bash
/ghw config
```
Shows current configuration, token status, and `wip.json` contents.

---

## Workflow Example

```
You: /ghw start ~/code/myproject
Agent: workdir set, repo: cnlangzi/myproject

You: /ghw new
Agent: Based on the conversation, here's the issue draft:
       Title: Add OAuth login support
       Body:  ## Description ...
              ## Scope ...
              ## Acceptance Criteria ...
       [Written to wip.json - run /ghw confirm]

You: /ghw fix login-oauth
Agent: Branch fix/login-oauth created (rebased on main)
       [Written to wip.json - run /ghw confirm]

You: /ghw pr
Agent: Branch pushed. Run /ghw confirm to create PR

You: /ghw confirm
Agent: Issue #45 created
       Branch created
       PR #78 created
       [wip.json cleared]

# --- Later, another developer picks up the PR review ---
You: /ghw review
Agent: eyes Claimed PR #78: Add OAuth login support
       Review the code, check the [ ] items, then /ghw review d #78
```

---

## Architecture

```
~/.openclaw/github-work/
├── wip.json      # Work In Progress draft state
├── token.json    # OAuth access token (0600)
└── state.json    # Optional persistent state
```

### `wip.json` schema

```json
{
  "workdir": "/home/user/code/myproject",
  "repo": "cnlangzi/myproject",
  "issue": {
    "action": "create | update",
    "id": null,
    "title": "Issue title",
    "body": "Issue body (markdown)"
  },
  "branch": {
    "name": "fix/login-oauth"
  },
  "pr": {
    "title": "PR title",
    "body": "PR body"
  },
  "createdAt": "2026-03-26T00:00:00.000Z"
}
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_ACCESS_TOKEN` | Yes | - | GitHub Personal Access Token |
| `GHW_APPROVAL_COUNT` | No | `1` | Minimum approvals before merge |
| `GHW_REVIEW_TIMEOUT_HOURS` | No | `24` | Review claim auto-release timeout |
| `GITHUB_CLIENT_ID` | No | - | For OAuth Device Flow (instead of PAT) |
| `GITHUB_CLIENT_SECRET` | No | - | For OAuth Device Flow |

---

## Contributing

Contributions are welcome. Please read the workflow design before making significant changes.

### Commit Message Format

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

---

## License

MIT
