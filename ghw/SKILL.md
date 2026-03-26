---
name: ghw
description: github-work - GitHub team workflow skill. Multi-repo support. Manage issues, branches, PRs, and team review via GitHub API.
metadata: {"openclaw":{"user-invocable":true,"emoji":"🔧"}}
---

# github-work (ghw)

GitHub 团队协作工作流 skill，支持多仓库。

## 调用方式

```
/ghw <command> [args]
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

## 命令一览

### 认证
```
/ghw auth          # OAuth Device Flow（需 CLIENT_ID + SECRET）
```

### Issue
```
/ghw issue n <title>               # 创建 Issue（所有 repo）
/ghw issue n <title> -r owner/repo  # 创建 Issue（指定 repo）
/ghw issue ls                       # 列出 Issue（所有 repo）
/ghw issue ls -r owner/repo         # 列出 Issue（指定 repo）
/ghw issue ls -s open|closed|all    # 按状态过滤
/ghw issue s <number> -r owner/repo # 查看 Issue
/ghw issue u <number> [opts]        # 更新 Issue
```
**选项**：
- `-r, --repo owner/repo` — 指定仓库
- `-s, --state open|closed|all` — 状态过滤
- `-a, --assignee user` — 按负责人过滤
- `-l, --label x,y` — 按标签过滤

### Branch
```
/ghw branch n <issue-number> -r owner/repo   # 创建分支（需指定 repo）
/ghw branch ls -r owner/repo                   # 列出分支
```

### Pull Request
```
/ghw pr n <issue-number> -r owner/repo   # 创建 PR（需指定 repo）
/ghw pr ls                                 # 列出 PR（所有 repo）
/ghw pr ls -r owner/repo                   # 列出 PR（指定 repo）
/ghw pr ls -s open|closed|merged|all       # 按状态过滤
/ghw pr s <pr-ref>                         # 查看 PR（自动查找）
/ghw pr m <pr-ref>                         # Merge PR
```

### Review（两步流程 + Checklist）

```
/ghw review c <pr-ref>      # 认领 Review，留 👀 + 清单
/ghw review d <pr-ref>      # 完成 Review（验证清单全部 [x]）
/ghw review ls              # 列出所有待 Review PR
```

**Review 流程**：
1. `review c` → 领取 PR，留 👀 + 清单模板
2. 人工逐项检查，在 comment 中将 `[ ]` 改为 `[x]`
3. 全部 [x] 后 → `review d` → 通过

**选项**：
- `review d <pr-ref> approved` → ✅ 通过
- `review d <pr-ref> changes` → ❌ 打回

**Review 清单**：
```
## Review Checklist
- [ ] 功能是否符合 Issue 需求描述
- [ ] 是否有超范围改动
- [ ] 是否有遗漏内容
```

### 轮询
```
/ghw poll                  # 检查所有 repo
/ghw poll -r owner/repo    # 只查指定 repo
```

### 配置
```
/ghw config    # 查看当前配置状态
```

---

## 全局选项

| 短 | 长 | 说明 |
|----|----|------|
| `-r` | `--repo owner/repo` | 指定仓库 |
| `-s` | `--state` | 状态过滤 |
| `-a` | `--assignee` | 负责人 |
| `-l` | `--label` | 标签 |

---

## 速查表

| 命令 | 简写 |
|------|------|
| `issue new` | `issue n` |
| `issue list` | `issue ls` |
| `issue show` | `issue s` |
| `issue update` | `issue u` |
| `branch new` | `branch n` |
| `branch list` | `branch ls` |
| `pr new` | `pr n` |
| `pr list` | `pr ls` |
| `pr show` | `pr s` |
| `pr merge` | `pr m` |
| `review claim` | `review c` |
| `review done` | `review d` |
| `review list` | `review ls` |

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
