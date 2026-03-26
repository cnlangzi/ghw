---
name: github-work
description: GitHub team workflow skill. Manage issues, branches, PRs, and team review via GitHub API. Usage: /skill github-work <subcommand> or /ghw <subcommand>.
metadata: {"openclaw":{"user-invocable":true,"emoji":"🔧"}}
---

# github-work

GitHub 团队协作工作流 skill。通过 GitHub OAuth Device Flow 或 Personal Access Token 认证，所有操作走 GitHub REST API。

## 调用方式

```
/skill github-work <subcommand> [args]
```

或简写（如果 slash command 可用）：
```
/ghw <subcommand> [args]
```

## 快速配置

**最少需要两个环境变量**：

1. `GITHUB_ACCESS_TOKEN` — GitHub Personal Access Token（推荐，简单直接）
2. `GITHUB_REPO` — 目标仓库，格式 `owner/repo`

**可选**：
- `GITHUB_DEFAULT_OWNER` — 你的 GitHub username（用于 Issue/PR 的默认 Owner）
- `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` — 用于 OAuth Device Flow（不需要 PAT 时）
- `GHW_APPROVAL_COUNT` — Merge 前需要的最少 approval 数量（默认 1）
- `GHW_REVIEW_TIMEOUT_HOURS` — Review 抢领后超时释放时间（默认 24 小时）

在 `~/.openclaw/openclaw.json` 的 `skills.entries.github-work.env` 中配置。

---

## Subcommands 详解

### 认证

```
/skill github-work auth
```
启动 GitHub OAuth Device Flow 认证流程（需要 `GITHUB_CLIENT_ID` 和 `GITHUB_CLIENT_SECRET`）。

**推荐方式**：直接设置 `GITHUB_ACCESS_TOKEN`（Personal Access Token，Settings → Developer settings → Personal access tokens → Generate new token，scope 选 `repo`）。

### Issue 管理

```
/skill github-work issue new <title>
    创建新 Issue，自动填充模板：
    - 需求描述
    - 功能范围（✅ 在范围内 / ❌ 不在范围内）
    - 验收标准（可勾选列表）
    - Owner

/skill github-work issue list [--state=open|closed|all]
    列出所有 Issue，支持 --assignee=username 过滤

/skill github-work issue show <issue-number>
    查看单个 Issue 详情

/skill github-work issue update <issue-number> [--title=TITLE] [--body=BODY] [--state=open|closed] [--assignee=username] [--label=label1,label2]
    更新 Issue
```

### Branch 管理

```
/skill github-work branch new <issue-number> [--name=branch-name]
    为指定 Issue 创建新分支：
    - 自动 fetch 最新 main 分支并以此为基准
    - 分支名格式：issue-{issue-number}-{short-title}
    - 自动在 Issue 上添加 branch label 关联

/skill github-work branch list [--repo=owner/repo]
    列出所有分支，🔒 表示受保护分支
```

**开发流程**：
1. `git fetch origin` 拉取最新
2. `git checkout -b issue-123-xxx origin/main` 创建分支
3. 开发完成后 push
4. 用 `/skill github-work pr new 123` 提交 PR

### Pull Request

```
/skill github-work pr new <issue-number> [--title=PR标题] [--body=PR描述]
    为指定 Issue 创建 PR，自动关联 Issue（Closes #123）

/skill github-work pr list [--state=open|closed|merged|all]
    列出 PR，支持按状态过滤

/skill github-work pr show <pr-url-or-number>
    查看 PR 详情（含 Review 状态汇总）

/skill github-work pr merge <pr-url-or-number>
    Merge PR（需满足最少 approval 数量）
```

**PR 描述模板**（自动生成）：
```
## 关联 Issue
Closes #123

## 做了什么
（请填写）

## 是否在范围内
- [ ] 是，完成了 Issue 要求的内容
- [ ] 否，有超出 Issue 范围的内容
```

### Review 流程（Emoji 协议）

```
/skill github-work review claim <pr-url-or-number>
    抢领 Review：给 PR 留言 "👀 Review claimed by @username"，阻止他人重复 Review

/skill github-work review done <pr-url-or-number>
    完成 Review：移除 👀 标记，留言 "✅ Review complete - approves" 或 "❌ Review complete - requests changes"
    同时提交 GitHub Official Review（APPROVED 或 CHANGES_REQUESTED）

/skill github-work review list
    列出所有待 Review PR，分两类：
    - Ready to Merge：已满足 approval 数量，可合入
    - Pending Review：尚未满足，还差 N 个 approval，或已有人抢领（👀）
```

**Emoji 协议**：
| Emoji | 含义 | 说明 |
|-------|------|------|
| 👀 | 有人正在 Review | 抢领标志，其他人看到则跳过 |
| ✅ | Review 完成，可 Merge | 正面结论 |
| ❌ | 需要修改，打回 | 负面结论 |
| 💬 | 有疑问或建议 | 非阻塞，纯粹沟通 |

**多轮 Review**：Reviewer打完 ❌ → Developer 修完 → 再次 `review claim` → 再次 `review done`。

### 定时轮询

```
/skill github-work poll
    手动触发一次轮询，返回：
    - 🆕 新 Issue（最近 24h）：通知 Owner 确认是否要做
    - 👀 待认领 PR（非自己提交的）：可立即 /skill github-work review claim
    - ✅ Merge Ready PR：通知 Owner 可执行 merge
```

---

## GitHub OAuth App 创建步骤（可选）

如果不用 PAT，想用 OAuth Device Flow：

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. 填写：
   - Application name: `github-work`（任意）
   - Homepage URL: `https://github.com`
   - Authorization callback URL: `http://localhost`
3. 创建后拿到 **Client ID** 和 **Client Secret**
4. 配置到 `skills.entries.github-work.env`

---

## Cron 配置（可选）

定时自动 poll。在 `~/.openclaw/openclaw.json` 的 `cron.entries` 中配置（已预置）：

```json
"ghw-poll": {
  "schedule": "*/15 * * * *",
  "task": "/skill github-work poll",
  "enabled": false
}
```

设置 `enabled: true` 开启。建议先手动测试 `/skill github-work poll` 确认配置正确后再开启。

---

## 实现说明

- **认证**：OAuth Device Flow（`https://github.com/login/device/code`）或 PAT
- **API**：GitHub REST API v3（`https://api.github.com`）
- **Token 存储**：`~/.openclaw/github-work/token.json`（0600 权限）
- **脚本路径**：`~/workspace/skills/github-work/index.js`
- **Node.js**：零外部依赖（仅用内置模块）
