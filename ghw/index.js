#!/usr/bin/env node
/**
 * github-work skill - GitHub Team Workflow Tool
 * Multi-repo support via --repo flag or GHW_REPOS env
 *
 * Commands:
 *   auth, issue, branch, pr, review, poll, config
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// --- Config paths ---
const CONFIG_DIR = path.join(os.homedir(), '.openclaw', 'github-work');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');

// Ensure config dir
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.chmodSync(CONFIG_DIR, '0700');
}

// --- Env ---
const CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN || '';
const DEFAULT_OWNER = process.env.GITHUB_DEFAULT_OWNER || '';
const APPROVAL_COUNT = parseInt(process.env.GHW_APPROVAL_COUNT || '1', 10);
const REVIEW_TIMEOUT_HOURS = parseInt(process.env.GHW_REVIEW_TIMEOUT_HOURS || '24', 10);

// Multi-repo support: comma-separated or JSON array
function getRepos() {
  const envRepos = process.env.GITHUB_REPOS || process.env.GITHUB_REPO || '';
  if (!envRepos) return [];
  try {
    // Try JSON array first
    const parsed = JSON.parse(envRepos);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {
    // Fall back to comma-separated
  }
  return envRepos.split(',').map(r => r.trim()).filter(Boolean);
}

const REPOS = getRepos();

// --- GitHub API helpers ---
function apiRequest(method, endpoint, token, body = null) {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com${endpoint}`;
    const urlObj = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-work-skill/1.0',
      },
    };
    if (bodyStr) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`GitHub API ${res.statusCode}: ${JSON.stringify(parsed)}`));
          }
        } catch (e) {
          reject(new Error(`Parse error (status ${res.statusCode}): ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- File helpers ---
function readJSON(file) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }
  catch (e) { return null; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  fs.chmodSync(file, '0600');
}

// --- Token ---
function getToken() {
  if (ACCESS_TOKEN) return ACCESS_TOKEN;
  const tokenData = readJSON(TOKEN_FILE);
  if (!tokenData || !tokenData.access_token) throw new Error('Not authenticated. Run /ghw auth or set GITHUB_ACCESS_TOKEN');
  return tokenData.access_token;
}
function saveToken(tokenData) { writeJSON(TOKEN_FILE, tokenData); }

// --- OAuth Device Flow ---
async function deviceFlow() {
  if (!CLIENT_ID) throw new Error('GITHUB_CLIENT_ID not configured in skills.entries.github-work.env');
  const codeResp = await postForm('https://github.com/login/device/code', {
    client_id: CLIENT_ID, scope: 'repo workflow',
  });
  if (!codeResp.device_code || !codeResp.user_code) throw new Error(`Device flow init failed: ${JSON.stringify(codeResp)}`);
  console.log(`\n🔗 Open: https://github.com/login/device\n   Enter code: ${codeResp.user_code}\n`);
  console.log('Waiting for auth...');
  let attempts = (codeResp.expires_in || 300) / (codeResp.interval || 5);
  while (attempts-- > 0) {
    await sleep((codeResp.interval || 5) * 1000);
    const tokenResp = await postForm('https://github.com/login/oauth/access_token', {
      client_id: CLIENT_ID, device_code: codeResp.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (tokenResp.access_token) {
      saveToken({ access_token: tokenResp.access_token, token_type: tokenResp.token_type, scope: tokenResp.scope });
      console.log('\n✅ Auth successful!');
      return readJSON(TOKEN_FILE);
    }
    if (tokenResp.error === 'authorization_pending') { process.stdout.write('.'); continue; }
    if (tokenResp.error === 'slow_down') { await sleep((codeResp.interval || 5) * 1000); continue; }
    throw new Error(`OAuth error: ${tokenResp.error || JSON.stringify(tokenResp)}`);
  }
  throw new Error('Auth timed out');
}

function postForm(urlStr, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const body = Object.entries(data).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const options = {
      hostname: urlObj.hostname, port: 443, path: urlObj.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'Accept': 'application/json', 'User-Agent': 'github-work-skill/1.0' },
    };
    const req = https.request(options, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// --- Repo resolution ---
// repos: [{owner, repo, name?}, ...]
// --repo owner/repo → single
// default → all configured REPOS
function resolveRepos(args) {
  const opts = parseArgs(args);
  const repoArg = opts.repo;
  if (repoArg) {
    const parts = repoArg.split('/');
    if (parts.length !== 2) throw new Error('Repo must be owner/repo format');
    return [{ owner: parts[0], repo: parts[1], name: repoArg }];
  }
  if (REPOS.length === 0) throw new Error('No repos configured. Set GHW_REPOS (comma-separated or JSON array) or pass --repo owner/repo');
  return REPOS.map(r => { const [owner, repo] = r.split('/'); return { owner, repo, name: r }; });
}

function parseRepoRef(ref) {
  // Accept: "123", "#123", "owner/repo#123", "https://github.com/owner/repo/pull/123"
  let owner, repo, num;
  if (ref.includes('github.com')) {
    const m = ref.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) throw new Error(`Invalid PR URL: ${ref}`);
    owner = m[1]; repo = m[2]; num = parseInt(m[3], 10);
  } else if (ref.includes('#')) {
    const [r, n] = ref.split('#'); [owner, repo] = r.split('/'); num = parseInt(n, 10);
  } else {
    num = parseInt(ref, 10);
  }
  if (isNaN(num)) throw new Error(`Invalid PR reference: ${ref}`);
  return { owner, repo, num };
}

// --- Issue ---
async function issueNew(args) {
  const token = getToken();
  const title = args.join(' ').trim();
  if (!title) throw new Error('Title required: /ghw issue new <title> [--repo owner/repo]');
  const repos = resolveRepos(args);
  const opts = parseArgs(args);
  const results = [];
  for (const { owner, repo } of repos) {
    const body = `## 需求描述\n\n（请填写）\n\n## 功能范围\n- ✅ 在范围内：\n- ❌ 不在范围内：\n\n## 验收标准\n- [ ] 标准1\n\n## Owner\n@${opts.owner || DEFAULT_OWNER}\n`;
    const data = await apiRequest('POST', `/repos/${owner}/${repo}/issues`, token, { title, body });
    results.push({ repo: `${owner}/${repo}`, number: data.number, url: data.html_url });
  }
  return { ok: true, results };
}

async function issueList(args) {
  const token = getToken();
  const opts = parseArgs(args);
  const repos = resolveRepos(args);
  const state = opts.state || 'open';
  const results = [];
  for (const { owner, repo, name } of repos) {
    const params = new URLSearchParams({ state, per_page: '30', direction: 'desc' });
    if (opts.assignee) params.set('assignee', opts.assignee);
    const data = await apiRequest('GET', `/repos/${owner}/${repo}/issues?${params}`, token);
    const issues = data.filter(i => !i.pull_request);
    results.push({ repo: name, issues });
  }
  let display = '';
  for (const { repo, issues } of results) {
    display += `\n## ${repo}\n`;
    if (!issues.length) { display += 'No issues\n'; continue; }
    issues.forEach(i => { display += `[#${i.number}] ${i.title} ${i.state === 'open' ? '🟢' : '🔴'}\n`; });
  }
  return { ok: true, results, display };
}

async function issueShow(args) {
  const token = getToken();
  const num = parseInt(args[0], 10);
  if (isNaN(num)) throw new Error('Issue number required: /ghw issue show <issue-number> [--repo owner/repo]');
  const repos = resolveRepos(args);
  if (repos.length > 1) throw new Error('Show requires a specific repo: --repo owner/repo');
  const { owner, repo } = repos[0];
  const data = await apiRequest('GET', `/repos/${owner}/${repo}/issues/${num}`, token);
  return { ok: true, issue: data, display: `#${data.number}: ${data.title}\n${data.body || ''}\n\nState: ${data.state}\nURL: ${data.html_url}` };
}

async function issueUpdate(args) {
  const token = getToken();
  const num = parseInt(args[0], 10);
  if (isNaN(num)) throw new Error('Issue number required: /ghw issue update <issue-number> [--repo owner/repo]');
  args.shift();
  const opts = parseArgs(args);
  const repos = resolveRepos(args);
  const updates = {};
  if (opts.title) updates.title = opts.title;
  if (opts.body) updates.body = opts.body;
  if (opts.state) updates.state = opts.state;
  if (opts.assignee) updates.assignee = opts.assignee;
  if (opts.label) updates.labels = opts.label.split(',');
  const results = [];
  for (const { owner, repo } of repos) {
    const data = await apiRequest('PATCH', `/repos/${owner}/${repo}/issues/${num}`, token, updates);
    results.push({ repo: `${owner}/${repo}`, url: data.html_url });
  }
  return { ok: true, results };
}

// --- Branch ---
async function branchNew(args) {
  const token = getToken();
  const issueNum = parseInt(args[0], 10);
  if (isNaN(issueNum)) throw new Error('Issue number required: /ghw branch new <issue-number> [--repo owner/repo]');
  const opts = parseArgs(args.slice(1));
  const repos = resolveRepos(args);
  if (repos.length > 1) throw new Error('Branch creation requires a specific repo: --repo owner/repo');
  const { owner, repo } = repos[0];
  const issue = await apiRequest('GET', `/repos/${owner}/${repo}/issues/${issueNum}`, token);
  const shortTitle = (issue.title || 'branch').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 40);
  const branchName = opts.name || `issue-${issueNum}-${shortTitle}`;
  const repoInfo = await apiRequest('GET', `/repos/${owner}/${repo}`, token);
  const baseBranch = repoInfo.default_branch || 'main';
  const refData = await apiRequest('GET', `/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`, token);
  await apiRequest('POST', `/repos/${owner}/${repo}/git/refs`, token, { ref: `refs/heads/${branchName}`, sha: refData.object.sha });
  try { await apiRequest('POST', `/repos/${owner}/${repo}/issues/${issueNum}/labels`, token, { labels: [`branch:${branchName}`] }); } catch (e) {}
  return { ok: true, branch: branchName, issue: `#${issueNum}`, base: baseBranch, repo: `${owner}/${repo}` };
}

async function branchList(args) {
  const token = getToken();
  const repos = resolveRepos(args);
  const results = [];
  for (const { owner, repo, name } of repos) {
    const data = await apiRequest('GET', `/repos/${owner}/${repo}/branches`, token);
    results.push({ repo: name, branches: data.map(b => ({ name: b.name, protected: b.protected })) });
  }
  let display = '';
  for (const { repo, branches } of results) {
    display += `\n## ${repo}\n`;
    branches.forEach(b => { display += `${b.name} ${b.protected ? '🔒' : ''}\n`; });
  }
  return { ok: true, results, display };
}

// --- PR ---
async function prNew(args) {
  const token = getToken();
  const issueNum = parseInt(args[0], 10);
  if (isNaN(issueNum)) throw new Error('Issue number required: /ghw pr new <issue-number> [--repo owner/repo]');
  args.shift();
  const opts = parseArgs(args);
  const repos = resolveRepos(args);
  if (repos.length > 1) throw new Error('PR creation requires a specific repo: --repo owner/repo');
  const { owner, repo } = repos[0];
  const issue = await apiRequest('GET', `/repos/${owner}/${repo}/issues/${issueNum}`, token);
  const repoInfo = await apiRequest('GET', `/repos/${owner}/${repo}`, token);
  const baseBranch = repoInfo.default_branch || 'main';
  const branchName = opts.branch || `issue-${issueNum}`;
  const title = opts.title || `Fix #${issueNum}: ${issue.title}`;
  const body = opts.body || `## 关联 Issue\nCloses #${issueNum}\n\n## 做了什么\n（请填写）\n\n## 是否在范围内\n- [ ] 是，完成了 Issue 要求的内容\n- [ ] 否，有超出 Issue 范围的内容\n\n---\n_Generated by github-work skill_\n`;
  const data = await apiRequest('POST', `/repos/${owner}/${repo}/pulls`, token, { title, body, head: branchName, base: baseBranch });
  return { ok: true, pr: data.number, url: data.html_url, state: data.state, repo: `${owner}/${repo}` };
}

async function prList(args) {
  const token = getToken();
  const opts = parseArgs(args);
  const repos = resolveRepos(args);
  const state = opts.state || 'open';
  const results = [];
  for (const { owner, repo, name } of repos) {
    const params = new URLSearchParams({ state, per_page: '30', sort: 'updated', direction: 'desc' });
    const data = await apiRequest('GET', `/repos/${owner}/${repo}/pulls?${params}`, token);
    results.push({ repo: name, prs: data.map(pr => ({ number: pr.number, title: pr.title, state: pr.state, url: pr.html_url, user: pr.user?.login })) });
  }
  let display = '';
  for (const { repo, prs } of results) {
    display += `\n## ${repo}\n`;
    if (!prs.length) { display += 'No PRs\n'; continue; }
    prs.forEach(pr => { display += `[#${pr.number}] ${pr.title} ${pr.state === 'open' ? '🟢' : '🔴'} by @${pr.user || 'unknown'}\n`; });
  }
  return { ok: true, results, display };
}

async function prShow(args) {
  const token = getToken();
  const prRef = args[0];
  const opts = parseArgs(args.slice(1));
  const repos = opts.repo ? resolveRepos(args) : REPOS.map(r => { const [o, re] = r.split('/'); return { owner: o, repo: re, name: r }; });
  // Try to find PR in configured repos
  let data, owner, repo, num;
  for (const r of repos) {
    try {
      const parsed = parseRepoRef(prRef);
      num = parsed.num || parseRepoRef(prRef + (prRef.includes('#') ? '' : '#1')).num;
      owner = r.owner; repo = r.repo; num = parseInt(prRef) || num;
      data = await apiRequest('GET', `/repos/${owner}/${repo}/pulls/${num}`, token);
      break;
    } catch (e) { continue; }
  }
  if (!data) { const p = parseRepoRef(prRef); owner = p.owner; repo = p.repo; num = p.num; data = await apiRequest('GET', `/repos/${owner}/${repo}/pulls/${num}`, token); }
  const reviews = await apiRequest('GET', `/repos/${owner}/${repo}/pulls/${num}/reviews`, token);
  const byUser = {};
  reviews.forEach(r => { if (r.user?.login) byUser[r.user.login] = r.state; });
  const reviewSummary = Object.entries(byUser).map(([u, s]) => `@${u}: ${s}`).join(', ') || 'No reviews';
  return { ok: true, pr: { number: data.number, title: data.title, state: data.state, body: data.body, url: data.html_url, user: data.user?.login },
    reviewSummary, display: `#${data.number}: ${data.title}\n${data.body || ''}\n\nState: ${data.state}\nReviews: ${reviewSummary}\nURL: ${data.html_url}` };
}

async function prMerge(args) {
  const token = getToken();
  const prRef = args[0];
  const { owner, repo, num } = parseRepoRef(prRef);
  const reviews = await apiRequest('GET', `/repos/${owner}/${repo}/pulls/${num}/reviews`, token);
  const approvals = reviews.filter(r => r.state === 'APPROVED').length;
  if (approvals < APPROVAL_COUNT) throw new Error(`Not enough approvals: ${approvals}/${APPROVAL_COUNT}`);
  const pr = await apiRequest('GET', `/repos/${owner}/${repo}/pulls/${num}`, token);
  if (pr.state !== 'open') throw new Error('PR is not open');
  const data = await apiRequest('PUT', `/repos/${owner}/${repo}/pulls/${num}/merge`, token, {
    commit_title: `Merge pull request #${num}`, commit_message: pr.title, merge_method: 'squash',
  });
  return { ok: true, merged: data.merged, message: data.message || `PR #${num} merged`, url: pr.html_url };
}

// --- Review ---
async function getMyLogin(token) { const me = await apiRequest('GET', '/user', token); return me.login; }

// Review checklist items - each must be checked [x] before reviewDone passes
// Review checklist items - all must be [x] before reviewDone passes
const REVIEW_ITEMS = [
  '功能是否符合 Issue 需求描述',
  '是否有超范围改动',
  '是否有遗漏内容',
];

// buildChecklist returns the checklist text for user to paste/update in comments
function buildChecklist() {
  const items = REVIEW_ITEMS.map(item => `  - [ ] ${item}`).join('\n');
  return `## Review Checklist\n\n请逐项检查，完成后标记 [x]：\n\n${items}\n\n---\n_💡 全部 [x] 后执行 /ghw review done_`;
}

// Scan all my comments for checklist items across the PR thread
function parseChecklistFromComments(comments, myLogin) {
  const myComments = comments.filter(c => c.user?.login === myLogin);
  const allItems = [];
  for (const c of myComments) {
    const lines = c.body.split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*-\s*\[([ x])\]\s*(.+)/);
      if (m) allItems.push({ checked: m[1] === 'x', text: m[2].trim(), commentId: c.id });
    }
  }
  return allItems;
}

async function reviewClaim(args) {
  const token = getToken();
  const prRef = args[0];
  const { owner, repo, num } = parseRepoRef(prRef);
  const myLogin = await getMyLogin(token);
  const comments = await apiRequest('GET', `/repos/${owner}/${repo}/issues/${num}/comments`, token);
  // Block if someone else already claimed
  const existingOther = comments.find(c => c.user?.login !== myLogin && c.body?.includes('👀'));
  if (existingOther) return { ok: true, claimed: false, message: `Already claimed by @${existingOther.user?.login}`, by: existingOther.user?.login };
  // Check if I already claimed
  const existingMine = comments.find(c => c.user?.login === myLogin && c.body?.includes('👀'));
  if (existingMine) return { ok: true, claimed: false, message: `You already claimed this PR`, by: myLogin, comment: existingMine.html_url };
  const comment = await apiRequest('POST', `/repos/${owner}/${repo}/issues/${num}/comments`, token, {
    body: `👀 **Review claimed** by @${myLogin}\n\n_Emoji: 👀 = in progress, ✅ = done, ❌ = needs changes_\n\n---\n${buildChecklist()}`,
  });
  return { ok: true, claimed: true, comment: comment.html_url, by: myLogin, checklist: buildChecklist() };
}

async function reviewDone(args) {
  const token = getToken();
  const verdict = args[1] || 'approved';
  const { owner, repo, num } = parseRepoRef(args[0]);
  const myLogin = await getMyLogin(token);
  const comments = await apiRequest('GET', `/repos/${owner}/${repo}/issues/${num}/comments`, token);
  // Find my claim comment with 👀
  const myClaim = comments.find(c => c.user?.login === myLogin && c.body?.includes('👀'));
  if (!myClaim) throw new Error('No review claim found. Run /ghw review claim first');
  // Find all checklist items across my comments
  const items = parseChecklistFromComments(comments, myLogin);
  if (!items.length) throw new Error('No checklist items found in your comments');
  const unchecked = items.filter(i => !i.checked);
  if (unchecked.length > 0) {
    const list = unchecked.map(i => `  - [ ] ${i.text}`).join('\n');
    throw new Error(`Review incomplete. Items not checked:\n${list}\n\n请在 comment 中将 [ ] 改为 [x] 后再运行 review done`);
  }
  // Delete all my claim/comment threads
  const myComments = comments.filter(c => c.user?.login === myLogin);
  for (const c of myComments) {
    await apiRequest('DELETE', `/repos/${owner}/${repo}/issues/comments/${c.id}`, token);
  }
  const emoji = verdict === 'approved' ? '✅' : '❌';
  const reviewState = verdict === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED';
  const comment = await apiRequest('POST', `/repos/${owner}/${repo}/issues/${num}/comments`, token, {
    body: `${emoji} **Review complete** by @${myLogin} — ${verdict === 'approved' ? 'approves' : 'requests changes'}\n\n_Emoji: ✅ = can merge, ❌ = needs changes_`,
  });
  await apiRequest('POST', `/repos/${owner}/${repo}/pulls/${num}/reviews`, token, { body: `${emoji} ${verdict}`, event: reviewState });
  return { ok: true, verdict, comment: comment.html_url, by: myLogin, allChecked: true };
}


async function reviewList(args) {
  const token = getToken();
  const repos = resolveRepos(args);
  const myLogin = await getMyLogin(token);
  const pending = [], ready = [];
  for (const { owner, repo, name } of repos) {
    const params = new URLSearchParams({ state: 'open', per_page: '30', sort: 'updated', direction: 'desc' });
    const prs = await apiRequest('GET', `/repos/${owner}/${repo}/pulls?${params}`, token);
    for (const pr of prs) {
      const reviews = await apiRequest('GET', `/repos/${owner}/${repo}/pulls/${pr.number}/reviews`, token);
      const comments = await apiRequest('GET', `/repos/${owner}/${repo}/issues/${pr.number}/comments`, token);
      const approvals = reviews.filter(r => r.state === 'APPROVED').length;
      const claims = comments.filter(c => c.body?.includes('👀') && c.user?.login !== myLogin);
      if (approvals >= APPROVAL_COUNT) {
        ready.push({ number: pr.number, title: pr.title, url: pr.html_url, approvals, repo: name });
      } else {
        pending.push({ number: pr.number, title: pr.title, url: pr.html_url, approvals, needed: APPROVAL_COUNT - approvals, claimed: claims.length > 0, claimedBy: claims.map(c => c.user?.login), repo: name });
      }
    }
  }
  let display = '## Ready to Merge\n';
  ready.length ? ready.forEach(pr => { display += `[#${pr.number}] ${pr.title} ✅ (${pr.approvals}/${APPROVAL_COUNT}) [${pr.repo}]\n`; }) : (display += 'None\n');
  display += '\n## Pending Review\n';
  pending.length ? pending.forEach(pr => { display += `[#${pr.number}] ${pr.title} ${pr.claimed ? '👀 @'+pr.claimedBy.join(',@') : ''} (${pr.approvals}/${pr.needed} more) [${pr.repo}]\n`; }) : (display += 'None\n');
  return { ok: true, pending, ready, display };
}

// --- Poll ---
async function poll(args) {
  const token = getToken();
  const repos = resolveRepos(args);
  const myLogin = await getMyLogin(token);
  const results = { newIssues: [], claimedPRs: [], mergeReady: [] };
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  for (const { owner, repo, name } of repos) {
    const issues = await apiRequest('GET', `/repos/${owner}/${repo}/issues?since=${since}&state=open&per_page=20`, token);
    issues.filter(i => !i.pull_request).forEach(i => results.newIssues.push({ ...i, repo: name }));
    const prs = await apiRequest('GET', `/repos/${owner}/${repo}/pulls?state=open&per_page=30`, token);
    for (const pr of prs) {
      if (pr.user?.login === myLogin) continue;
      const reviews = await apiRequest('GET', `/repos/${owner}/${repo}/pulls/${pr.number}/reviews`, token);
      const comments = await apiRequest('GET', `/repos/${owner}/${repo}/issues/${pr.number}/comments`, token);
      const approvals = reviews.filter(r => r.state === 'APPROVED').length;
      const hasClaim = comments.some(c => c.body?.includes('👀') && c.user?.login !== myLogin);
      if (!hasClaim) results.claimedPRs.push({ number: pr.number, title: pr.title, url: pr.html_url, by: pr.user?.login, repo: name });
      if (approvals >= APPROVAL_COUNT) results.mergeReady.push({ number: pr.number, title: pr.title, url: pr.html_url, repo: name });
    }
  }
  let display = '## Poll Results\n';
  if (results.newIssues.length) { display += '\n🆕 New Issues (24h):\n'; results.newIssues.forEach(i => { display += `  [#${i.number}] ${i.title} [${i.repo}]\n`; }); }
  if (results.claimedPRs.length) { display += '\n👀 Unclaimed PRs:\n'; results.claimedPRs.forEach(pr => { display += `  [#${pr.number}] ${pr.title} by @${pr.by} [${pr.repo}]\n`; }); }
  if (results.mergeReady.length) { display += '\n✅ Merge Ready:\n'; results.mergeReady.forEach(pr => { display += `  [#${pr.number}] ${pr.title} [${pr.repo}]\n`; }); }
  if (!results.newIssues.length && !results.claimedPRs.length && !results.mergeReady.length) display += '\nNothing new.\n';
  return { ok: true, ...results, display };
}

// --- Config ---
async function configShow(args) {
  return {
    ok: true,
    repos: REPOS,
    configured: REPOS.length > 0,
    approvalCount: APPROVAL_COUNT,
    reviewTimeoutHours: REVIEW_TIMEOUT_HOURS,
    hasToken: !!(ACCESS_TOKEN || readJSON(TOKEN_FILE)?.access_token),
    display: `Repos: ${REPOS.length > 0 ? REPOS.join(', ') : '(none - set GHW_REPOS)'}\nApprovals needed: ${APPROVAL_COUNT}\nReview timeout: ${REVIEW_TIMEOUT_HOURS}h\nToken: ${ACCESS_TOKEN ? 'PAT configured' : readJSON(TOKEN_FILE)?.access_token ? 'OAuth token saved' : 'not configured'}`,
  };
}

// --- Utils ---
function parseArgs(args) {
  const opts = {};
  for (const arg of args) {
    const m = arg.match(/^--([a-zA-Z0-9-]+)(?:=(.+))?$/);
    if (m) { opts[m[1]] = m[2] !== undefined ? m[2] : true; }
    else { if (!opts._) opts._ = []; opts._.push(arg); }
  }
  return opts;
}

// --- Dispatch ---
async function main() {
  const input = process.argv[2] || '';
  const parts = input.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] || '';
  const args = parts.slice(1);
  let result;
  try {
    switch (sub) {
      case 'auth': result = await deviceFlow(); break;
      case 'issue':
        switch (args[0]) {
          case 'new': result = await issueNew(args.slice(1)); break;
          case 'list': result = await issueList(args.slice(1)); break;
          case 'show': result = await issueShow(args.slice(1)); break;
          case 'update': result = await issueUpdate(args.slice(1)); break;
          default: throw new Error('Unknown: issue new|list|show|update');
        }
        break;
      case 'branch':
        switch (args[0]) {
          case 'new': result = await branchNew(args.slice(1)); break;
          case 'list': result = await branchList(args.slice(1)); break;
          default: throw new Error('Unknown: branch new|list');
        }
        break;
      case 'pr':
        switch (args[0]) {
          case 'new': result = await prNew(args.slice(1)); break;
          case 'list': result = await prList(args.slice(1)); break;
          case 'show': result = await prShow(args.slice(1)); break;
          case 'merge': result = await prMerge(args.slice(1)); break;
          default: throw new Error('Unknown: pr new|list|show|merge');
        }
        break;
      case 'review':
        switch (args[0]) {
          case 'claim': result = await reviewClaim(args.slice(1)); break;
          case 'done': result = await reviewDone(args.slice(1)); break;
          case 'list': result = await reviewList(args.slice(1)); break;
          default: throw new Error('Unknown: review claim|done|list');
        }
        break;
      case 'poll': result = await poll(args); break;
      case 'config': result = await configShow(args); break;
      case 'whoami': result = { login: await getMyLogin(getToken()) }; break;
      default:
        throw new Error(`Unknown: ${sub}. Use: auth, issue, branch, pr, review, poll, config`);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

main();
