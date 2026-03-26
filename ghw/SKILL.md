---
name: ghw
description: GitHub team workflow skill. Multi-repo support. Manage issues, branches, PRs, and team review via GitHub API.
metadata: {"openclaw":{"user-invocable":true,"emoji":"🔧"}}
---

# github-work

GitHub 团队协作工作流 skill，支持多仓库。多 repo 时命令默认作用于所有仓库，或用 `--repo owner/repo` 指定单个。

## 调用方式

```
/skill github-work <subcommand> [args]
```

## 快速配置

**最少需要**：
1. `GITHUB_ACCESS_TOKEN` — GitHub Personal Access Token（Settings → Developer settings → Personal access tokens → Generate → scope: `repo`）
2. `GHW_REPOS` — 仓库列表（逗号分隔或 JSON 数组）

```json
"skills": {
  "entries": {
    "github-work": {
      "env": {
        "GITHUB_ACCESS_TOKEN": "ghp_xxx",
        "GHW_REPOS": "owner/repo1,owner/repo2",
        "GITHUB_DEFAULT_OWNER": "your_username",
        "GHW_APPROVAL_COUNT": "1",
        "GHW_REVIEW_TIMEOUT_HOURS": "24"
      }
    }
  }
}
```

---

## Subcommands

### 认证
```
/skill github-work auth          # OAuth Device Flow（需要 CLIENT_ID + SECRET）
```

### Issue（多 repo）
```
/skill github-work issue new <title>                    # 在所有配置的 repo 创建 Issue
/skill github-work issue new <title> --repo owner/repo   # 在指定 repo 创建

/skill github-work issue list                            # 列出所有 repo 的 Issue
/skill github-work issue list --repo owner/repo          # 只查指定 repo
/skill github-work issue list --state=open               # open/closed/all

/skill github-work issue show <number> --repo owner/repo  # 查看指定 repo 的 Issue
/skill github-work issue update <number> [--state=closed] [--assignee=user] [--label=x,y]
```

### Branch（单 repo）
```
/skill github-work branch new <issue-number> --repo owner/repo
    为 Issue 创建分支（需指定 repo）：
    - 自动以 main 为基准
    - 分支名：issue-{issue-number}-{short-title}

/skill github-work branch list                            # 所有 repo
/skill github-work branch list --repo owner/repo          # 指定 repo
```

### Pull Request
```
/skill github-work pr new <issue-number> --repo owner/repo   # 创建 PR 并关联 Issue
/skill github-work pr list                                         # 所有 repo
/skill github-work pr list --repo owner/repo
/skill github-work pr show <pr-url-or-number>                     # 自动在配置的 repo 中查找
/skill github-work pr merge <pr-url-or-number>                    # 需满足 approval 数量
```

### Review（Emoji 协议）
```
/skill github-work review claim <pr-url-or-number>     # 👀 抢领
/skill github-work review done <pr-url-or-number>      # 去 👀 + ✅/❌
    /skill github-work review done <pr-url-or-number> approved    # ✅
    /skill github-work review done <pr-url-or-number> changes    # ❌

/skill github-work review list                         # 列出所有 repo 的 PR 状态
```

**Emoji 含义**：
- 👀 = 有人正在 Review（抢领，其他人跳过）
- ✅ = 可 Merge
- ❌ = 需修改，打回

### 轮询
```
/skill github-work poll                                 # 检查所有配置的 repo
/skill github-work poll --repo owner/repo              # 只查指定 repo

返回：
- 🆕 新 Issue（24h）
- 👀 待认领 PR（非自己提交的）
- ✅ 可 Merge 的 PR
```

### 配置
```
/skill github-work config                               # 查看当前配置状态
```

---

## 多 Repo 工作流

```
1. 配置 GHW_REPOS: "owner/repo1,owner/repo2"
2. /skill github-work issue new "登录功能" --repo owner/repo1
3. /skill github-work issue list                          # 查所有 repo
4. /skill github-work poll                                 # 扫所有 repo 的 PR 状态
```

**单 repo 指定**：`--repo owner/repo`
**不加 --repo**：作用于所有配置的 repo（适合 list/poll/new Issue）

---

## Cron 配置

```json
"cron": {
  "entries": {
    "ghw-poll": {
      "schedule": "*/15 * * * *",
      "task": "/skill github-work poll",
      "enabled": false
    }
  }
}
```

---

## 实现

- **Token**：PAT（`GITHUB_ACCESS_TOKEN`）或 OAuth Device Flow
- **多 Repo**：环境变量 `GHW_REPOS`（逗号分隔或 JSON 数组）
- **认证存储**：`~/.openclaw/github-work/token.json`（0600）
- **零外部依赖**
