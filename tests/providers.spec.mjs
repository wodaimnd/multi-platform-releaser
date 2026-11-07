// dsh-github-publisher — multi-hosting provider contract (CONTRACT §6.2).
//
// One transport serves GitHub, Gitee and Codeberg; `lib/providers.mjs` holds
// what differs. This file pins those differences so a "harmless" refactor
// cannot quietly send a Bearer header to Gitee (which wants `access_token`),
// or hand Forgejo `homepage` (which it calls `website`).
//
// Every expectation below was observed against the hosts' own specs and, where
// marked, their live APIs — not inferred from GitHub's behaviour.
//
// Run: node tests/providers.spec.mjs

import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';

import { GitHubClient } from '../lib/github.mjs';
import {
  providerIds,
  providerOf,
  supportsTopics,
  pushUsernameFor,
  repoWebUrlFor,
  repoCloneUrlFor,
  apiBaseFor,
} from '../lib/providers.mjs';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error?.message || String(error) });
  }
}

/* ── mock hosting: records exactly what the client sent ─────────────────────── */

const requests = [];
let handler = null;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const record = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(record);
    const reply = handler ? handler(record) : { status: 200, json: { login: 'probe' } };
    res.statusCode = reply.status || 200;
    res.setHeader('content-type', 'application/json');
    res.end(typeof reply.text === 'string' ? reply.text : JSON.stringify(reply.json ?? {}));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function reset() {
  requests.length = 0;
  handler = null;
}

/* ── registry data ─────────────────────────────────────────────────────────── */

await test('the registry knows all three hostings and their ordering', async () => {
  assert.deepEqual(providerIds().sort(), ['codeberg', 'gitee', 'github']);
  assert.equal(providerOf('gitee').label, 'Gitee');
  assert.equal(providerOf('codeberg').label, 'Codeberg');
  assert.equal(providerOf('nope'), null);
});

await test('Gitee declares no topics support; the others do', async () => {
  // Verified against the live v5 spec: there is no /topics route at all.
  assert.equal(supportsTopics('gitee'), false);
  assert.equal(supportsTopics('github'), true);
  assert.equal(supportsTopics('codeberg'), true);
});

await test('repo and clone URLs follow the hosting', async () => {
  assert.equal(repoWebUrlFor('gitee', 'ward-day', 'x'), 'https://gitee.com/ward-day/x');
  assert.equal(repoCloneUrlFor('codeberg', 'Inf', 'x'), 'https://codeberg.org/Inf/x.git');
  assert.equal(repoWebUrlFor('github', 'o', 'r'), 'https://github.com/o/r');
  // A self-hosted instance overrides the host but keeps the /owner/repo shape.
  assert.equal(repoWebUrlFor('codeberg', 'o', 'r', 'https://git.example.test'), 'https://git.example.test/o/r');
});

await test('push username: GitHub keeps its placeholder, the others need the login', async () => {
  // Gitee rejects the push with "The token username invalid" when given
  // `x-access-token` (verified live); Forgejo accepts either, the login is used.
  assert.equal(pushUsernameFor('github', 'wodaimnd'), 'x-access-token');
  assert.equal(pushUsernameFor('gitee', 'ward-day'), 'ward-day');
  assert.equal(pushUsernameFor('codeberg', 'Inf'), 'Inf');
  assert.equal(pushUsernameFor('gitee', ''), 'x-access-token', 'missing login falls back rather than sending an empty user');
});

await test('apiBaseFor keeps a custom base untouched', async () => {
  assert.equal(apiBaseFor('gitee', ''), 'https://gitee.com/api/v5');
  assert.equal(apiBaseFor('codeberg', ''), 'https://codeberg.org/api/v1');
  assert.equal(apiBaseFor('gitee', 'https://gitee.example.test/api/v5'), 'https://gitee.example.test/api/v5');
});

/* ── wire behaviour ────────────────────────────────────────────────────────── */

await test('GitHub authenticates with a Bearer header', async () => {
  reset();
  const client = new GitHubClient({ apiBase: base, token: 'TOKEN', provider: 'github' });
  await client.getAuthenticatedUser();
  const req = requests[0];
  assert.equal(req.headers.authorization, 'Bearer TOKEN');
  assert.equal(req.url, '/user');
});

await test('Gitee puts the token in the query string, never in a header', async () => {
  reset();
  const client = new GitHubClient({ apiBase: base, token: 'TOKEN', provider: 'gitee' });
  await client.getAuthenticatedUser();
  const req = requests[0];
  assert.equal(req.headers.authorization, undefined, 'Gitee does not take an Authorization header');
  assert.ok(req.url.includes('access_token=TOKEN'), req.url);
});

await test('Gitee puts the token inside the JSON body for writes', async () => {
  reset();
  handler = () => ({ status: 201, json: { full_name: 'p/p', name: 'p', html_url: 'http://x' } });
  const client = new GitHubClient({ apiBase: base, token: 'TOKEN', provider: 'gitee' });
  await client.createRepo({ name: 'p' });
  const body = JSON.parse(requests[0].body);
  assert.equal(body.access_token, 'TOKEN');
});

await test('Codeberg authenticates with the `token` prefix', async () => {
  reset();
  const client = new GitHubClient({ apiBase: base, token: 'TOKEN', provider: 'codeberg' });
  await client.getAuthenticatedUser();
  assert.equal(requests[0].headers.authorization, 'token TOKEN');
});

/* ── payload shapes ────────────────────────────────────────────────────────── */

await test('createRepo sends provider-specific fields', async () => {
  reset();
  handler = () => ({ status: 201, json: { full_name: 'o/r', name: 'r', html_url: 'http://x' } });

  const gh = new GitHubClient({ apiBase: base, token: 'T', provider: 'github' });
  await gh.createRepo({ name: 'r', description: 'd' });
  const ghBody = JSON.parse(requests.at(-1).body);
  assert.equal(ghBody.has_issues, true, 'GitHub takes the issue/wiki flags');
  assert.equal(ghBody.private, false);

  const gitee = new GitHubClient({ apiBase: base, token: 'T', provider: 'gitee' });
  await gitee.createRepo({ name: 'r', private: true });
  const giteeBody = JSON.parse(requests.at(-1).body);
  assert.equal(giteeBody.path, 'r', 'Gitee wants the repo path echoed');
  assert.equal(giteeBody.private, true);
  assert.equal(giteeBody.has_issues, undefined, 'GitHub-only flags must not leak to Gitee');

  const cb = new GitHubClient({ apiBase: base, token: 'T', provider: 'codeberg' });
  await cb.createRepo({ name: 'r', branch: 'trunk' });
  const cbBody = JSON.parse(requests.at(-1).body);
  assert.equal(cbBody.default_branch, 'trunk', 'Forgejo takes the default branch at create time');
});

await test('updateRepo: GitHub uses homepage, Forgejo uses website, Gitee echoes name', async () => {
  reset();
  handler = () => ({ status: 200, json: { full_name: 'o/r', name: 'r', html_url: 'http://x' } });

  const gh = new GitHubClient({ apiBase: base, token: 'T', provider: 'github' });
  await gh.updateRepo('o', 'r', { description: 'd', homepage: 'h' });
  const ghBody = JSON.parse(requests.at(-1).body);
  assert.deepEqual(Object.keys(ghBody).sort(), ['description', 'homepage']);

  const cb = new GitHubClient({ apiBase: base, token: 'T', provider: 'codeberg' });
  await cb.updateRepo('o', 'r', { description: 'd', homepage: 'h' });
  const cbBody = JSON.parse(requests.at(-1).body);
  assert.equal(cbBody.website, 'h', 'Forgejo calls the homepage website');
  assert.equal(cbBody.homepage, undefined);

  const gitee = new GitHubClient({ apiBase: base, token: 'T', provider: 'gitee' });
  await gitee.updateRepo('o', 'r', { description: 'd' });
  const giteeBody = JSON.parse(requests.at(-1).body);
  // Verified live: Gitee answers `{"messages":["name is missing"]}` with HTTP 400
  // unless the name is echoed back, even though the spec does not require it.
  assert.equal(giteeBody.name, 'r');
  assert.equal(giteeBody.path, 'r');
});

await test('setTopics short-circuits on a hosting without topics', async () => {
  reset();
  const gitee = new GitHubClient({ apiBase: base, token: 'T', provider: 'gitee' });
  await assert.rejects(
    () => gitee.setTopics('o', 'r', ['a']),
    (error) => error.code === 'topics-unsupported',
    'Gitee must raise a typed, skippable error and not call the API',
  );
  assert.equal(requests.length, 0, 'no request may be sent for an unsupported feature');
});

await test('setTopics still works where the hosting supports it', async () => {
  reset();
  handler = () => ({ status: 200, json: { names: ['a', 'b'] } });
  const cb = new GitHubClient({ apiBase: base, token: 'T', provider: 'codeberg' });
  const names = await cb.setTopics('o', 'r', ['a', 'b']);
  assert.deepEqual(names, ['a', 'b']);
});

await test('createRelease carries provider-specific release fields', async () => {
  reset();
  handler = () => ({ status: 201, json: { id: 1, tag_name: 'v1' } });

  const gh = new GitHubClient({ apiBase: base, token: 'T', provider: 'github' });
  await gh.createRelease('o', 'r', { tagName: 'v1', body: 'b' });
  const ghBody = JSON.parse(requests.at(-1).body);
  assert.equal(ghBody.draft, false, 'GitHub takes draft');

  const gitee = new GitHubClient({ apiBase: base, token: 'T', provider: 'gitee' });
  await gitee.createRelease('o', 'r', { tagName: 'v1', body: 'b', targetCommitish: 'master' });
  const giteeBody = JSON.parse(requests.at(-1).body);
  assert.equal(giteeBody.target_commitish, 'master', 'Gitee requires target_commitish');
  assert.equal(giteeBody.draft, undefined, 'Gitee has no draft');

  const cb = new GitHubClient({ apiBase: base, token: 'T', provider: 'codeberg' });
  await cb.createRelease('o', 'r', { tagName: 'v1', body: 'b', targetCommitish: 'main' });
  const cbBody = JSON.parse(requests.at(-1).body);
  assert.equal(cbBody.target_commitish, 'main');
  assert.equal(cbBody.draft, false);
});

await test('releaseUrl composes a page for a hosting that returns none', async () => {
  reset();
  // Verified live: Gitee's release payload is
  // `id, tag_name, target_commitish, prerelease, name, body, author, created_at, assets`
  // — no URL field at all.
  const gitee = new GitHubClient({ apiBase: base, token: 'T', provider: 'gitee' });
  assert.equal(
    gitee.releaseUrl('ward-day', 'probe', { id: 1, tag_name: 'v0.1.0' }),
    'https://gitee.com/ward-day/probe/releases/tag/v0.1.0',
  );
  // Where the hosting does return one, it wins.
  const cb = new GitHubClient({ apiBase: base, token: 'T', provider: 'codeberg' });
  assert.equal(
    cb.releaseUrl('o', 'r', { html_url: 'https://codeberg.org/o/r/releases/tag/v1' }, 'v1'),
    'https://codeberg.org/o/r/releases/tag/v1',
  );
  const gh = new GitHubClient({ apiBase: base, token: 'T', provider: 'github' });
  assert.equal(gh.releaseUrl('o', 'r', {}, 'v1'), 'https://github.com/o/r/releases/tag/v1');
});

/* ── normalisation ─────────────────────────────────────────────────────────── */

await test('indexRepoFields fixes Gitee owner and web URL (verified live)', async () => {
  reset();
  // Gitee returns `owner.login = mirrors_admin` (an internal id) and
  // `html_url = https://gitee.com/mirrors/x.git` (a clone URL, not a page).
  const payload = {
    full_name: 'mirrors/spring-boot',
    name: 'spring-boot',
    path: 'spring-boot',
    html_url: 'https://gitee.com/mirrors/spring-boot.git',
    default_branch: 'main',
    owner: { login: 'mirrors_admin' },
  };
  handler = () => ({ status: 200, json: payload });
  const gitee = new GitHubClient({ apiBase: base, token: 'T', provider: 'gitee' });
  const repo = await gitee.getRepo('mirrors', 'spring-boot');
  assert.equal(repo.owner, 'mirrors', 'the namespace, not the internal id');
  assert.equal(repo.htmlUrl, 'https://gitee.com/mirrors/spring-boot', 'no .git suffix on a web link');
});

await test('indexRepoFields leaves GitHub alone', async () => {
  const { indexRepoFields } = await import('../lib/github.mjs');
  const repo = indexRepoFields({
    full_name: 'octocat/Hello-World',
    name: 'Hello-World',
    html_url: 'https://github.com/octocat/Hello-World',
    owner: { login: 'octocat' },
    default_branch: 'master',
  }, 'github');
  assert.equal(repo.owner, 'octocat');
  assert.equal(repo.htmlUrl, 'https://github.com/octocat/Hello-World');
});

await test('the client defaults to GitHub when no provider is given', async () => {
  reset();
  const client = new GitHubClient({ apiBase: base, token: 'T' });
  assert.equal(client.provider, 'github');
  await client.getAuthenticatedUser();
  assert.equal(requests[0].headers.authorization, 'Bearer T');
});

/* ── report ───────────────────────────────────────────────────────────────── */

server.close();

let failed = 0;
for (const row of results) {
  if (!row.ok) failed += 1;
  console.log(`${row.ok ? 'PASS  ' : 'FAIL  '}${row.name}${row.ok || !row.error ? '' : ' — ' + row.error}`);
}
console.log('');
console.log(`${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exitCode = 1;
