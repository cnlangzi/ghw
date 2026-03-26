#!/usr/bin/env node
/**
 * gtw - Git Team Workflow automation
 * Session-based issue generation, git operations, and auto-driven PR review.
 *
 * Labels (ghw/*):
 *   ghw/ready   - PR created, waiting for review
 *   ghw/wip     - Review in progress
 *   ghw/lgtm    - Approved
 *   ghw/revise  - Changes requested
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.openclaw', 'gtw');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const wip_FILE = path.join(CONFIG_DIR, 'wip.json');

[CONFIG_DIR].forEach(d => { if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); fs.chmodSync(d, 0o700); } });

const CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN || '';

const LABELS = { READY: 'ghw/ready', WIP: 'ghw/wip', LGTM: 'ghw/lgtm', REVISE: 'ghw/revise' };
const LABEL_LIST = Object.values(LABELS);

// --- GitHub API ---
function apiRequest(method, endpoint, token, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL('https://api.github.com' + endpoint);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = { hostname: urlObj.hostname, port: 443, path: urlObj.pathname + urlObj.search, method, headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'gtw/1.0' } };
    if (bodyStr) { options.headers['Content-Type'] = 'application/json'; options.headers['Content-Length'] = Buffer.byteLength(bodyStr); }
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error('GitHub API ' + res.statusCode + ': ' + JSON.stringify(parsed)));
        } catch (e) { reject(new Error('Parse error (' + res.statusCode + '): ' + data.substring(0, 200))); }
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
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); fs.chmodSync(file, 0o600); }
function getWip() { return readJSON(wip_FILE) || {}; }
function saveWip(p) { writeJSON(wip_FILE, p); }
function clearWip() { if (fs.existsSync(wip_FILE)) fs.unlinkSync(wip_FILE); }
function getConfig() { return readJSON(CONFIG_FILE) || { repos: [], lastRepo: null }; }
function saveConfig(data) { writeJSON(CONFIG_FILE, data); }

// --- Token ---
function getToken() { if (ACCESS_TOKEN) return ACCESS_TOKEN; const t = readJSON(TOKEN_FILE); if (!t || !t.access_token) throw new Error('Not authenticated. Run /gtw auth or set GITHUB_ACCESS_TOKEN'); return t.access_token; }
function saveToken(t) { writeJSON(TOKEN_FILE, t); }

// --- OAuth Device Flow ---
function postForm(urlStr, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const bodyStr = Object.entries(data).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    const options = { hostname: urlObj.hostname, port: 443, path: urlObj.pathname, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(bodyStr), 'Accept': 'application/json', 'User-Agent': 'gtw/1.0' } };
    const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } }); });
    req.on('error', reject); req.write(bodyStr); req.end();
  });
}

async function deviceFlow() {
  if (!CLIENT_ID) throw new Error('GITHUB_CLIENT_ID not configured');
  const codeResp = await postForm('https://github.com/login/device/code', { client_id: CLIENT_ID, scope: 'repo' });
  if (!codeResp.device_code) throw new Error('Device flow failed: ' + JSON.stringify(codeResp));
  console.log('Open: https://github.com/login/device  Enter code: ' + codeResp.user_code + '  Waiting...');
  let attempts = (codeResp.expires_in || 300) / (codeResp.interval || 5);
  while (attempts-- > 0) {
    await sleep((codeResp.interval || 5) * 1000);
    const r = await postForm('https://github.com/login/oauth/access_token', { client_id: CLIENT_ID, device_code: codeResp.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (r.access_token) { saveToken({ access_token: r.access_token }); console.log('Auth successful!'); return readJSON(TOKEN_FILE); }
    if (r.error === 'authorization_pending') { process.stdout.write('.'); continue; }
    if (r.error === 'slow_down') { await sleep((codeResp.interval || 5) * 1000); continue; }
    throw new Error('OAuth error: ' + r.error);
  }
  throw new Error('Auth timed out');
}

// --- Git helpers ---
function git(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (e) { throw new Error('Git error: ' + e.message); }
}

function getRemoteRepo(workdir) {
  const remotes = git('git remote -v', workdir).split('\n');
  const match = remotes.find(l => l.includes('origin'));
  if (!match) throw new Error('No origin remote found');
  const m = match.match(/git@github\.com:([^/]+\/[^.]+)\.git/) || match.match(/https:\/\/github\.com\/([^/]+\/[^/]+)/);
  if (!m) throw new Error('Cannot parse remote: ' + match);
  return m[1];
}

function getCurrentBranch(cwd) { return git('git branch --show-current', cwd); }
function getDefaultBranch(cwd) { try { return execSync('git symbolic-ref refs/remotes/origin/HEAD', { encoding: 'utf8' }).trim().split('/').pop(); } catch (e) {} return 'main'; }

// --- Labels ---
function ensureLabels(token, repo) {
  return Promise.all(LABEL_LIST.map(name => apiRequest('POST', '/repos/' + repo + '/labels', token, { name, color: '4B9CDA', description: 'gtw label: ' + name }).catch(() => {})));
}

async function setLabel(token, repo, prNumber, newLabel) {
  const issueResp = await apiRequest('GET', '/repos/' + repo + '/issues/' + prNumber, token);
  const ghwLabels = (issueResp.labels || []).filter(l => l.name && l.name.startsWith('ghw/'));
  await Promise.all(ghwLabels.map(l => apiRequest('DELETE', '/repos/' + repo + '/issues/' + prNumber + '/labels/' + encodeURIComponent(l.name), token).catch(() => {})));
  await apiRequest('POST', '/repos/' + repo + '/issues/' + prNumber + '/labels', token, { labels: [newLabel] });
}

// ============================================================
// SESSION-BASED COMMANDS
// All git operations write to wip.json; /gtw confirm executes.
// ============================================================

// on: set workdir + repo in session context
async function cmdOn(args) {
  const workdir = args[0];
  if (!workdir) throw new Error('Usage: /gtw on <workdir>');
  const expandedWorkdir = workdir.startsWith('~') ? path.join(os.homedir(), workdir.slice(1)) : workdir;
  const absWorkdir = path.isAbsolute(expandedWorkdir) ? expandedWorkdir : path.join(process.cwd(), expandedWorkdir);
  if (!fs.existsSync(absWorkdir)) throw new Error('Directory not found: ' + absWorkdir);
  const repo = getRemoteRepo(absWorkdir);
  const wip = { workdir: absWorkdir, repo, createdAt: new Date().toISOString() };
  saveWip(wip);
  return { ok: true, workdir: absWorkdir, repo, message: 'Workdir set to ' + absWorkdir + ', repo: ' + repo };
}

// new: create issue draft in session (no API call)
async function cmdNew(args) {
  const wip = getWip();
  if (!wip.repo) throw new Error('No repo set. Run /gtw on <workdir> first');
  const title = args[0] || '';
  const body = args.slice(1).join(' ') || '';
  const updated = Object.assign({}, wip, { issue: { action: 'create', id: null, title, body }, updatedAt: new Date().toISOString() });
  saveWip(updated);
  return { ok: true, wip: updated, message: title ? 'Issue draft saved: ' + title : 'Issue draft saved (title/body will be filled by agent)' };
}

// update: update issue draft in session (no API call)
async function cmdUpdate(args) {
  const id = parseInt(args[0], 10);
  if (isNaN(id)) throw new Error('Usage: /gtw update #<id> [title]');
  const wip = getWip();
  if (!wip.repo) throw new Error('No repo set. Run /gtw on <workdir> first');
  const rest = args.slice(1).join(' ');
  const updated = Object.assign({}, wip, { issue: { action: 'update', id, title: rest, body: '' }, updatedAt: new Date().toISOString() });
  saveWip(updated);
  return { ok: true, wip: updated, message: 'Issue #' + id + ' update draft saved' };
}

// confirm: execute all pending actions from wip.json, then clear
async function cmdConfirm(args) {
  const token = getToken();
  const wip = getWip();
  if (!wip.repo) throw new Error('No session. Run /gtw on <workdir> first');
  const results = [];
  const repo = wip.repo;

  // Issue create/update
  if (wip.issue && wip.issue.title) {
    const { action, id, title, body } = wip.issue;
    if (action === 'create') {
      const data = await apiRequest('POST', '/repos/' + repo + '/issues', token, { title, body: body || 'Created via gtw' });
      results.push({ type: 'issue', action: 'created', id: data.number, url: data.html_url });
    } else if (action === 'update' && id) {
      const data = await apiRequest('PATCH', '/repos/' + repo + '/issues/' + id, token, { title, body });
      results.push({ type: 'issue', action: 'updated', id, url: data.html_url });
    }
  }

  // Git branch creation on GitHub (only if we have an issue id to link to)
  if (wip.branch && wip.branch.name && wip.issue && wip.issue.id) {
    const branchName = wip.branch.name;
    const shaResp = await apiRequest('GET', '/repos/' + repo + '/git/ref/heads/' + getDefaultBranch(wip.workdir), token);
    await apiRequest('POST', '/repos/' + repo + '/git/refs', token, { ref: 'refs/heads/' + branchName, sha: shaResp.object.sha });
    const parts = repo.split('/');
    try { await apiRequest('POST', '/repos/' + parts[0] + '/' + parts[1] + '/issues/' + wip.issue.id + '/labels', token, { labels: ['branch:' + branchName] }); } catch (e) {}
    results.push({ type: 'branch', action: 'created', name: branchName });
  }

  // PR creation
  if (wip.pr && wip.pr.title) {
    await ensureLabels(token, repo);
    const baseBranch = getDefaultBranch(wip.workdir);
    const headBranch = wip.branch ? wip.branch.name : getCurrentBranch(wip.workdir);
    const body = wip.pr.body || 'Closes #' + (wip.issue ? wip.issue.id : '?');
    const data = await apiRequest('POST', '/repos/' + repo + '/pulls', token, { title: wip.pr.title, body, head: headBranch, base: baseBranch });
    await setLabel(token, repo, data.number, LABELS.READY);
    results.push({ type: 'pr', action: 'created', id: data.number, url: data.html_url, label: 'ghw/ready' });
  }

  clearWip();
  return { ok: true, results, message: 'Session executed and cleared: ' + results.map(r => r.type + '=' + r.action).join(', ') };
}

// fix: create local branch only, write to wip.json (no push, no GitHub branch ref)
async function cmdFix(args) {
  const wip = getWip();
  if (!wip.workdir) throw new Error('No workdir set. Run /gtw on <workdir> first');
  const workdir = wip.workdir;
  const branchName = args[0] || 'fix/' + Date.now();
  const defaultBranch = getDefaultBranch(workdir);
  git('git fetch origin', workdir);
  git('git checkout ' + defaultBranch, workdir);
  git('git pull --rebase origin ' + defaultBranch, workdir);
  git('git checkout -b ' + branchName, workdir);
  const updated = Object.assign({}, wip, { branch: { name: branchName }, updatedAt: new Date().toISOString() });
  saveWip(updated);
  return { ok: true, branch: branchName, base: defaultBranch, message: "Branch '" + branchName + "' created locally (rebased on " + defaultBranch + '). Run /gtw confirm to create GitHub branch + PR.' };
}

// pr: push branch to origin, generate PR draft in wip.json (no PR created yet)
async function cmdPr(args) {
  const wip = getWip();
  if (!wip.workdir) throw new Error('No workdir set. Run /gtw on <workdir> first');
  if (!wip.branch || !wip.branch.name) throw new Error('No branch. Run /gtw fix [name] first');
  const workdir = wip.workdir;
  const branchName = wip.branch.name;
  git('git push -u origin ' + branchName, workdir);
  let prBody = '';
  if (wip.issue && wip.issue.id) {
    try { const issue = await apiRequest('GET', '/repos/' + wip.repo + '/issues/' + wip.issue.id, getToken()); prBody = '## Linked Issue\nCloses #' + wip.issue.id + '\n\n' + (issue.body || '') + '\n\n---\n_Generated by gtw_'; } catch (e) {}
  }
  const updated = Object.assign({}, wip, { pr: { title: wip.pr && wip.pr.title ? wip.pr.title : 'Fix #' + (wip.issue ? wip.issue.id + ': ' : '') + branchName, body: prBody }, updatedAt: new Date().toISOString() });
  saveWip(updated);
  return { ok: true, branch: branchName, message: 'Branch pushed. Run /gtw confirm to create PR with ghw/ready label.' };
}

// push: git add + commit + push (direct execution, no wip)
async function cmdPush(args) {
  const wip = getWip();
  if (!wip.workdir) throw new Error('No workdir set. Run /gtw on <workdir> first');
  const workdir = wip.workdir;
  const branch = getCurrentBranch(workdir);
  const diff = git('git diff --cached', workdir) || git('git diff', workdir) || '';
  const stats = git('git diff --stat --cached', workdir) || git('git diff --stat', workdir) || '';
  const updated = Object.assign({}, wip, { push: { branch, diff, stats } }, { updatedAt: new Date().toISOString() });
  saveWip(updated);
  return { ok: true, branch, stats, message: 'Changes staged on ' + branch + '. Run /gtw confirm to commit and push.' };
}

// ============================================================
// STATELESS COMMANDS
// ============================================================

async function cmdAuth() { return await deviceFlow(); }

async function cmdConfig() {
  return { ok: true, hasToken: !!(ACCESS_TOKEN || (readJSON(TOKEN_FILE) && readJSON(TOKEN_FILE).access_token)), wip: getWip(), autoRepos: getConfig().repos };
}

// auto: manage repos in automation pool (label-based review uses this)
async function cmdAuto(args) {
  const sub = args[0];
  const config = getConfig();
  if (sub === 'add') {
    const repo = args[1];
    if (!repo || !repo.includes('/')) throw new Error('Usage: /gtw auto add owner/repo');
    if (!config.repos.includes(repo)) { config.repos.push(repo); saveConfig(config); try { const token = getToken(); await ensureLabels(token, repo); } catch (e) {} }
    return { ok: true, repo, message: config.repos.includes(repo) && config.repos.indexOf(repo) < config.repos.length - 1 ? repo + ' is already in the pool' : 'Added ' + repo + ' to automation pool' };
  }
  if (sub === 'remove') {
    const repo = args[1];
    if (!repo) throw new Error('Usage: /gtw auto remove owner/repo');
    config.repos = config.repos.filter(r => r !== repo);
    if (config.lastRepo === repo) config.lastRepo = null;
    saveConfig(config);
    return { ok: true, repo, message: 'Removed ' + repo + ' from automation pool' };
  }
  if (sub === 'list') return { ok: true, repos: config.repos, lastRepo: config.lastRepo };
  throw new Error('Usage: /gtw auto add|remove|list');
}

// review: auto-driven label-based review (stateless)
async function cmdReview(args) {
  const token = getToken();
  const config = getConfig();
  const repos = config.repos;
  if (!repos.length) throw new Error('No repos in automation pool. Run /gtw auto add owner/repo first');
  const startIdx = repos.indexOf(config.lastRepo) + 1;
  const orderedRepos = repos.slice(startIdx).concat(repos.slice(0, startIdx));
  for (const repo of orderedRepos) {
    try { await ensureLabels(token, repo); } catch (e) {}
    const params = new URLSearchParams({ state: 'open', per_page: '30', sort: 'created', direction: 'asc' });
    const prs = await apiRequest('GET', '/repos/' + repo + '/pulls?' + params, token);
    let targetPr = null;
    for (const pr of prs) { if ((pr.labels || []).some(l => l.name && l.name === LABELS.READY)) { targetPr = pr; break; } }
    if (!targetPr) { for (const pr of prs) { if (!(pr.labels || []).some(l => l.name && l.name.startsWith('ghw/'))) { targetPr = pr; break; } } }
    if (!targetPr) continue;
    await setLabel(token, repo, targetPr.number, LABELS.WIP);
    config.lastRepo = repo;
    saveConfig(config);
    let linkedIssue = { title: '', body: '' };
    const match = targetPr.body && targetPr.body.match(/(?:closes|fixes|cloze)s?\s+#(\d+)/i);
    if (match) { try { const li = await apiRequest('GET', '/repos/' + repo + '/issues/' + match[1], token); linkedIssue = { title: li.title || '', body: li.body || '' }; } catch (e) {} }
    const files = await apiRequest('GET', '/repos/' + repo + '/pulls/' + targetPr.number + '/files?per_page=100', token);
    const filesSummary = files.map(f => '  - ' + f.filename + ': +' + f.additions + ' -' + f.deletions).join('\n');
    return { ok: true, action: 'claimed', repo, pr: { number: targetPr.number, title: targetPr.title, url: targetPr.html_url, user: targetPr.user ? targetPr.user.login : '' }, linkedIssue, files: files.map(f => ({ filename: f.filename, additions: f.additions, deletions: f.deletions, patch: f.patch })), verdictNeeded: '/gtw review #' + targetPr.number + ' lgtm   # or revise', message: 'ghw/wip Claimed PR #' + targetPr.number + ': ' + targetPr.title + '\n\nLinked Issue: ' + (linkedIssue.title || 'none') + '\n\nFiles changed (' + files.length + '):\n' + filesSummary + '\n\nReview the diff and issue, then call:\n/gtw review #' + targetPr.number + ' lgtm   # or revise' };
  }
  return { ok: true, message: 'No PRs found in any repo. All caught up!' };
}

// review verdict: label-only (no GitHub Review API)
async function cmdReviewVerdict(args) {
  const token = getToken();
  const config = getConfig();
  const prRef = args[0];
  const verdict = args[1];
  let repo, num;
  const m = String(prRef).match(/^#?(\d+)$/);
  if (m) {
    const wip = getWip();
    repo = wip.repo || config.lastRepo;
    if (!repo) throw new Error('No repo context. Run /gtw on <workdir> or /gtw review first');
    num = parseInt(m[1]);
  } else {
    const full = String(prRef).match(/([^/]+\/[^#]+)#?(\d+)/);
    if (!full) throw new Error('Usage: /gtw review #<pr> lgtm|revise');
    repo = full[1]; num = parseInt(full[2]);
  }
  const newLabel = verdict === 'lgtm' ? LABELS.LGTM : verdict === 'revise' ? LABELS.REVISE : LABELS.REVISE;
  await setLabel(token, repo, num, newLabel);
  const emoji = verdict === 'lgtm' ? 'ghw/lgtm' : 'ghw/revise';
  return { ok: true, verdict, label: newLabel, pr: num, repo, message: emoji + ' Review complete for PR #' + num + ' in ' + repo };
}

// issue: list open issues in repo
async function cmdIssue(args) {
  const token = getToken();
  const wip = getWip();
  const config = getConfig();
  let repo = args[0];
  if (!repo && wip.repo) repo = wip.repo;
  if (!repo && config.lastRepo) repo = config.lastRepo;
  if (!repo || !repo.includes('/')) throw new Error('Usage: /gtw issue [owner/repo] [--state=open|closed|all]');
  const state = (args.find(a => a && a.startsWith('--state=')) || '--state=open').split('=')[1];
  const params = new URLSearchParams({ state, per_page: '50' });
  const data = await apiRequest('GET', '/repos/' + repo + '/issues?' + params, token);
  const issues = data.filter(i => !i.pull_request);
  return { ok: true, repo, issues: issues.map(i => ({ number: i.number, title: i.title, state: i.state, url: i.html_url })), display: issues.map(i => '[#' + i.number + '] ' + i.title + ' (' + i.state + ')').join('\n') || 'No issues' };
}

// show: view issue or PR details
async function cmdShow(args) {
  const token = getToken();
  const wip = getWip();
  const config = getConfig();
  const id = parseInt(args[0], 10);
  if (isNaN(id)) throw new Error('Usage: /gtw show #<id>');
  let repo;
  const full = String(args[0]).match(/([^/]+\/[^#]+)#?(\d+)/);
  if (full) { repo = full[1]; }
  else { repo = wip.repo || config.lastRepo; }
  if (!repo) throw new Error('No repo context. Run /gtw on <workdir> or /gtw review first');
  const data = await apiRequest('GET', '/repos/' + repo + '/issues/' + id, token);
  return { ok: true, issue: { number: data.number, title: data.title, body: data.body, state: data.state, url: data.html_url, labels: (data.labels || []).map(l => l.name) }, display: '[#' + data.number + '] ' + data.title + '\n\n' + (data.body || '') + '\n\nState: ' + data.state + '\nLabels: ' + (data.labels || []).map(l => l.name).join(', ') + '\nURL: ' + data.html_url };
}

// ============================================================
// DISPATCH
// ============================================================

async function main() {
  const input = process.argv[2] || '';
  const parts = input.trim().split(/\s+/).filter(Boolean);
  const cmd = parts[0] || '';
  const args = parts.slice(1);
  let result;
  try {
    switch (cmd) {
      case 'auth':    result = await cmdAuth(); break;
      case 'on':      result = await cmdOn(args); break;
      case 'new':     result = await cmdNew(args); break;
      case 'update':  result = await cmdUpdate(args); break;
      case 'confirm': result = await cmdConfirm(args); break;
      case 'fix':     result = await cmdFix(args); break;
      case 'pr':      result = await cmdPr(args); break;
      case 'push':    result = await cmdPush(args); break;
      case 'config':  result = await cmdConfig(); break;
      case 'auto':    result = await cmdAuto(args); break;
      case 'review':
        if (args[0] && (args[0].startsWith('#') || args[0].match(/^\d+$/) || String(args[0]).includes('/'))) {
          result = await cmdReviewVerdict(args);
        } else {
          result = await cmdReview(args);
        }
        break;
      case 'issue':   result = await cmdIssue(args); break;
      case 'show':    result = await cmdShow(args); break;
      default:
        throw new Error('Unknown: ' + cmd + '. Use: on, new, update, confirm, fix, pr, push, config, auto, review, issue, show');
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

main();
