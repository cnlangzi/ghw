#!/usr/bin/env node
/**
 * github-work skill - GitHub Team Workflow
 * Commands: start, new, update, confirm, fix, pr, push, review, issue, show, poll, config, pending
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, exec } = require('child_process');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.openclaw', 'github-work');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
const wip_FILE = path.join(CONFIG_DIR, 'wip.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');

// Ensure config dir
[CONFIG_DIR].forEach(d => { if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); fs.chmodSync(d, '0700'); } });

// --- Env ---
const CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN || '';

// --- GitHub API ---
function apiRequest(method, endpoint, token, body = null) {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com${endpoint}`;
    const urlObj = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: urlObj.hostname, port: 443, path: urlObj.pathname + urlObj.search, method,
      headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'github-work-skill/1.0' },
    };
    if (bodyStr) { options.headers['Content-Type'] = 'application/json'; options.headers['Content-Length'] = Buffer.byteLength(bodyStr); }
    const req = https.request(options, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`GitHub API ${res.statusCode}: ${JSON.stringify(parsed)}`));
        } catch (e) { reject(new Error(`Parse error (${res.statusCode}): ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- File helpers ---
function readJSON(file) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch (e) { return null; } }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); fs.chmodSync(file, '0600'); }

// --- Token ---
function getToken() {
  if (ACCESS_TOKEN) return ACCESS_TOKEN;
  const t = readJSON(TOKEN_FILE);
  if (!t?.access_token) throw new Error('Not authenticated. Run /ghw auth or set GITHUB_ACCESS_TOKEN');
  return t.access_token;
}
function saveToken(t) { writeJSON(TOKEN_FILE, t); }

// --- OAuth ---
async function deviceFlow() {
  if (!CLIENT_ID) throw new Error('GITHUB_CLIENT_ID not configured');
  const codeResp = await postForm('https://github.com/login/device/code', { client_id: CLIENT_ID, scope: 'repo workflow' });
  if (!codeResp.device_code) throw new Error(`Device flow failed: ${JSON.stringify(codeResp)}`);
  console.log(`\n🔗 Open: https://github.com/login/device\n   Enter code: ${codeResp.user_code}\nWaiting...`);
  let attempts = (codeResp.expires_in || 300) / (codeResp.interval || 5);
  while (attempts-- > 0) {
    await sleep((codeResp.interval || 5) * 1000);
    const r = await postForm('https://github.com/login/oauth/access_token', { client_id: CLIENT_ID, device_code: codeResp.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (r.access_token) { saveToken({ access_token: r.access_token }); console.log('✅ Auth successful!'); return readJSON(TOKEN_FILE); }
    if (r.error === 'authorization_pending') { process.stdout.write('.'); continue; }
    if (r.error === 'slow_down') { await sleep((codeResp.interval || 5) * 1000); continue; }
    throw new Error(`OAuth error: ${r.error}`);
  }
  throw new Error('Auth timed out');
}

function postForm(urlStr, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const body = Object.entries(data).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const options = { hostname: urlObj.hostname, port: 443, path: urlObj.pathname, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'Accept': 'application/json', 'User-Agent': 'github-work-skill/1.0' } };
    const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

// --- Pending state ---
function getWip() { const p = readJSON(wip_FILE); return p || {}; }
function saveWip(p) { writeJSON(wip_FILE, p); }
function clearWip() { if (fs.existsSync(wip_FILE)) fs.unlinkSync(wip_FILE); }

// --- Git helpers ---
function git(cmd, cwd) {
  try { return execSync(cmd, { cwd: cwd || process.cwd(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (e) { throw new Error(`Git error: ${e.message}`); }
}

function getRemoteRepo(workdir) {
  const remotes = git('git remote -v', workdir).split('\n');
  const match = remotes.find(l => l.includes('origin') && (l.includes('github.com') || l.includes('git@')));
  if (!match) throw new Error('No origin remote found in ' + workdir);
  // git@github.com:owner/repo.git or https://github.com/owner/repo.git
  const m = match.match(/git@github\.com:([^/]+\/[^.]+)\.git/) || match.match(/https:\/\/github\.com\/([^/]+\/[^/]+)/);
  if (!m) throw new Error(`Cannot parse remote URL: ${match}`);
  return m[1];
}

function getCurrentBranch(cwd) {
  return git('git branch --show-current', cwd);
}

function getDefaultBranch(cwd) {
  const remote = git('git remote get-url origin', cwd);
  // Try git symbolic-ref first
  try { return execSync('git symbolic-ref refs/remotes/origin/HEAD', { encoding: 'utf8' }).trim().split('/').pop(); } catch(e) {}
  return 'main';
}

// --- Review checklist ---
const REVIEW_ITEMS = [
  'Does the implementation match the Issue requirements?',
  'Are there any out-of-scope changes?',
  'Are there any missing pieces?',
];

function buildChecklist() {
  return '## Review Checklist\n\nCheck each item. Mark [x] when verified:\n\n' + REVIEW_ITEMS.map(i => `  - [ ] ${i}`).join('\n') + '\n\n---\n_💡 Run /ghw review d after all items are [x]_';
}

function parseChecklist(comments, login) {
  const mine = comments.filter(c => c.user?.login === login);
  const items = [];
  for (const c of mine) {
    for (const line of c.body.split('\n')) {
      const m = line.match(/^\s*-\s*\[([ x])\]\s*(.+)/);
      if (m) items.push({ checked: m[1] === 'x', text: m[2].trim() });
    }
  }
  return items;
}

// --- Commands ---

async function cmdStart(args) {
  const workdir = args[0];
  if (!workdir) throw new Error('Usage: /ghw start <workdir>');
  // Expand ~ to home directory
  const expandedWorkdir = workdir.startsWith('~') ? path.join(os.homedir(), workdir.slice(1)) : workdir;
  const absWorkdir = path.isAbsolute(expandedWorkdir) ? expandedWorkdir : path.join(process.cwd(), expandedWorkdir);
  if (!path.isAbsolute(absWorkdir)) throw new Error('Please use an absolute path, e.g. /Users/name/code/myproject or ~/code/myproject');
  if (!fs.existsSync(absWorkdir)) throw new Error(`Directory not found: ${absWorkdir}`);
  const repo = getRemoteRepo(absWorkdir);
  const wip = { workdir: absWorkdir, repo, createdAt: new Date().toISOString() };
  saveWip(wip);
  return { ok: true, workdir: absWorkdir, repo, message: `Workdir set to ${absWorkdir}, repo: ${repo}` };
}

async function cmdNew(args) {
  // args: [title, body] or empty (agent will fill)
  const wip = getWip();
  if (!wip.repo) throw new Error('No repo set. Run /ghw start <workdir> first');
  const title = args[0] || '';
  const body = args.slice(1).join(' ') || '';
  const updated = { ...wip, issue: { action: 'create', id: null, title, body }, updatedAt: new Date().toISOString() };
  saveWip(updated);
  return { ok: true, wip: updated, message: title ? `Issue draft saved: "${title}"` : 'Issue draft saved (title/body will be filled by agent)' };
}

async function cmdUpdate(args) {
  // args: [#id, title, body]
  const id = parseInt(args[0], 10);
  if (isNaN(id)) throw new Error('Usage: /ghw update #<id> [title] [body...]');
  const wip = getWip();
  if (!wip.repo) throw new Error('No repo set. Run /ghw start <workdir> first');
  const title = args.slice(1).filter((_,i) => i % 2 === 0).join(' ') || '';
  const body = args.slice(2).filter((_,i) => i % 2 === 1).join(' ') || '';
  const updated = { ...wip, issue: { action: 'update', id, title, body }, updatedAt: new Date().toISOString() };
  saveWip(updated);
  return { ok: true, wip: updated, message: `Issue #${id} update draft saved` };
}

async function cmdConfirm(args) {
  const token = getToken();
  const wip = getWip();
  if (!wip.repo) throw new Error('No wip action. Run /ghw start + /ghw new first');
  const results = [];

  // Issue
  if (wip.issue?.title) {
    const { action, id, title, body } = wip.issue;
    if (action === 'create') {
      const data = await apiRequest('POST', `/repos/${wip.repo}/issues`, token, { title, body: body || `Created via github-work skill` });
      results.push({ type: 'issue', action: 'created', id: data.number, url: data.html_url });
    } else if (action === 'update' && id) {
      const data = await apiRequest('PATCH', `/repos/${wip.repo}/issues/${id}`, token, { title, body });
      results.push({ type: 'issue', action: 'updated', id, url: data.html_url });
    }
  }

  // Branch
  if (wip.branch?.name && wip.issue?.id) {
    const issueNum = wip.issue.id;
    const branchName = wip.branch.name;
    const workdir = wip.workdir;
    const [owner, repoName] = wip.repo.split('/');
    const shaResp = await apiRequest('GET', `/repos/${wip.repo}/git/ref/heads/${getDefaultBranch(workdir)}`, token);
    await apiRequest('POST', `/repos/${wip.repo}/git/refs`, token, { ref: `refs/heads/${branchName}`, sha: shaResp.object.sha });
    try { await apiRequest('POST', `/repos/${owner}/${repoName}/issues/${issueNum}/labels`, token, { labels: [`branch:${branchName}`] }); } catch(e) {}
    results.push({ type: 'branch', action: 'created', name: branchName });
  }

  // PR
  if (wip.pr?.title) {
    const workdir = wip.workdir;
    const baseBranch = getDefaultBranch(workdir);
    const headBranch = wip.branch?.name || getCurrentBranch(workdir);
    const body = wip.pr.body || `Closes #${wip.issue?.id || '?'}`;
    const data = await apiRequest('POST', `/repos/${wip.repo}/pulls`, token, { title: wip.pr.title, body, head: headBranch, base: baseBranch });
    results.push({ type: 'pr', action: 'created', id: data.number, url: data.html_url });
  }

  clearWip();
  return { ok: true, results, message: 'Pending actions executed and cleared' };
}

async function cmdFix(args) {
  const wip = getWip();
  if (!wip.workdir) throw new Error('No workdir set. Run /ghw start <workdir> first');
  const workdir = wip.workdir;
  const branchName = args[0] || `fix/${Date.now()}`;
  const defaultBranch = getDefaultBranch(workdir);

  // Fetch and rebase
  git('git fetch origin', workdir);
  git(`git checkout ${defaultBranch}`, workdir);
  git(`git pull --rebase origin ${defaultBranch}`, workdir);
  // Create new branch
  git(`git checkout -b ${branchName}`, workdir);

  const updated = { ...wip, branch: { name: branchName }, updatedAt: new Date().toISOString() };
  saveWip(updated);
  return { ok: true, branch: branchName, base: defaultBranch, workdir, message: `Switched to new branch '${branchName}' (rebased on ${defaultBranch})` };
}

async function cmdPr(args) {
  const wip = getWip();
  if (!wip.workdir) throw new Error('No workdir set. Run /ghw start <workdir> first');
  if (!wip.branch?.name) throw new Error('No branch. Run /ghw fix [name] first');

  const workdir = wip.workdir;
  const branchName = wip.branch.name;
  const defaultBranch = getDefaultBranch(workdir);

  // Push branch
  git(`git push -u origin ${branchName}`, workdir);

  // Get issue body for PR
  let prBody = '';
  if (wip.issue?.id) {
    try {
      const token = getToken();
      const issue = await apiRequest('GET', `/repos/${wip.repo}/issues/${wip.issue.id}`, token);
      prBody = `## 关联 Issue\nCloses #${wip.issue.id}\n\n${issue.body || ''}\n\n---\n_Generated by github-work skill_`;
    } catch(e) {}
  }

  const updated = { ...wip, pr: { title: wip.pr?.title || `Fix #${wip.issue?.id || ''}: ${branchName}`, body: prBody }, updatedAt: new Date().toISOString() };
  saveWip(updated);
  return { ok: true, branch: branchName, message: `Branch pushed. Run /ghw confirm to create PR` };
}

async function cmdPush(args) {
  const wip = getWip();
  if (!wip.workdir) throw new Error('No workdir set. Run /ghw start <workdir> first');
  const workdir = wip.workdir;
  const branch = getCurrentBranch(workdir);

  // Get diff for commit message generation
  const diff = git('git diff --cached', workdir) || git('git diff', workdir) || '';
  const stats = git('git diff --stat --cached', workdir) || git('git diff --stat', workdir) || '';

  const updated = { ...wip, push: { branch, diff, stats, staged: !!git('git diff --cached', workdir) }, updatedAt: new Date().toISOString() };
  saveWip(updated);
  return { ok: true, branch, stats, message: `Changes staged. Commit message needed. Use /ghw confirm push` };
}

async function cmdReview(args) {
  const token = getToken();
  const wip = getWip();
  const repo = wip.repo || (args[0] && args[0].includes('/') ? args[0] : null);
  if (!repo) throw new Error('No repo set. Run /ghw start <workdir> first, or pass /ghw review owner/repo');

  const myLogin = (await apiRequest('GET', '/user', token)).login;

  // Find earliest unclaimed PR
  const params = new URLSearchParams({ state: 'open', per_page: '50', sort: 'created', direction: 'asc' });
  const prs = await apiRequest('GET', `/repos/${repo}/pulls?${params}`, token);

  let targetPr = null;
  for (const pr of prs) {
    if (pr.user?.login === myLogin) continue;
    const comments = await apiRequest('GET', `/repos/${repo}/issues/${pr.number}/comments`, token);
    const hasClaim = comments.some(c => c.body?.includes('👀'));
    if (!hasClaim) { targetPr = pr; break; }
  }

  if (!targetPr) return { ok: true, message: 'No unclaimed PRs found', repo };

  // Claim immediately with 👀
  const checklist = buildChecklist();
  const claimComment = await apiRequest('POST', `/repos/${repo}/issues/${targetPr.number}/comments`, token, {
    body: `👀 **Review claimed** by @${myLogin}\n\n_Emoji: 👀 = in progress, ✅ = done, ❌ = needs changes_\n\n---\n${checklist}`,
  });

  return {
    ok: true, claimed: true, pr: { number: targetPr.number, title: targetPr.title, url: targetPr.html_url },
    comment: claimComment.html_url, repo,
    message: `👀 Claimed PR #${targetPr.number}: ${targetPr.title}\n\nReview the code, update the checklist [ ] -> [x] in the comment, then run /ghw review d ${targetPr.number}`
  };
}

async function cmdReviewDone(args) {
  const token = getToken();
  const wip = getWip();
  const prRef = args[0];
  const verdict = args[1] || 'approved';

  // Parse PR ref: could be just number, or owner/repo#number
  let owner, repo, num;
  if (prRef?.includes('/')) {
    const m = prRef.match(/([^/]+)\/([^#]+)#?(\d+)/);
    if (!m) throw new Error(`Invalid PR ref: ${prRef}`);
    owner = m[1]; repo = m[2]; num = parseInt(m[3]);
  } else {
    if (!wip.repo) throw new Error('No repo set. Run /ghw start <workdir> first');
    num = parseInt(prRef);
    [owner, repo] = wip.repo.split('/');
  }

  const myLogin = (await apiRequest('GET', '/user', token)).login;
  const comments = await apiRequest('GET', `/repos/${owner}/${repo}/issues/${num}/comments`, token);

  // Verify claim exists
  const myClaim = comments.find(c => c.user?.login === myLogin && c.body?.includes('👀'));
  if (!myClaim) throw new Error('No review claim found. Run /ghw review first');

  // Check all checklist items
  const items = parseChecklist(comments, myLogin);
  if (!items.length) throw new Error('No checklist items found in your comments');
  const unchecked = items.filter(i => !i.checked);
  if (unchecked.length > 0) {
    return { ok: false, incomplete: unchecked.map(i => i.text), message: `Items not checked: ${unchecked.map(i => `[ ] ${i.text}`).join(', ')}` };
  }

  // Delete all my comments
  const myComments = comments.filter(c => c.user?.login === myLogin);
  for (const c of myComments) {
    await apiRequest('DELETE', `/repos/${owner}/${repo}/issues/comments/${c.id}`, token).catch(() => {});
  }

  // Post verdict
  const emoji = verdict === 'approved' ? '✅' : '❌';
  const reviewState = verdict === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED';
  const verdictComment = await apiRequest('POST', `/repos/${owner}/${repo}/issues/${num}/comments`, token, {
    body: `${emoji} **Review complete** by @${myLogin} — ${verdict === 'approved' ? 'approves' : 'requests changes'}`,
  });
  await apiRequest('POST', `/repos/${owner}/${repo}/pulls/${num}/reviews`, token, { body: `${emoji} ${verdict}`, event: reviewState });

  return { ok: true, verdict, pr: num, comment: verdictComment.html_url, message: `${emoji} Review complete for PR #${num}` };
}

async function cmdIssue(args) {
  const token = getToken();
  const wip = getWip();
  const repo = args[0] && args[0].includes('/') ? args[0] : wip.repo;
  if (!repo) throw new Error('No repo. Run /ghw start <workdir> first, or pass owner/repo');
  const params = new URLSearchParams({ state: 'open', per_page: '50' });
  const data = await apiRequest('GET', `/repos/${repo}/issues?${params}`, token);
  const issues = data.filter(i => !i.pull_request);
  if (!issues.length) return { ok: true, repo, issues: [], message: `No open issues in ${repo}` };
  return { ok: true, repo, issues: issues.map(i => ({ number: i.number, title: i.title, state: i.state, url: i.html_url })), display: issues.map(i => `[#${i.number}] ${i.title}`).join('\n') };
}

async function cmdShow(args) {
  const token = getToken();
  const wip = getWip();
  const id = parseInt(args[0], 10);
  if (isNaN(id)) throw new Error('Usage: /ghw show #<id>');
  const repo = args[1] && args[1].includes('/') ? args[1] : wip.repo;
  if (!repo) throw new Error('No repo set. Run /ghw start <workdir> first');
  const data = await apiRequest('GET', `/repos/${repo}/issues/${id}`, token);
  return { ok: true, issue: { number: data.number, title: data.title, body: data.body, state: data.state, url: data.html_url, assignee: data.assignee?.login }, display: `[#${data.number}] ${data.title}\n\n${data.body || ''}\n\nState: ${data.state}\nURL: ${data.html_url}` };
}

async function cmdPoll(args) {
  const token = getToken();
  const wip = getWip();
  const myLogin = (await apiRequest('GET', '/user', token)).login;
  const repos = wip.repo ? [wip.repo] : [];
  if (!repos.length) return { ok: true, results: [], message: 'No repos configured' };

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const results = { newIssues: [], claimedPRs: [], mergeReady: [] };

  for (const repo of repos) {
    const issues = await apiRequest('GET', `/repos/${repo}/issues?since=${since}&state=open&per_page=20`, token);
    issues.filter(i => !i.pull_request).forEach(i => results.newIssues.push({ ...i, repo }));
    const prs = await apiRequest('GET', `/repos/${repo}/pulls?state=open&per_page=30`, token);
    for (const pr of prs) {
      if (pr.user?.login === myLogin) continue;
      const reviews = await apiRequest('GET', `/repos/${repo}/pulls/${pr.number}/reviews`, token);
      const comments = await apiRequest('GET', `/repos/${repo}/issues/${pr.number}/comments`, token);
      const approvals = reviews.filter(r => r.state === 'APPROVED').length;
      const hasClaim = comments.some(c => c.body?.includes('👀') && c.user?.login !== myLogin);
      if (!hasClaim) results.claimedPRs.push({ number: pr.number, title: pr.title, url: pr.html_url, by: pr.user?.login, repo });
    }
  }

  let display = '';
  if (results.newIssues.length) { display += '\n🆕 New Issues:\n'; results.newIssues.forEach(i => { display += `  [#${i.number}] ${i.title} [${i.repo}]\n`; }); }
  if (results.claimedPRs.length) { display += '\n👀 Unclaimed PRs:\n'; results.claimedPRs.forEach(pr => { display += `  [#${pr.number}] ${pr.title} by @${pr.by} [${pr.repo}]\n`; }); }
  if (results.mergeReady.length) { display += '\n✅ Merge Ready:\n'; results.mergeReady.forEach(pr => { display += `  [#${pr.number}] ${pr.title} [${pr.repo}]\n`; }); }
  if (!results.newIssues.length && !results.claimedPRs.length && !results.mergeReady.length) display += '\nNothing new.\n';
  return { ok: true, ...results, display };
}

async function cmdConfig(args) {
  return {
    ok: true,
    repos: REPOS,
    workDir: process.cwd(),
    hasToken: !!(ACCESS_TOKEN || readJSON(TOKEN_FILE)?.access_token),
    wip: readJSON(wip_FILE) || null,
  };
}

async function cmdPending(args) {
  const sub = args[0];
  if (sub === 'get') return { ok: true, wip: getWip() };
  if (sub === 'clear') { clearWip(); return { ok: true, message: 'Pending cleared' }; }
  // /ghw wip set --issue-title=X --issue-body=Y ...
  const opts = parseArgs(args.slice(1));
  const p = { ...getWip() };
  if (opts['issue-title']) {
    p.issue = { action: 'update', id: opts['issue-id'] ? parseInt(opts['issue-id']) : null, title: opts['issue-title'], body: opts['issue-body'] || '' };
  }
  if (opts['branch-name']) p.branch = { name: opts['branch-name'] };
  if (opts['pr-title']) p.pr = { title: opts['pr-title'], body: opts['pr-body'] || '' };
  if (opts['repo']) p.repo = opts['repo'];
  if (opts['workdir']) p.workdir = opts['workdir'];
  p.updatedAt = new Date().toISOString();
  saveWip(p);
  return { ok: true, wip: p };
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
  const cmd = parts[0] || '';
  const args = parts.slice(1);
  let result;
  try {
    switch (cmd) {
      case 'auth': result = await cmdAuth(); break;
      case 'start': result = await cmdStart(args); break;
      case 'new': result = await cmdNew(args); break;
      case 'update': result = await cmdUpdate(args); break;
      case 'confirm': result = await cmdConfirm(args); break;
      case 'fix': result = await cmdFix(args); break;
      case 'pr': result = await cmdPr(args); break;
      case 'push': result = await cmdPush(args); break;
      case 'review':
        if (args[0] === 'd' || args[0] === 'done') result = await cmdReviewDone(args.slice(1));
        else result = await cmdReview(args);
        break;
      case 'issue': result = await cmdIssue(args); break;
      case 'show': result = await cmdShow(args); break;
      case 'poll': result = await cmdPoll(args); break;
      case 'config': result = await cmdConfig(args); break;
      case 'pending': result = await cmdPending(args); break;
      default:
        throw new Error(`Unknown: ${cmd}. Use: start, new, update, confirm, fix, pr, push, review, issue, show, poll, config`);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

main();
