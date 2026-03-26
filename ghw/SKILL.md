---
name: ghw
description: github-work - GitHub team workflow skill. Session-based workflow with LLM-assisted issue generation and git operations.
metadata: {"openclaw":{"user-invocable":true,"emoji":"🔧"}}
---

# github-work (ghw)

GitHub 团队协作工作流 skill。Session-based 设计：草稿写入 pending，确认后执行。

## 调用方式

```
/ghw <command> [args]
```

## 配置

```json
"skills": {
  "entries": {
    "ghw": {
      "env": {
        "GITHUB_ACCESS_TOKEN": "ghp_xxx",
        "GHW_REPOS": "owner/repo1,owner/repo2",
        "GHW_WORK_DIR": "/path/to/code",
        "GHW_APPROVAL_COUNT": "1"
      }
    }
  }
}
```

- `GHW_WORK_DIR`：本地代码根目录（默认 `~/code`）

---

## 命令体系

### 工作流命令

```
/ghw start <workdir>
```
从本地目录获取 git remote repo，写入 pending。
- `workdir` 可以是绝对路径或相对于 `GHW_WORK_DIR` 的路径

```
/ghw new
```
LLM 提炼聊天内容 → 生成 Issue 草稿（title + body）→ 写入 pending（不执行 GitHub 操作）

```
/ghw update #<id>
```
LLM 提炼聊天内容 → 更新 Issue #id 草稿 → 写入 pending

```
/ghw confirm
```
执行 pending 中所有操作：
- `issue.action == 'create'` → 创建 Issue
- `issue.action == 'update'` → 更新 Issue
- `branch.name` 有值 → 创建分支（关联 issue label）
- `pr.title` 有值 → 创建 PR（关联 issue）

执行后自动清空 pending。

---

### Git 操作

```
/ghw fix [name]
```
- `git fetch origin`
- `git checkout main`
- `git pull --rebase origin main`
- `git checkout -b <name>`（默认 `fix/<timestamp>`）
- 结果写入 pending.branch

```
/ghw pr
```
- `git push -u origin <branch>`
- 生成 PR title/body（关联 issue）
- 结果写入 pending.pr
- 需要先 `fix` 创建分支

```
/ghw push
```
- `git add -A`
- 展示 staged changes 摘要
- 等待 commit message（由 agent LLM 生成）
- `git commit` + `git push`

---

### Review

```
/ghw review
```
从 pending.repo 找最早未认领的 PR，立即 👀 claim → 写入 checklist → 返回待 review 状态

```
/ghw review d <pr-ref> [approved|changes]
```
完成 Review：
- 检查所有 checklist 项是否 [x]
- 未全部 [x] → 报错返回未完成项
- 全部 [x] → 删除 claim comment → 提交 ✅/❌ Review

---

### 信息查询

```
/ghw issue              # 列出 pending.repo 的 open Issue
/ghw show #<id>         # 查看 pending.repo 的 Issue #id
/ghw poll               # 轮询所有 repo（new issues / unclaimed PRs / merge-ready PRs）
/ghw config             # 查看当前配置和 pending 状态
```

---

## Pending 状态

文件：`~/.openclaw/github-work/pending.json`

```json
{
  "workdir": "/path/to/workdir",
  "repo": "owner/repo",
  "issue": { "action": "create|update", "id": null, "title": "", "body": "" },
  "branch": { "name": "" },
  "pr": { "title": "", "body": "" },
  "createdAt": "ISO"
}
```

---

## 标准流程示例

```
你: /ghw start ~/code/myproject
蛋妹: ✅ workdir set, repo: owner/repo

你: /ghw new
蛋妹: 根据聊天内容生成 Issue 草稿：
      Title: xxx
      Body: ...
      [pending，等待 /ghw confirm]
      确认吗？

你: y（继续讨论补充细节）

你: /ghw new（再次调用，内容已更新）
蛋妹: 更新草稿：[新 Title]
      [pending，等待 /ghw confirm]

你: /ghw fix login-bug
蛋妹: ✅ Branch fix/login-bug created (rebased on main)
      [pending，等待 /ghw confirm]

你: /ghw pr
蛋妹: ✅ Branch pushed. Run /ghw confirm

你: /ghw confirm
蛋妹: ✅ Issue #45 创建成功
      ✅ Branch created
      ✅ PR #78 创建成功
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
- **Git 操作**：直接调用本地 git
- **GitHub API**：REST API v3
- **存储**：`~/.openclaw/github-work/pending.json`（0600）
- **零外部依赖**
