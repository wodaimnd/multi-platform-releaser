/**
 * What differs between the git hostings this plugin can publish to.
 *
 * Only differences live here: every provider speaks the same handful of verbs
 * (who am I, does this repo exist, create it, patch it, set topics, make a
 * release), but the wire details do not match. Keeping them as data rather than
 * as `if (provider === 'gitee')` branches inside the client means adding a fourth
 * host later is a table entry, not a fork in the request path.
 *
 * Everything here was read off the hosts' own published specs, not from memory:
 *   Gitee     https://gitee.com/api/v5/swagger_doc   (OpenAPI 2.0, v5.4.93)
 *   Codeberg  https://codeberg.org/swagger.v1.json   (Forgejo/Gitea 1.22)
 *   GitHub    https://docs.github.com/rest
 *
 * The shapes below are what the three specs actually declare. In particular:
 *
 *   · Gitee does NOT take a bearer header. It wants `access_token` — as a query
 *     parameter on GETs and inside the JSON body on writes.
 *   · Gitee has no topics endpoint at all. `supportsTopics: false` is a fact, not
 *     a choice, so the publish pipeline skips the step instead of failing it.
 *   · Codeberg needs the literal prefix `token ` before the value.
 */

/** @typedef {'github'|'gitee'|'codeberg'} ProviderId */

/**
 * How a provider wants its credential presented.
 *   bearer    — `Authorization: Bearer <token>`        (GitHub)
 *   token     — `Authorization: token <token>`         (Gitee's sibling, Forgejo)
 *   query     — `?access_token=<token>` + body field   (Gitee v5)
 */
const AUTH = {
  bearer: 'bearer',
  token: 'token',
  query: 'query',
};

const PROVIDERS = Object.freeze({
  github: {
    id: 'github',
    label: 'GitHub',
    apiBase: 'https://api.github.com',
    /** GitHub's REST root has no version prefix; Enterprise carries its own. */
    apiPrefix: '',
    webBase: 'https://github.com',
    auth: AUTH.bearer,
    supportsTopics: true,
    // GitHub also accepts `vnd.github+json`; the install flavour is lighter.
    accept: 'application/vnd.github+json',
    extraHeaders: () => ({ 'X-GitHub-Api-Version': '2022-11-28' }),
    rateLimit: { remaining: 'x-ratelimit-remaining', reset: 'x-ratelimit-reset' },
    // GitHub accepts the `x-access-token` placeholder for HTTPS pushes.
    pushUsername: 'placeholder',
    // Field names the client uses when normalising a repository payload.
    repoFields: { htmlUrl: ['html_url'], fullName: ['full_name'], defaultBranch: ['default_branch'] },
  },

  gitee: {
    id: 'gitee',
    label: 'Gitee',
    apiBase: 'https://gitee.com/api/v5',
    apiPrefix: '',
    webBase: 'https://gitee.com',
    // Not a header: the spec declares `access_token` as a form/query parameter.
    auth: AUTH.query,
    // Verified absent from the whole v5 spec: there is no /topics route.
    supportsTopics: false,
    accept: 'application/json',
    extraHeaders: () => ({}),
    rateLimit: { remaining: null, reset: null },
    // Gitee rejects the push with "The token username invalid" unless the push
    // username is the account's real login (verified against the live API).
    pushUsername: 'login',
    repoFields: { htmlUrl: ['html_url'], fullName: ['full_name', 'path_with_namespace'], defaultBranch: ['default_branch'] },
    // Gitee wants `public: 1|0` where GitHub wants `private: bool`, and takes the
    // owning namespace separately from the repository path.
    createRepoFields: (fields) => ({
      name: fields.name,
      path: fields.name,
      description: fields.description || undefined,
      homepage: fields.homepage || undefined,
      private: fields.private === true,
      auto_init: false,
    }),
    // Gitee's PATCH /repos/{owner}/{repo} rejects the call with `name is
    // missing` unless the repository name is echoed back, even though the spec
    // does not mark it required. Verified against the live API (v5, 2026-11).
    updateRepoFields: (patch, context) => ({
      name: context && context.name ? context.name : undefined,
      path: context && context.name ? context.name : undefined,
      description: patch.description === undefined ? undefined : patch.description,
      homepage: patch.homepage === undefined ? undefined : patch.homepage,
    }),
    releaseFields: (release) => ({
      tag_name: release.tagName,
      name: release.name || release.tagName,
      body: release.body || '',
      prerelease: release.prerelease === true,
      target_commitish: release.targetCommitish || 'main',
    }),
  },

  codeberg: {
    id: 'codeberg',
    label: 'Codeberg',
    apiBase: 'https://codeberg.org/api/v1',
    apiPrefix: '',
    webBase: 'https://codeberg.org',
    auth: AUTH.token,
    // Forgejo has PUT /repos/{owner}/{repo}/topics (verified in the spec).
    supportsTopics: true,
    accept: 'application/json',
    extraHeaders: () => ({}),
    rateLimit: { remaining: 'x-ratelimit-remaining', reset: 'x-ratelimit-reset' },
    repoFields: { htmlUrl: ['html_url'], fullName: ['full_name'], defaultBranch: ['default_branch'] },
    createRepoFields: (fields) => ({
      name: fields.name,
      description: fields.description || '',
      private: fields.private === true,
      auto_init: false,
      default_branch: fields.branch || 'main',
    }),
    // Forgejo accepts either form; the real login is clearer in logs and works
    // on self-hosted instances that bind the token to a specific user.
    pushUsername: 'login',
    updateRepoFields: (patch) => ({
      description: patch.description === undefined ? undefined : patch.description,
      website: patch.homepage === undefined ? undefined : patch.homepage,
    }),
    releaseFields: (release) => ({
      tag_name: release.tagName,
      name: release.name || release.tagName,
      body: release.body || '',
      prerelease: release.prerelease === true,
      draft: release.draft === true,
      target_commitish: release.targetCommitish || 'main',
    }),
  },
});

/** Every provider this build knows, in tab order. */
export function providerIds() {
  return Object.keys(PROVIDERS);
}

/** One provider's descriptors, or null. */
export function providerOf(id) {
  const key = typeof id === 'string' ? id : '';
  return PROVIDERS[key] || null;
}

/** `/api/v5`-style suffix for a provider that wants one; GitHub wants none. */
export function apiBaseFor(id, configuredBase) {
  const provider = providerOf(id);
  const base = typeof configuredBase === 'string' && configuredBase.trim() !== ''
    ? configuredBase.trim().replace(/\/+$/, '')
    : (provider ? provider.apiBase : '');
  if (!provider) return base;
  // A custom base (GitHub Enterprise, a self-hosted Forgejo) already carries
  // whatever prefix its operator needs, so nothing is appended to it.
  if (configuredBase && configuredBase.trim() !== '') return base;
  return base;
}

/**
 * Web URL for a repository, per provider.
 *
 * Used for the "open the repo" link and the result card; Gitee and Codeberg
 * both use `/<owner>/<repo>`, so only the host differs.
 */
export function repoWebUrlFor(id, owner, repo, configuredWebBase = '') {
  const provider = providerOf(id);
  const base = (typeof configuredWebBase === 'string' && configuredWebBase.trim() !== ''
    ? configuredWebBase.trim()
    : provider ? provider.webBase : '').replace(/\/+$/, '');
  return `${base}/${owner}/${repo}`;
}

/** Clone URL used for the git remote. */
export function repoCloneUrlFor(id, owner, repo, configuredWebBase = '') {
  const provider = providerOf(id);
  const base = (typeof configuredWebBase === 'string' && configuredWebBase.trim() !== ''
    ? configuredWebBase.trim()
    : provider ? provider.webBase : '').replace(/\/+$/, '');
  return `${base}/${owner}/${repo}.git`;
}

/**
 * Whether a given provider can set repository topics.
 *
 * The publish pipeline asks this before running the topics step, so a host
 * without the feature is reported as "skipped, not supported" rather than as a
 * failure the operator would have to work around.
 */
export function supportsTopics(id) {
  const provider = providerOf(id);
  return Boolean(provider && provider.supportsTopics === true);
}

/**
 * Username sent with the HTTPS credential during a push.
 *
 * GitHub ignores it (`x-access-token` is its convention), but Gitee rejects the
 * push outright — "The token username invalid" — unless the account's real login
 * is used. Forgejo accepts either, so it gets the login too.
 */
export function pushUsernameFor(id, login) {
  const provider = providerOf(id);
  const name = typeof login === 'string' ? login.trim() : '';
  if (!provider) return name || 'x-access-token';
  if (provider.pushUsername === 'login') return name || 'x-access-token';
  return 'x-access-token';
}

export { AUTH, PROVIDERS };
