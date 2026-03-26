---
name: ghw
description: github-work - GitHub team workflow skill. Multi-repo support. Manage issues, branches, PRs, and team review via GitHub API.
metadata: {"openclaw":{"user-invocable":true,"emoji":"🔧"}}
---

# github-work (ghw)

GitHub 团队协作工作流 skill，支持多仓库。

## 调用方式

```
/ghw <subcommand> [args]
```

## 快速配置

**最少需要**：
1. `GITHUB_ACCESS_TOKEN` — GitHub Personal Access Token
2. `GHW_REPOS` — 仓库列表（逗号分隔或 JSON 数组）

配置在 `~/.openclaw/openclaw.json` → `skills.entries.ghw.env`：

```json
"ghw": {
  "enabled": true,
  "env": {
    "GITHUB_ACCESS_TOKEN": "ghp_xxx",
    "GHW_REPOS": "owner/repo1,owner/repo2",
    "GITHUB_DEFAULT_OWNER": "your_username",
    "GHW_APPROVAL_COUNT": "1",
    "GHW_REVIEW_TIMEOUT_HOURS": "24"
  }
}
```

---

## Subcommands

### 认证
```
/ghw auth          # OAuth Device Flow（需 CLIENT_ID + SECRET）
```

### Issue
```
/ghw issue new <title>                       # 所有 repo
/ghw issue new <title> --repo owner/repo     # 指定 repo
/ghw issue list                              # 所有 repo
/ghw issue list --repo owner/repo
/ghw issue list --state=open|closed|all
/ghw issue show <number> --repo owner/repo
/ghw issue update <number> [--title=] [--body=] [--state=open|closed] [--assignee=user] [--label=x,y]
```

### Branch（需指定 repo）
```
/ghw branch new <issue-number> --repo owner/repo
/ghw branch list --repo owner/repo
```

### Pull Request
```
/ghw pr new <issue-number> --repo owner/repo
/ghw pr list
/ghw pr list --repo owner/repo
/ghw pr show <pr-url-or-number>
/ghw pr merge <pr-url-or-number>       # 需满足最少 approval 数量
```

### Review（Emoji + Checklist 协议）

```
/ghw review claim <pr-url-or-number>
    留下 👀 + 审查清单，逐项检查后标记 [x]：
    - [ ] 功能是否符合 Issue 需求描述
    - [ ] 是否有超范围改动
    - [ ] 是否有遗漏内容

/ghw review done <pr-url-or-number> [approved|changes]
    检查清单是否全部 [x]，通过则：
    - 删除清单 comment
    - 留下 ✅ / ❌ 结论 comment
    - 提交 GitHub Official Review

/ghw review list
    列出所有待 Review PR（👀 已认领 / 待认领）
```

**流程说明**：
1. `review claim` → 领取 PR，留下审查清单
2. 对照清单逐项检查，在 comment 中把 `[ ]` 改成 `[x]`
3. 全部 [x] 后 → `review done` → 通过
4. 有问题 → 留言具体修改意见，不用 `review done`，等 Developer 修完再重新 `review claim`

**Emoji 含义**：
- 👀 = 有人正在 Review（认领标志）
- ✅ = 可 Merge
- ❌ = 需修改，打回

### 轮询
```
/ghw poll                    # 检查所有配置的 repo
/ghw poll --repo owner/repo  # 只查指定 repo

返回：
- 🆕 新 Issue（24h）
- 👀 待认领 PR
- ✅ 可 Merge 的 PR
```

### 配置
```
/ghw config    # 查看当前配置状态
```

---

## 多 Repo

```
/ghw issue list                  # 查所有 repo
/ghw issue list --repo owner/repo1  # 只查 repo1
/ghw poll                         # 扫所有 repo
```

---

## Cron 配置

```json
"cron": {
  "entries": {
    "ghw-poll": {
      "schedule": "*/15 * * * *",
      "task": "/ghw poll",
      "enabled": false
    }
  }
}
```

---

## 实现

- **Token**：PAT 或 OAuth Device Flow
- **多 Repo**：`GHW_REPOS`（逗号分隔或 JSON 数组）
- **存储**：`~/.openclaw/github-work/token.json`（0600）
- **零外部依赖**
