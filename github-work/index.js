#!/usr/bin/env node
/**
 * github-work skill - GitHub Team Workflow Tool
 * Command-dispatch: tool implementation
 *
 * Receives: { command: "<raw args>", commandName, skillName }
 * Subcommands:
 *   auth, issue, branch, pr, review, poll
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const readline = require('readline');
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

// --- Env defaults ---
const CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN || '';
const DEFAULT_REPO = process.env.GITHUB_REPO || '';
const DEFAULT_OWNER = process.env.GITHUB_DEFAULT_OWNER || '';
const APPROVAL_COUNT = parseInt(process.env.GHW_APPROVAL_COUNT || '1', 10);
const REVIEW_TIMEOUT_HOURS = parseInt(process.env.GHW_REVIEW_TIMEOUT_HOURS || '24', 10);

// --- GitHub API helpers ---
function apiRequest(method, endpoint, token, body = null, isGraphQL = false) {
  return new Promise((resolve, reject) => {
    const url = isGraphQL ? 'https://api.github.com/graphql' : `https://api.github.com${endpoint}`;
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Accept': isGraphQL ? 'application/json' : 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-work-skill/1.0',
      },
    };
    if (body) {
      const bodyStr = isGraphQL ? JSON.stringify({ query: body }) : JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      options.body = bodyStr;
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
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(isGraphQL ? JSON.stringify({ query: body }) : JSON.stringify(body));
    req.end();
  });
}

// --- File I/O helpers ---
function readJSON(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {}
  return null;
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  fs.chmodSync(file, '0600');
}

// --- Token management ---
function getToken() {
  if (ACCESS_TOKEN) return ACCESS_TOKEN;
  const tokenData = readJSON(TOKEN_FILE);
  if (!tokenData || !tokenData.access_token) {
    throw new Error('Not authenticated. Run /ghw auth first.');
  }
  return tokenData.access_token;
}

function saveToken(tokenData) {
  writeJSON(TOKEN_FILE, tokenData);
}

// --- OAuth Device Flow ---
async function deviceFlow() {
  if (!CLIENT_ID) {
    throw new Error('GITHUB_CLIENT_ID not configured. Set it in skills.entries.github-work.env');
  }

  // Step 1: Request device code
  const codeResp = await postForm('https://github.com/login/device/code', {
    client_id: CLIENT_ID,
    scope: 'repo workflow',
  });

  if (!codeResp.device_code || !codeResp.user_code) {
    throw new Error(`Device flow init failed: ${JSON.stringify(codeResp)}`);
  }

  console.log(`\n🔗 Open this URL in your browser: https://github.com/login/device`);
  console.log(`   Enter code: ${codeResp.user_code}\n`);
  console.log('Waiting for authentication...');

  // Step 2: Poll for token
  const interval = codeResp.interval || 5;
  let attempts = (codeResp.expires_in || 300) / interval;

  while (attempts-- > 0) {
    await sleep(interval * 1000);
    try {
      const tokenResp = await postForm('https://github.com/login/oauth/access_token', {
        client_id: CLIENT_ID,
        device_code: codeResp.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });

      if (tokenResp.access_token) {
        const tokenData = {
          access_token: tokenResp.access_token,
          token_type: tokenResp.token_type,
          scope: tokenResp.scope,
        };
        saveToken(tokenData);
        console.log('\n✅ Authentication successful! Token saved.');
        return tokenData;
      }

      if (tokenResp.error === 'authorization_pending') {
        process.stdout.write('.');
        continue;
      }

      if (tokenResp.error === 'slow_down') {
        await sleep(interval * 1000);
        continue;
      }

      throw new Error(`OAuth error: ${tokenResp.error || JSON.stringify(tokenResp)}`);
    } catch (e) {
      if (e.message.includes('authorization_pending')) continue;
      throw e;
    }
  }

  throw new Error('Authentication timed out. Please try again.');
}

function postForm(urlStr, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const body = Object.entries(data).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json',
        'User-Agent': 'github-work-skill/1.0',
      },
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { resolve(d); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --- Issue commands ---
async function issueNew(args) {
  const token = getToken();
  const title = args.join(' ').trim();
  if (!title) throw new Error('Issue title required: /ghw issue new <title>');

  const body = `## 需求描述\n\n（请填写）\n\n## 功能范围\n- ✅ 在范围内：\n- ❌ 不在范围内：\n\n## 验收标准\n- [ ] 标准1\n\n## Owner\n@${DEFAULT_OWNER}\n`;

  const repo = DEFAULT_REPO;
  if (!repo) throw new Error('GITHUB_REPO not set. Use: /ghw issue new <title> --repo owner/repo');

  const [owner, repoName] = repo.split('/');
  const data = await apiRequest('POST', `/repos/${owner}/${repoName}/issues`, token, { title, body });
  return { ok: true, issue: data.html_url || `#${data.number}`, number: data.number, url: data.html_url };
}

async function issueList(args) {
  const token = getToken();
  const opts = parseArgs(args);
  const repo = opts.repo || DEFAULT_REPO;
  if (!repo) throw new Error('GITHUB_REPO not set or use --repo owner/repo');

  const [owner, repoName] = repo.split('/');
  const params = new URLSearchParams({ state: opts.state || 'open', per_page: '30' });
  if (opts.assignee) params.set('assignee', opts.assignee);
  if (opts.labels) params.set('labels', opts.labels);

  const data = await apiRequest('GET', `/repos/${owner}/${repoName}/issues?${params}`, token);
  if (!data.length) return { ok: true, issues: [], message: 'No issues found' };

  const lines = data.map(i => `[#${i.number}] ${i.title} ${i.state === 'open' ? '🟢' : '🔴'} ${i.assignees?.map(a => '@'+a.login).join(' ') || ''}`.trim());
  return { ok: true, issues: data.map(i => ({ number: i.number, title: i.title, state: i.state, url: i.html_url, assignee: i.assignees?.[0]?.login })), display: lines.join('\n') };
}

async function issueShow(args) {
  const token = getToken();
  const num = parseInt(args[0], 10);
  if (isNaN(num)) throw new Error('Issue number required: /ghw issue show <issue-number>');

  const repo = DEFAULT_REPO;
  if (!repo) throw new Error('GITHUB_REPO not set');
  const [owner, repoName] = repo.split('/');
  const data = await apiRequest('GET', `/repos/${owner}/${repoName}/issues/${num}`, token);
  return { ok: true, issue: data, display: `#${data.number}: ${data.title}\n${data.body || ''}\n\nState: ${data.state}\nURL: ${data.html_url}` };
}

async function issueUpdate(args) {
  const token = getToken();
  const num = parseInt(args[0], 10);
  if (isNaN(num)) throw new Error('Issue number required: /ghw issue update <issue-number>');
  args.shift();

  const opts = parseArgs(args);
  const updates = {};
  if (opts.title) updates.title = opts.title;
  if (opts.body) updates.body = opts.body;
  if (opts.state) updates.state = opts.state;
  if (opts.assignee) updates.assignee = opts.assignee;
  if (opts.label) updates.labels = opts.label.split(',');

  const repo = DEFAULT_REPO;
  if (!repo) throw new Error('GITHUB_REPO not set');
  const [owner, repoName] = repo.split('/');
  const data = await apiRequest('PATCH', `/repos/${owner}/${repoName}/issues/${num}`, token, updates);
  return { ok: true, issue: data, url: data.html_url };
}

// --- Branch commands ---
async function branchNew(args) {
  const token = getToken();
  const issueNum = parseInt(args[0], 10);
  if (isNaN(issueNum)) throw new Error('Issue number required: /ghw branch new <issue-number>');

  const opts = parseArgs(args.slice(1));
  const repo = DEFAULT_REPO;
  if (!repo) throw new Error('GITHUB_REPO not set');
  const [owner, repoName] = repo.split('/');

  // Get issue title for branch name
  const issue = await apiRequest('GET', `/repos/${owner}/${repoName}/issues/${issueNum}`, token);
  const shortTitle = (issue.title || 'branch')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 40);
  const branchName = opts.name || `issue-${issueNum}-${shortTitle}`;

  // Get default branch (main)
  const repoData = await apiRequest('GET', `/repos/${owner}/${repoName}`, token);
  const baseBranch = repoData.default_branch || 'main';

  // Get latest commit SHA of base branch
  const refData = await apiRequest('GET', `/repos/${owner}/${repoName}/git/ref/heads/${baseBranch}`, token);
  const sha = refData.object.sha;

  // Create branch ref
  await apiRequest('POST', `/repos/${owner}/${repoName}/git/refs`, token, {
    ref: `refs/heads/${branchName}`,
    sha,
  });

  // Link issue to branch via labels / check if linked
  // Add label to issue noting which branch
  const labelName = `branch:${branchName}`;
  try {
    await apiRequest('POST', `/repos/${owner}/${repoName}/issues/${issueNum}/labels`, token, { labels: [`branch:${branchName}`] });
  } catch (e) {}

  return { ok: true, branch: branchName, issue: `#${issueNum}`, base: baseBranch, sha, url: `https://github.com/${owner}/${repoName}/tree/${branchName}` };
}

async function branchList(args) {
  const token = getToken();
  const opts = parseArgs(args);
  const repo = opts.repo || DEFAULT_REPO;
  if (!repo) throw new Error('GITHUB_REPO not set');
  const [owner, repoName] = repo.split('/');

  const data = await apiRequest('GET', `/repos/${owner}/${repoName}/branches`, token, null);
  const lines = data.map(b => `${b.name} ${b.protected ? '🔒' : ''}`);
  return { ok: true, branches: data.map(b => ({ name: b.name, protected: b.protected })), display: lines.join('\n') };
}

// --- PR commands ---
async function prNew(args) {
  const token = getToken();
  const issueNum = parseInt(args[0], 10);
  if (isNaN(issueNum)) throw new Error('Issue number required: /ghw pr new <issue-number>');
  args.shift();

  const opts = parseArgs(args);
  const repo = DEFAULT_REPO;
  if (!repo) throw new Error('GITHUB_REPO not set');
  const [owner, repoName] = repo.split('/');

  // Get issue
  const issue = await apiRequest('GET', `/repos/${owner}/${repoName}/issues/${issueNum}`, token);

  // Find branch associated with this issue
  const branchName = opts.branch || `issue-${issueNum}`;
  const repoData = await apiRequest('GET', `/repos/${owner}/${repoName}`, token);
  const baseBranch = repoData.default_branch || 'main';

  const title = opts.title || `Fix #${issueNum}: ${issue.title}`;
  const body = opts.body || `## 关联 Issue\nCloses #${issueNum}\n\n## 做了什么\n（请填写）\n\n## 是否在范围内\n- [ ] 是，完成了 Issue 要求的内容\n- [ ] 否，有超出 Issue 范围的内容\n\n---\n_Generated by github-work skill_\n`;

  const data = await apiRequest('POST', `/repos/${owner}/${repoName}/pulls`, token, {
    title,
    body,
    head: branchName,
    base: baseBranch,
  });

  return { ok: true, pr: data.number, url: data.html_url, state: data.state };
}

async function prList(args) {
  const token = getToken();
  const opts = parseArgs(args);
  const repo = opts.repo || DEFAULT_REPO;
  if (!repo) throw new Error('GITHUB_REPO not set');
  const [owner, repoName] = repo.split('/');

  const params = new URLSearchParams({ state: opts.state || 'open', per_page: '30', sort: 'updated', direction: 'desc' });
  const data = await apiRequest('GET', `/repos/${owner}/${repoName}/pulls?${params}`, token);
  if (!data.length) return { ok: true, prs: [], message: 'No PRs found' };

  const lines = data.map(pr => `[#${pr.number}] ${pr.title} ${pr.state === 'open' ? '🟢' : '🔴'} by @${pr.user?.login || 'unknown'}`);
  return { ok: true, prs: data.map(pr => ({ number: pr.number, title: pr.title, state: pr.state, url: pr.html_url, user: pr.user?.login })), display: lines.join('\n') };
}

async function prShow(args) {
  const token = getToken();
  const { owner, repoName, num } = parsePRRef(args[0], DEFAULT_REPO);
  const data = await apiRequest('GET', `/repos/${owner}/${repoName}/pulls/${num}`, token);

  // Get reviews
  const reviews = await apiRequest('GET', `/repos/${owner}/${repoName}/pulls/${num}/reviews`, token);

  let reviewSummary = 'No reviews yet';
  if (reviews.length) {
    const byUser = {};
    reviews.forEach(r => { byUser[r.user?.login] = r.state; });
    reviewSummary = Object.entries(byUser).map(([u, s]) => `@${u}: ${s}`).join(', ');
  }

  return {
    ok: true,
    pr: { number: data.number, title: data.title, state: data.state, body: data.body, url: data.html_url, user: data.user?.login },
    reviews,
    reviewSummary,
    display: `#${data.number}: ${data.title}\n${data.body || ''}\n\nState: ${data.state}\nReviews: ${reviewSummary}\nURL: ${data.html_url}`,
  };
}

async function prMerge(args) {
  const token = getToken();
  const { owner, repoName, num } = parsePRRef(args[0], DEFAULT_REPO);

  // Check approval count
  const reviews = await apiRequest('GET', `/repos/${owner}/${repoName}/pulls/${num}/reviews`, token);
  const approvals = reviews.filter(r => r.state === 'APPROVED').length;
  if (approvals < APPROVAL_COUNT) {
    throw new Error(`Not enough approvals: ${approvals}/${APPROVAL_COUNT}. Need ${APPROVAL_COUNT - approvals} more.`);
  }

  // Check if mergeable
  const pr = await apiRequest('GET', `/repos/${owner}/${repoName}/pulls/${num}`, token);
  if (pr.state !== 'open') throw new Error('PR is not open');

  const data = await apiRequest('PUT', `/repos/${owner}/${repoName}/pulls/${num}/merge`, token, {
    commit_title: `Merge pull request #${num} from ${pr.head?.label || 'branch'}`,
    commit_message: pr.title,
    merge_method: 'squash', // default to squash
  });

  return { ok: true, merged: data.merged, message: data.message || `PR #${num} merged`, url: pr.html_url };
}

// --- Review commands ---
async function reviewClaim(args) {
  const token = getToken();
  const prRef = args[0];
  const { owner, repoName, num } = parsePRRef(prRef, DEFAULT_REPO);

  // Add 👀 reaction to PR body as claim
  const pr = await apiRequest('GET', `/repos/${owner}/${repoName}/pulls/${num}`, token);

  // Check if already claimed by someone else
  const comments = await apiRequest('GET', `/repos/${owner}/${repoName}/issues/${num}/comments`, token);
  const myLogin = await getMyLogin(token);
  const existingClaim = comments.find(c => c.user?.login !== myLogin && c.body?.includes('👀'));

  if (existingClaim) {
    return { ok: true, claimed: false, message: `Already claimed by @${existingClaim.user?.login}`, by: existingClaim.user?.login };
  }

  // Post claim comment
  const comment = await apiRequest('POST', `/repos/${owner}/${repoName}/issues/${num}/comments`, token, {
    body: `👀 **Review claimed** by @${myLogin} — I'm on it!\n\n_Emoji protocol: 👀 = in progress, ✅ = done/approvable, ❌ = needs changes_`,
  });

  return { ok: true, claimed: true, comment: comment.html_url, by: myLogin };
}

async function reviewDone(args) {
  const token = getToken();
  const prRef = args[0];
  const verdict = args[1] || 'approved'; // approved or changes
  const { owner, repoName, num } = parsePRRef(prRef, DEFAULT_REPO);

  const myLogin = await getMyLogin(token);
  const emoji = verdict === 'approved' || verdict === 'approve' || verdict === 'approved' ? '✅' : '❌';
  const verdictText = verdict === 'approved' || verdict === 'approve' ? 'approves' : 'requests changes';

  // Remove my 👀 claim and post verdict
  const comments = await apiRequest('GET', `/repos/${owner}/${repoName}/issues/${num}/comments`, token);
  for (const c of comments) {
    if (c.user?.login === myLogin && c.body?.includes('👀')) {
      // Delete the claim comment
      await apiRequest('DELETE', `/repos/${owner}/${repoName}/issues/comments/${c.id}`, token);
      break;
    }
  }

  const comment = await apiRequest('POST', `/repos/${owner}/${repoName}/issues/${num}/comments`, token, {
    body: `${emoji} **Review complete** by @${myLogin} — ${verdictText}\n\n_Emoji: ✅ = can merge, ❌ = needs changes_`,
  });

  // Submit review
  const reviewState = verdict === 'approved' || verdict === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED';
  await apiRequest('POST', `/repos/${owner}/${repoName}/pulls/${num}/reviews`, token, {
    body: `${emoji} ${verdictText.charAt(0).toUpperCase() + verdictText.slice(1)}`,
    event: reviewState,
  });

  return { ok: true, verdict, comment: comment.html_url, by: myLogin };
}

async function reviewList(args) {
  const token = getToken();
  const repo = DEFAULT_REPO;
  if (!repo) throw new Error('GITHUB_REPO not set');
  const [owner, repoName] = repo.split('/');

  const params = new URLSearchParams({ state: 'open', per_page: '30', sort: 'updated', direction: 'desc' });
  const prs = await apiRequest('GET', `/repos/${owner}/${repoName}/pulls?${params}`, token);

  const myLogin = await getMyLogin(token);
  const pending = [];
  const ready = [];

  for (const pr of prs) {
    const reviews = await apiRequest('GET', `/repos/${owner}/${repoName}/pulls/${pr.number}/reviews`, token);
    const comments = await apiRequest('GET', `/repos/${owner}/${repoName}/issues/${pr.number}/comments`, token);

    // Check for 👀 claims by others
    const claims = comments.filter(c => c.body?.includes('👀') && c.user?.login !== myLogin);
    const myClaim = comments.find(c => c.body?.includes('👀') && c.user?.login === myLogin);

    // Check approval count
    const approvals = reviews.filter(r => r.state === 'APPROVED').length;
    const approved = approvals >= APPROVAL_COUNT;

    if (approved) {
      ready.push({ number: pr.number, title: pr.title, url: pr.html_url, approvals, claimedBy: claims.map(c => c.user?.login) });
    } else {
      pending.push({
        number: pr.number, title: pr.title, url: pr.html_url,
        approvals, needed: APPROVAL_COUNT - approvals,
        claimed: claims.length > 0, claimedBy: claims.map(c => c.user?.login),
        myClaim: !!myClaim,
      });
    }
  }

  let display = '## Ready to Merge\n';
  if (ready.length) {
    ready.forEach(pr => { display += `[#${pr.number}] ${pr.title} ✅ (${pr.approvals}/${APPROVAL_COUNT})\n`; });
  } else { display += 'None\n'; }

  display += '\n## Pending Review\n';
  if (pending.length) {
    pending.forEach(pr => {
      display += `[#${pr.number}] ${pr.title} ${pr.claimed ? '👀 by @'+pr.claimedBy.join(',@') : ''} (${pr.approvals}/${pr.needed} more needed)\n`;
    });
  } else { display += 'None\n'; }

  return { ok: true, pending, ready, display };
}

async function getMyLogin(token) {
  const me = await apiRequest('GET', '/user', token);
  return me.login;
}

// --- Poll command (for cron) ---
async function poll(args) {
  const token = getToken();
  const repo = DEFAULT_REPO;
  if (!repo) return { ok: false, error: 'GITHUB_REPO not set' };
  const [owner, repoName] = repo.split('/');
  const myLogin = await getMyLogin(token);

  const results = { newIssues: [], claimedPRs: [], mergeReady: [] };

  // 1. New issues
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const issues = await apiRequest('GET', `/repos/${owner}/${repoName}/issues?since=${since}&state=open&per_page=20`, token);
  results.newIssues = issues.filter(i => !i.pull_request && !i.title?.startsWith('[cron]'));

  // 2. Open PRs - check for unclaimed ones
  const prs = await apiRequest('GET', `/repos/${owner}/${repoName}/pulls?state=open&per_page=30`, token);
  for (const pr of prs) {
    if (pr.user?.login === myLogin) continue; // skip my own PRs
    const reviews = await apiRequest('GET', `/repos/${owner}/${repoName}/pulls/${pr.number}/reviews`, token);
    const comments = await apiRequest('GET', `/repos/${owner}/${repoName}/issues/${pr.number}/comments`, token);
    const approvals = reviews.filter(r => r.state === 'APPROVED').length;
    const hasClaim = comments.some(c => c.body?.includes('👀') && c.user?.login !== myLogin);

    if (!hasClaim) {
      results.claimedPRs.push({ number: pr.number, title: pr.title, url: pr.html_url, by: pr.user?.login });
    }
    if (approvals >= APPROVAL_COUNT) {
      results.mergeReady.push({ number: pr.number, title: pr.title, url: pr.html_url });
    }
  }

  let display = '## Poll Results\n';
  if (results.newIssues.length) {
    display += `\n🆕 New Issues (last 24h):\n`;
    results.newIssues.forEach(i => { display += `  [#${i.number}] ${i.title}\n`; });
  }
  if (results.claimedPRs.length) {
    display += `\n👀 Unclaimed PRs (ready to review):\n`;
    results.claimedPRs.forEach(pr => { display += `  [#${pr.number}] ${pr.title} by @${pr.by}\n`; });
  }
  if (results.mergeReady.length) {
    display += `\n✅ Merge Ready (approved, waiting for Product Owner):\n`;
    results.mergeReady.forEach(pr => { display += `  [#${pr.number}] ${pr.title}\n`; });
  }
  if (!results.newIssues.length && !results.claimedPRs.length && !results.mergeReady.length) {
    display += '\nNothing new.\n';
  }

  return { ok: true, ...results, display };
}

// --- Utility ---
function parseArgs(args) {
  const opts = {};
  for (const arg of args) {
    const m = arg.match(/^--([a-zA-Z0-9-]+)(?:=(.+))?$/);
    if (m) {
      opts[m[1]] = m[2] !== undefined ? m[2] : true;
    } else {
      if (!opts._) opts._ = [];
      opts._.push(arg);
    }
  }
  return opts;
}

function parsePRRef(ref, defaultRepo) {
  // Accept: "123", "#123", "owner/repo#123", "https://github.com/owner/repo/pull/123"
  let owner, repoName, num;
  if (ref.includes('github.com')) {
    const m = ref.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (m) { owner = m[1]; repoName = m[2]; num = parseInt(m[3], 10); }
  } else if (ref.includes('#')) {
    const [r, n] = ref.split('#');
    [owner, repoName] = r.split('/');
    num = parseInt(n, 10);
  } else {
    num = parseInt(ref, 10);
    if (defaultRepo) { [owner, repoName] = defaultRepo.split('/'); }
  }
  if (!owner || !repoName || isNaN(num)) throw new Error(`Invalid PR reference: ${ref}`);
  return { owner, repoName, num };
}

// --- Dispatch ---
async function main() {
  const input = process.argv[2] || '';
  const parts = input.trim().split(/\s+/).filter(Boolean);
  const subcommand = parts[0] || '';
  const args = parts.slice(1);

  let result;
  try {
    switch (subcommand) {
      case 'auth':
        result = await deviceFlow();
        break;
      case 'issue':
        switch (args[0]) {
          case 'new': result = await issueNew(args.slice(1)); break;
          case 'list': result = await issueList(args.slice(1)); break;
          case 'show': result = await issueShow(args.slice(1)); break;
          case 'update': result = await issueUpdate(args.slice(1)); break;
          default: throw new Error('Unknown issue subcommand. Use: new, list, show, update');
        }
        break;
      case 'branch':
        switch (args[0]) {
          case 'new': result = await branchNew(args.slice(1)); break;
          case 'list': result = await branchList(args.slice(1)); break;
          default: throw new Error('Unknown branch subcommand. Use: new, list');
        }
        break;
      case 'pr':
        switch (args[0]) {
          case 'new': result = await prNew(args.slice(1)); break;
          case 'list': result = await prList(args.slice(1)); break;
          case 'show': result = await prShow(args.slice(1)); break;
          case 'merge': result = await prMerge(args.slice(1)); break;
          default: throw new Error('Unknown pr subcommand. Use: new, list, show, merge');
        }
        break;
      case 'review':
        switch (args[0]) {
          case 'claim': result = await reviewClaim(args.slice(1)); break;
          case 'done': result = await reviewDone(args.slice(1)); break;
          case 'list': result = await reviewList(args.slice(1)); break;
          default: throw new Error('Unknown review subcommand. Use: claim, done, list');
        }
        break;
      case 'poll':
        result = await poll(args);
        break;
      case 'whoami':
        result = { login: await getMyLogin(getToken()) };
        break;
      default:
        throw new Error(`Unknown command: ${subcommand}. Use: auth, issue, branch, pr, review, poll`);
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

main();
