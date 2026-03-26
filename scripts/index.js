#!/usr/bin/env node
/**
 * ghw - GitHub team workflow automation
 * Auto-driven PR review with label-based state machine
 *
 * Labels (ghw/*):
 *   ghw/ready   - PR created, waiting for review
 *   ghw/wip    - Review in progress
 *   ghw/lgtm   - Approved
 *   ghw/revise - Changes requested
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.openclaw', 'ghw');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
const AUTO_REPOS_FILE = path.join(CONFIG_DIR, 'auto-repos.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');

// Ensure config dir
[CONFIG_DIR].forEach(d => { if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); fs.chmodSync(d, '0700'); } });

const CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN || '';

// Label definitions
const LABELS = {
  READY:   'ghw/ready',
  WIP:     'ghw/wip',
  LGTM:    'ghw/lgtm',
  REVISE:  'ghw/revise',
};
const LABEL_LIST = Object.values(LABELS);

// --- GitHub API ---
function apiRequest(method, endpoint, token, body = null) {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com${endpoint}`;
    const urlObj = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: urlObj.hostname, port: 443, path: urlObj.pathname + urlObj.search, method,
      headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ghw/1.0' },
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

async function deviceFlow() {
  if (!CLIENT_ID) throw new Error('GITHUB_CLIENT_ID not configured');
  const codeResp = await postForm('https://github.com/login/device/code', { client_id: CLIENT_ID, scope: 'repo' });
  if (!codeResp.device_code) throw new Error(`Device flow failed: ${JSON.stringify(codeResp)}`);
  console.log(`\nOpen: https://github.com/login/device\n   Enter code: ${codeResp.user_code}\nWaiting...`);
  let attempts = (codeResp.expires_in || 300) / (codeResp.interval || 5);
  while (attempts-- > 0) {
    await sleep((codeResp.interval || 5) * 1000);
    const r = await postForm('https://github.com/login/oauth/access_token', { client_id: CLIENT_ID, device_code: codeResp.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (r.access_token) { saveToken({ access_token: r.access_token }); console.log('Auth successful!'); return readJSON(TOKEN_FILE); }
    if (r.error === 'authorization_pending') { process.stdout.write('.'); continue; }
    if (r.error === 'slow_down') { await sleep((codeResp.interval || 5) * 1000); continue; }
    throw new Error(`OAuth error: ${r.error}`);
  }
  throw new Error('Auth timed out');
}

function postForm(urlStr, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const bodyStr = Object.entries(data).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const options = { hostname: urlObj.hostname, port: 443, path: urlObj.pathname, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(bodyStr), 'Accept': 'application/json', 'User-Agent': 'ghw/1.0' } };
    const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } }); });
    req.on('error', reject); req.write(bodyStr); req.end();
  });
}

// --- Git helpers ---
function git(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (e) { throw new Error(`Git error: ${e.message}`); }
}

function getRemoteRepo(workdir) {
  const remotes = git('git remote -v', workdir).split('\n');
  const match = remotes.find(l => l.includes('origin'));
  if (!match) throw new Error('No origin remote found');
  const m = match.match(/git@github\.com:([^/]+\/[^.]+)\.git/) || match.match(/https:\/\/github\.com\/([^/]+\/[^/]+)/);
  if (!m) throw new Error(`Cannot parse remote: ${match}`);
  return m[1];
}

function getCurrentBranch(cwd) { return git('git branch --show-current', cwd); }
function getDefaultBranch(cwd) { try { return execSync('git symbolic-ref refs/remotes/origin/HEAD', { encoding: 'utf8' }).trim().split('/').pop(); } catch (e) {} return 'main'; }

// --- Auto repos management ---
function getAutoRepos() { return readJSON(AUTO_REPOS_FILE) || { repos: [], lastRepo: null }; }
function saveAutoRepos(data) { writeJSON(AUTO_REPOS_FILE, data); }

function ensureLabels(token, repo) {
  return Promise.all(
    LABEL_LIST.map(name => {
      const [owner, repoName] = repo.split('/');
      return apiRequest('POST', `/repos/${owner}/${repoName}/labels`, token, { name, color: '4B9CDA', description: `ghw label: ${name}` }).catch(() => {
        // Already exists - ignore
      });
    })
  );
}

// Replace any existing ghw/* label with new one (mutually exclusive)
async function setLabel(token, repo, prNumber, newLabel) {
  const [owner, repoName] = repo.split('/');
  const issueResp = await apiRequest('GET', `/repos/${owner}/${repoName}/issues/${prNumber}`, token);
  const currentLabels = (issueResp.labels || []).map(l => l.name);
  const ghwLabels = currentLabels.filter(l => l.startsWith('ghw/'));

  // Remove existing ghw labels
  await Promise.all(ghwLabels.map(l => apiRequest('DELETE', `/repos/${owner}/${repoName}/issues/${prNumber}/labels/${encodeURIComponent(l)}`, token).catch(() => {})));

  // Add new label
  await apiRequest('POST', `/repos/${owner}/${repoName}/issues/${prNumber}/labels`, token, { labels: [newLabel] });
}

// --- Commands ---

async function cmdAuth() {
  return await deviceFlow();
}

async function cmdConfig() {
  return {
    ok: true,
    autoRepos: getAutoRepos().repos,
    hasToken: !!(ACCESS_TOKEN || readJSON(TOKEN_FILE)?.access_token),
  };
}

// auto: manage repos in automation pool
async function cmdAuto(args) {
  const sub = args[0];
  const reposFile = getAutoRepos();

  if (sub === 'add') {
    const repo = args[1];
    if (!repo || !repo.includes('/')) throw new Error('Usage: /ghw auto add owner/repo');
    if (!reposFile.repos.includes(repo)) {
      reposFile.repos.push(repo);
      saveAutoRepos(reposFile);
      // Ensure labels exist
      const token = getToken();
      await ensureLabels(token, repo);
      return { ok: true, action: 'added', repo, message: `Added ${repo} to automation pool` };
    }
    return { ok: true, action: 'already_exists', repo, message: `${repo} is already in the pool` };
  }

  if (sub === 'remove') {
    const repo = args[1];
    if (!repo) throw new Error('Usage: /ghw auto remove owner/repo');
    reposFile.repos = reposFile.repos.filter(r => r !== repo);
    if (reposFile.lastRepo === repo) reposFile.lastRepo = null;
    saveAutoRepos(reposFile);
    return { ok: true, action: 'removed', repo, message: `Removed ${repo} from automation pool` };
  }

  if (sub === 'list') {
    return { ok: true, repos: reposFile.repos, lastRepo: reposFile.lastRepo };
  }

  throw new Error('Usage: /ghw auto add|remove|list');
}

// review: fully automatic - pick a repo, find a PR, review it
async function cmdReview(args) {
  const token = getToken();
  const reposFile = getAutoRepos();
  const repos = reposFile.repos;

  if (!repos.length) throw new Error('No repos in automation pool. Run /ghw auto add owner/repo first');

  // Pick repo using round-robin (lastRepo = most recently used)
  let startIdx = repos.indexOf(reposFile.lastRepo) + 1;
  if (startIdx >= repos.length) startIdx = 0;
  const orderedRepos = [...repos.slice(startIdx), ...repos.slice(0, startIdx)];

  for (const repo of orderedRepos) {
    const [owner, repoName] = repo.split('/');

    // Ensure labels exist
    await ensureLabels(token, repo);

    // Find PRs with ghw/ready label first, then any without ghw/* labels
    const params = new URLSearchParams({ state: 'open', per_page: '30', sort: 'created', direction: 'asc' });
    const prs = await apiRequest('GET', `/repos/${repo}/pulls?${params}`, token);

    // Find ghw/ready PRs first
    let targetPr = null;
    for (const pr of prs) {
      const ghwLabels = (pr.labels || []).filter(l => l.name?.startsWith('ghw/'));
      const hasReady = ghwLabels.some(l => l.name === LABELS.READY);
      if (hasReady) { targetPr = pr; break; }
    }

    // If no ghw/ready, pick oldest PR with no ghw/* labels at all
    if (!targetPr) {
      for (const pr of prs) {
        const ghwLabels = (pr.labels || []).filter(l => l.name?.startsWith('ghw/'));
        if (ghwLabels.length === 0) { targetPr = pr; break; }
      }
    }

    if (!targetPr) continue;

    // Claim: replace ghw/ready -> ghw/wip
    await setLabel(token, repo, targetPr.number, LABELS.WIP);
    reposFile.lastRepo = repo;
    saveAutoRepos(reposFile);

    // Get linked issue for context
    let linkedIssue = { title: '', body: '' };
    const match = targetPr.body?.match(/(?:closes|fixes|cloze)s?\s+#(\d+)/i);
    if (match) {
      try {
        const li = await apiRequest('GET', `/repos/${repo}/issues/${match[1]}`, token);
        linkedIssue = { title: li.title || '', body: li.body || '' };
      } catch (e) {}
    }

    // Get diff
    const files = await apiRequest('GET', `/repos/${repo}/pulls/${targetPr.number}/files?per_page=100`, token);
    const filesSummary = files.map(f => `  - ${f.filename}: +${f.additions} -${f.deletions}`).join('\n');

    return {
      ok: true,
      action: 'claimed',
      repo,
      pr: { number: targetPr.number, title: targetPr.title, url: targetPr.html_url, user: targetPr.user?.login, state: targetPr.state },
      linkedIssue,
      files: files.map(f => ({ filename: f.filename, additions: f.additions, deletions: f.deletions, patch: f.patch })),
      verdictNeeded: `/ghw review #${targetPr.number} lgtm   # or revise`,
      message: `ghw/wip Claimed PR #${targetPr.number}: ${targetPr.title}\n\nLinked Issue: ${linkedIssue.title || 'none'}\n\nFiles changed (${files.length}):\n${filesSummary}\n\nReview the diff and issue, then call:\n/ghw review #${targetPr.number} lgtm   # or revise`,
    };
  }

  return { ok: true, message: 'No PRs found in any repo. All caught up!' };
}

// review with verdict: update label and submit review
async function cmdReviewVerdict(args) {
  const token = getToken();
  const prRef = args[0]; // "#45" or "45" or "owner/repo#45"
  const verdict = args[1]; // "lgtm" or "revise"

  let repo, num;
  const m = String(prRef).match(/^#?(\d+)$/);
  if (m) {
    // Need repo from auto-repos
    const reposFile = getAutoRepos();
    if (!reposFile.lastRepo) throw new Error('No repo context. Run /ghw review first to pick a repo');
    repo = reposFile.lastRepo;
    num = parseInt(m[1]);
  } else {
    const full = String(prRef).match(/([^/]+\/[^#]+)#?(\d+)/);
    if (!full) throw new Error('Usage: /ghw review #<pr> lgtm|revise');
    repo = full[1]; num = parseInt(full[2]);
  }
  const newLabel = verdict === 'lgtm' ? LABELS.LGTM : verdict === 'revise' ? LABELS.REVISE : LABELS.REVISE;
  await setLabel(token, repo, num, newLabel);

  const emoji = verdict === 'lgtm' ? 'ghw/lgtm' : verdict === 'revise' ? 'ghw/revise' : 'ghw/revise';
  return { ok: true, verdict, label: newLabel, pr: num, repo, message: `${emoji} Review complete for PR #${num} in ${repo}` };
}

// fix: create a new branch based on main
async function cmdFix(args) {
  const workdir = args[0];
  if (!workdir) throw new Error('Usage: /ghw fix <workdir>');
  const expandedWorkdir = workdir.startsWith('~') ? path.join(os.homedir(), workdir.slice(1)) : workdir;
  const absWorkdir = path.isAbsolute(expandedWorkdir) ? expandedWorkdir : path.join(process.cwd(), expandedWorkdir);
  if (!fs.existsSync(absWorkdir)) throw new Error(`Directory not found: ${absWorkdir}`);

  const repo = getRemoteRepo(absWorkdir);
  const branchName = args[1] || `fix/${Date.now()}`;
  const defaultBranch = getDefaultBranch(absWorkdir);
  git('git fetch origin', absWorkdir);
  git(`git checkout ${defaultBranch}`, absWorkdir);
  git(`git pull --rebase origin ${defaultBranch}`, absWorkdir);
  git(`git checkout -b ${branchName}`, absWorkdir);

  return { ok: true, repo, branch: branchName, base: defaultBranch, workdir: absWorkdir, message: `Branch '${branchName}' created (rebased on ${defaultBranch})` };
}

// pr: create PR and add ghw/ready label
async function cmdPr(args) {
  const workdir = args[0];
  if (!workdir) throw new Error('Usage: /ghw pr <workdir>');
  const expandedWorkdir = workdir.startsWith('~') ? path.join(os.homedir(), workdir.slice(1)) : workdir;
  const absWorkdir = path.isAbsolute(expandedWorkdir) ? expandedWorkdir : path.join(process.cwd(), expandedWorkdir);
  if (!fs.existsSync(absWorkdir)) throw new Error(`Directory not found: ${absWorkdir}`);

  const repo = getRemoteRepo(absWorkdir);
  const token = getToken();
  const [owner, repoName] = repo.split('/');

  // Ensure labels exist
  await ensureLabels(token, repo);

  const branch = getCurrentBranch(absWorkdir);
  const baseBranch = getDefaultBranch(absWorkdir);

  // Push branch
  git(`git push -u origin ${branch}`, absWorkdir);

  // Find linked issue from branch name (fix/123)
  let linkedIssue = null;
  const issueMatch = String(branch).match(/^(?:fix|feature|hotfix)\/(\d+)/);
  if (issueMatch) {
    try { linkedIssue = await apiRequest('GET', `/repos/${repo}/issues/${issueMatch[1]}`, token); } catch (e) {}
  }

  const title = args[1] || (linkedIssue ? `Fix #${linkedIssue.number}: ${linkedIssue.title}` : branch);
  const body = linkedIssue ? `## Linked Issue\nCloses #${linkedIssue.number}\n\n${linkedIssue.body || ''}\n\n---\n_Generated by ghw_` : `_Generated by ghw_`;

  const prData = await apiRequest('POST', `/repos/${repo}/pulls`, token, { title, body, head: branch, base: baseBranch });

  // Add ghw/ready label
  await setLabel(token, repo, prData.number, LABELS.READY);

  return { ok: true, repo, pr: { number: prData.number, title: prData.title, url: prData.html_url }, message: `ghw/ready PR #${prData.number} created in ${repo}` };
}

// push: stage, show diff, require confirm
async function cmdPush(args) {
  const workdir = args[0];
  if (!workdir) throw new Error('Usage: /ghw push <workdir>');
  const expandedWorkdir = workdir.startsWith('~') ? path.join(os.homedir(), workdir.slice(1)) : workdir;
  const absWorkdir = path.isAbsolute(expandedWorkdir) ? expandedWorkdir : path.join(process.cwd(), expandedWorkdir);
  if (!fs.existsSync(absWorkdir)) throw new Error(`Directory not found: ${absWorkdir}`);

  const branch = getCurrentBranch(absWorkdir);
  const diff = git('git diff --cached', absWorkdir) || git('git diff', absWorkdir) || '';
  const stats = git('git diff --stat --cached', absWorkdir) || git('git diff --stat', absWorkdir) || '';

  return { ok: true, branch, workdir: absWorkdir, diff, stats, message: `Staged changes on ${branch}. Diff:\n${diff.substring(0, 500)}` };
}

// confirm push: commit and push
async function cmdConfirm(args) {
  const workdir = args[0];
  if (!workdir) throw new Error('Usage: /ghw confirm <workdir> [commit-msg]');
  const expandedWorkdir = workdir.startsWith('~') ? path.join(os.homedir(), workdir.slice(1)) : workdir;
  const absWorkdir = path.isAbsolute(expandedWorkdir) ? expandedWorkdir : path.join(process.cwd(), expandedWorkdir);
  if (!fs.existsSync(absWorkdir)) throw new Error(`Directory not found: ${absWorkdir}`);

  const commitMsg = args.slice(1).join(' ') || 'Update';
  git(`git add -A`, absWorkdir);
  try { git(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, absWorkdir); } catch (e) { throw new Error('No changes to commit'); }
  git(`git push`, absWorkdir);
  const branch = getCurrentBranch(absWorkdir);

  return { ok: true, branch, workdir: absWorkdir, message: `Pushed ${branch}: "${commitMsg}"` };
}

// issue: list open issues
async function cmdIssue(args) {
  const token = getToken();
  const repo = args[0];
  if (!repo || !repo.includes('/')) throw new Error('Usage: /ghw issue owner/repo [--state=open|closed|all]');
  const state = args.find(a => a?.startsWith('--state='))?.split('=')[1] || 'open';
  const params = new URLSearchParams({ state, per_page: '50', direction: 'desc' });
  const data = await apiRequest('GET', `/repos/${repo}/issues?${params}`, token);
  const issues = data.filter(i => !i.pull_request);
  return { ok: true, repo, issues: issues.map(i => ({ number: i.number, title: i.title, state: i.state, url: i.html_url })), display: issues.map(i => `[#${i.number}] ${i.title} (${i.state})`).join('\n') || 'No issues' };
}

// show: view issue or PR
async function cmdShow(args) {
  const token = getToken();
  const prRef = args[0]; // "#45" or "45" or "owner/repo#45"
  let repo, num;
  const full = String(prRef).match(/([^/]+\/[^#]+)#?(\d+)/);
  if (full) { repo = full[1]; num = parseInt(full[2]); }
  else {
    const reposFile = getAutoRepos();
    if (!reposFile.lastRepo) throw new Error('No repo context. Run /ghw review first to pick a repo');
    repo = reposFile.lastRepo;
    num = parseInt(String(prRef).replace('#', ''));
  }
  const data = await apiRequest('GET', `/repos/${repo}/issues/${num}`, token);
  return { ok: true, issue: { number: data.number, title: data.title, body: data.body, state: data.state, url: data.html_url, labels: data.labels?.map(l => l.name) }, display: `[#${data.number}] ${data.title}\n\n${data.body || ''}\n\nState: ${data.state}\nLabels: ${(data.labels || []).map(l => l.name).join(', ')}\nURL: ${data.html_url}` };
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
      case 'auth':   result = await cmdAuth(); break;
      case 'config': result = await cmdConfig(); break;
      case 'auto':   result = await cmdAuto(args); break;
      case 'review':
        if (args[0]?.startsWith('#') || args[0]?.match(/^\d+$/) || String(args[0]).includes('/')) {
          result = await cmdReviewVerdict(args);
        } else {
          result = await cmdReview(args);
        }
        break;
      case 'fix':    result = await cmdFix(args); break;
      case 'pr':     result = await cmdPr(args); break;
      case 'push':   result = await cmdPush(args); break;
      case 'confirm': result = await cmdConfirm(args); break;
      case 'issue':   result = await cmdIssue(args); break;
      case 'show':    result = await cmdShow(args); break;
      default:
        throw new Error(`Unknown: ${cmd}. Use: auth, config, auto, review, fix, pr, push, confirm, issue, show`);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

main();
