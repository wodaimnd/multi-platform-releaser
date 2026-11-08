// dsh-github-publisher — Host REST client for the git hostings we publish to
// (CONTRACT §6.2).
//
// Pure ESM, global `fetch` only (no third-party dependencies). The transport is
// shared by GitHub, Gitee and Codeberg/Forgejo; what differs between them lives
// in `providers.mjs` as data, and this class reads that descriptor. Calling it
// `GitHubClient` is historical — it still defaults to GitHub, which is why the
// original GitHub behaviour and tests are unchanged.
//
// Error messages are user facing (Chinese) and never contain the token: every
// message / response snippet goes through `_scrub()` before leaving the class.

import { providerOf } from './providers.mjs';

const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'dsh-github-publisher/0.4.1';
const API_VERSION = '2022-11-28';
const DEFAULT_TIMEOUT_MS = 20_000;
// GET is retried twice: after 300 ms and after 900 ms.
const RETRY_BACKOFF_MS = [300, 900];
const MAX_RESPONSE_TEXT = 4_000;

const SCOPE_HINT =
  'classic PAT 需要 repo 权限；fine-grained PAT 需要 Contents: read/write、Administration: read/write、Metadata: read。';

/** Error thrown by every GitHubClient method. `message` is safe to show to users. */
export class GitHubError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, details?: object|null,
   *          responseText?: string, rateLimitReset?: number|null}} [options]
   */
  constructor(
    message,
    { status = 0, code = 'github-http', details = null, responseText = '', rateLimitReset = null } = {},
  ) {
    super(String(message));
    this.name = 'GitHubError';
    this.status = typeof status === 'number' ? status : 0;
    this.code = code;
    this.details = details && typeof details === 'object' ? details : null;
    this.responseText = typeof responseText === 'string' ? responseText : '';
    this.rateLimitReset = Number.isFinite(rateLimitReset) ? rateLimitReset : null;
  }
}

function makeAbortedError(method = 'GET', pathLabel = '') {
  const suffix = pathLabel ? `（${method} ${pathLabel}）` : '';
  const error = new GitHubError(`GitHub API 请求已取消${suffix}`, {
    code: 'github-aborted',
    status: 0,
    details: { method, path: pathLabel },
  });
  // Allow both conventional abort checks and the contract-style error code.
  error.name = 'AbortError';
  error.aborted = true;
  return error;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeApiBase(base) {
  if (typeof base !== 'string' || base.trim() === '') return DEFAULT_API_BASE;
  return base.trim().replace(/\/+$/, '');
}

function joinApiPath(base, apiPath) {
  const raw = typeof apiPath === 'string' ? apiPath.trim() : '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const suffix = raw.replace(/^\/+/, '');
  return suffix ? `${base}/${suffix}` : base;
}

function pathLabel(apiPath) {
  const raw = typeof apiPath === 'string' ? apiPath.trim() : String(apiPath ?? '');
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return `${url.pathname}${url.search}`;
    } catch {
      return raw;
    }
  }
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function encodePart(value) {
  return encodeURIComponent(String(value ?? '').trim());
}

function truncate(text, max = MAX_RESPONSE_TEXT) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resetAtFromHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const raw = headers.get('x-ratelimit-reset');
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function combineSignals(signals) {
  const list = (Array.isArray(signals) ? signals : []).filter(Boolean);
  if (list.length === 0) return { signal: null, dispose() {} };
  if (list.length === 1) return { signal: list[0], dispose() {} };
  const controller = new AbortController();
  const cleanups = [];
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Public URL / payload helpers
// ---------------------------------------------------------------------------

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

/**
 * Parse a git remote URL into `{ host, owner, repo, isGitHub }`.
 * Supports https(s), ssh://, git:// and scp-like (`git@github.com:owner/repo.git`).
 * Returns null when the value cannot be parsed as a git remote.
 *
 * @param {string} url
 * @returns {{host: string, owner: string, repo: string, isGitHub: boolean}|null}
 */
export function parseRemoteUrl(url) {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;

  let host = null;
  let pathname = null;

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    try {
      const parsed = new URL(raw);
      const protocol = parsed.protocol.toLowerCase();
      if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:'].includes(protocol)) return null;
      host = parsed.hostname;
      pathname = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    // scp-like syntax: [user@]host:path
    const match = /^(?:[^@\s/]+@)?([^:\s/]+):(.+)$/.exec(raw);
    if (!match) return null;
    host = match[1];
    pathname = match[2];
  }

  if (!host || !pathname) return null;

  let clean = pathname.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (/\.git$/i.test(clean)) clean = clean.slice(0, -4);
  if (!clean) return null;

  const segments = clean.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const normalizedHost = host.toLowerCase();
  const isGitHub = GITHUB_HOSTS.has(normalizedHost);
  // GitHub remotes always look like /owner/repo — extra segments are not a repo remote.
  if (isGitHub && segments.length !== 2) return null;

  const repo = segments[segments.length - 1];
  const owner = segments.slice(0, -1).join('/');
  if (!repo || !owner) return null;

  return { host: normalizedHost, owner, repo, isGitHub };
}

/**
 * Map a GitHub repository JSON payload to the UI/engine friendly shape.
 * Unknown / missing fields are normalised to empty strings / 0 / [].
 *
 * @param {object} repo
 * @returns {{fullName: string, name: string, owner: string, htmlUrl: string,
 *            cloneUrl: string, sshUrl: string, defaultBranch: string,
 *            private: boolean, description: string, homepage: string,
 *            permissions: {admin: boolean, push: boolean, pull: boolean}|null,
 *            stars: number, topics: string[], version: string}}
 */
export function indexRepoFields(repo, provider = 'github') {
  const source = repo && typeof repo === 'object' ? repo : {};
  const ownerObject = source.owner && typeof source.owner === 'object' ? source.owner : null;
  // Gitee puts an internal account id here (`mirrors_admin` for the `mirrors`
  // namespace) rather than the namespace itself. `full_name` always carries the
  // real `owner/repo`, so that is the trustworthy source for Gitee.
  const fullName = typeof source.full_name === 'string' ? source.full_name : '';
  const ownerFromFullName = provider === 'gitee' && fullName.includes('/')
    ? fullName.slice(0, fullName.indexOf('/'))
    : '';
  const owner =
    ownerFromFullName
    || (ownerObject && typeof ownerObject.login === 'string'
      ? ownerObject.login
      : typeof source.owner === 'string'
        ? source.owner
        : '');
  // Gitee's `html_url` is the *clone* URL (`https://gitee.com/mirrors/x.git`), so
  // using it as the "open the repository" link lands on a 404. Its web page is
  // the namespace plus the repo path, and `path` (not `name`) is what the spec
  // returns for the slug.
  const rawHtmlUrl = typeof source.html_url === 'string' ? source.html_url : '';
  const htmlUrl = provider === 'gitee'
    ? (fullName
        ? 'https://gitee.com/' + fullName
        : rawHtmlUrl.replace(/\.git$/, ''))
    : rawHtmlUrl;
  const version =
    typeof source.version === 'string'
      ? source.version
      : typeof source.latest_release?.tag_name === 'string'
        ? source.latest_release.tag_name
        : typeof source.release?.tag_name === 'string'
          ? source.release.tag_name
          : '';
  return {
    fullName,
    name: typeof source.name === 'string' ? source.name : '',
    owner,
    htmlUrl,
    cloneUrl: typeof source.clone_url === 'string' ? source.clone_url : '',
    sshUrl: typeof source.ssh_url === 'string' ? source.ssh_url : '',
    defaultBranch: typeof source.default_branch === 'string' ? source.default_branch : '',
    private: source.private === true || source.public === false,
    description: typeof source.description === 'string' ? source.description : '',
    homepage: typeof source.homepage === 'string' ? source.homepage : '',
    permissions: source.permissions && typeof source.permissions === 'object'
      ? {
          admin: source.permissions.admin === true,
          push: source.permissions.push === true,
          pull: source.permissions.pull === true,
        }
      : null,
    // Gitee names it `stargazers_count` too, but exposes it as a nested object on
    // some endpoints; either shape resolves to a number or zero.
    stars: Number.isFinite(Number(source.stargazers_count)) ? Number(source.stargazers_count) : 0,
    topics: Array.isArray(source.topics)
      ? source.topics.map((topic) => (typeof topic === 'string' ? topic : String(topic?.name ?? ''))).filter(Boolean)
      : [],
    version,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GitHubClient {
  /**
   * @param {{apiBase?: string, token?: string|null, userAgent?: string,
   *          signal?: AbortSignal|null, timeoutMs?: number,
   *          fetchImpl?: typeof fetch, login?: string|null}} [options]
   *   `login` is an optional extension: when the caller already knows the
   *   authenticated login it can be supplied to avoid one `GET /user`.
   */
  constructor({
    apiBase = DEFAULT_API_BASE,
    token = null,
    userAgent = DEFAULT_USER_AGENT,
    signal = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    login = null,
    provider = 'github',
  } = {}) {
    this._apiBase = normalizeApiBase(apiBase);
    this.token = typeof token === 'string' && token.trim() !== '' ? token.trim() : null;
    this.userAgent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : DEFAULT_USER_AGENT;
    this.signal = signal || null;
    this.timeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
    this._login = typeof login === 'string' && login.trim() ? login.trim() : null;
    // Defaults to GitHub, so every existing caller and test keeps its behaviour.
    this._provider = providerOf(provider) || providerOf('github');
  }

  /** Which hosting this client talks to (`github` / `gitee` / `codeberg`). */
  get provider() {
    return this._provider.id;
  }

  /** Whether this hosting has a topics feature at all (Gitee does not). */
  get supportsTopics() {
    return this._provider.supportsTopics === true;
  }

  get apiBase() {
    return this._apiBase;
  }

  /** Authenticated login, when already known (from a previous `/user` call). */
  get login() {
    return this._login;
  }

  // -- request plumbing -----------------------------------------------------

  _scrub(text) {
    if (text === null || text === undefined) return '';
    let out = typeof text === 'string' ? text : String(text);
    if (this.token) out = out.split(this.token).join('***');
    out = out
      .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '***')
      .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '***')
      .replace(/(\/\/[^/@\s:]+:)[^/@\s]+(@)/g, '$1***$2');
    return out;
  }

  _createError(message, options = {}) {
    const error = new GitHubError(this._scrub(message), options);
    return error;
  }

  async _sleep(ms, signal) {
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(makeAbortedError('GET', '(retry delay)'));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        cleanup();
        reject(makeAbortedError('GET', '(retry delay)'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Perform one API request.
   *
   * @param {string} method
   * @param {string} apiPath e.g. "/user"
   * @param {{body?: object|null, accept?: string|null, signal?: AbortSignal|null,
   *          allow404?: boolean, timeoutMs?: number|null}} [options]
   * @returns {Promise<{status: number, headers: Headers, json: any|null}>}
   * @throws {GitHubError}
   */
  async request(method, apiPath, options = {}) {
    const { body = null, accept = null, signal = null, allow404 = false, timeoutMs = null } = options || {};
    const httpMethod = String(method || 'GET').toUpperCase();
    // Only idempotent GET requests are retried: network failures and 5xx.
    const maxAttempts = httpMethod === 'GET' ? RETRY_BACKOFF_MS.length + 1 : 1;
    const external = combineSignals([this.signal, signal]);
    let lastError = null;
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (attempt > 0) {
          await this._sleep(RETRY_BACKOFF_MS[attempt - 1], external.signal);
        }
        try {
          return await this._requestOnce(httpMethod, apiPath, {
            body,
            accept,
            signal: external.signal,
            allow404,
            timeoutMs,
          });
        } catch (error) {
          lastError = error;
          const retryable = error instanceof GitHubError && error.retryable === true;
          if (!retryable || attempt >= maxAttempts - 1) throw error;
        }
      }
      throw lastError ?? this._createError(`${this._provider.label} API 请求失败（未知错误）`, { code: 'github-http' });
    } finally {
      external.dispose();
    }
  }

  async _requestOnce(method, apiPath, { body, accept, signal, allow404, timeoutMs }) {
    let url = joinApiPath(this.apiBase, apiPath);
    const label = pathLabel(apiPath);
    const effectiveTimeout =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    let externalAborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeout);
    if (typeof timer.unref === 'function') timer.unref();

    const onExternalAbort = () => {
      externalAborted = true;
      controller.abort();
    };
    if (signal) {
      if (signal.aborted) externalAborted = true;
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const headers = {
      Accept: accept || this._provider.accept || 'application/vnd.github+json',
      'User-Agent': this.userAgent || DEFAULT_USER_AGENT,
      ...this._provider.extraHeaders(),
    };
    // Three different ways to present one credential, all read off each host's
    // own spec. GitHub wants a bearer header, Forgejo wants `token <value>`, and
    // Gitee v5 does not accept a header at all — it reads `access_token` from the
    // query string (GET) or the JSON body (writes), which is handled below.
    if (this.token) {
      if (this._provider.auth === 'bearer') headers.Authorization = `Bearer ${this.token}`;
      else if (this._provider.auth === 'token') headers.Authorization = `token ${this.token}`;
    }
    let requestBody;
    if (body !== null && body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(this._provider.auth === 'query' && this.token
        ? { ...body, access_token: this.token }
        : body);
    } else if (this._provider.auth === 'query' && this.token && method === 'GET') {
      // The Gitee spec puts `access_token` in the query for reads; writes carry it
      // in the body above. Without one of the two the call is anonymous.
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}access_token=${encodeURIComponent(this.token)}`;
    }

    let response;
    let responseText = '';
    try {
      if (externalAborted) throw makeAbortedError(method, label);
      if (typeof this.fetchImpl !== 'function') {
        throw this._createError(`当前运行环境没有可用的 fetch 实现，无法访问 ${this._provider.label} API。`, {
          code: 'github-network',
          status: 0,
        });
      }
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: requestBody,
        signal: controller.signal,
        redirect: 'follow',
      });
      responseText = await response.text();
    } catch (cause) {
      if (timedOut) {
        throw this._createError(
          `${this._provider.label} API 请求超时（${effectiveTimeout}ms，${method} ${label}），请检查网络后重试。`,
          {
            code: 'github-timeout',
            status: 0,
            details: { method, path: label, timeoutMs: effectiveTimeout },
          },
        );
      }
      if (externalAborted || cause?.name === 'AbortError' || cause?.code === 'ABORT_ERR') {
        throw makeAbortedError(method, label);
      }
      if (cause instanceof GitHubError) throw cause;
      const networkError = this._createError(
        `无法连接 ${this._provider.label} API（${method} ${label}）：${cause?.message || cause}`,
        { code: 'github-network', status: 0, details: { method, path: label } },
      );
      networkError.retryable = true;
      networkError.cause = cause;
      throw networkError;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }

    const responseHeaders = response.headers;
    let json = null;
    if (responseText) {
      try {
        json = JSON.parse(responseText);
      } catch {
        json = null;
      }
    }

    const status = response.status;
    if (allow404 && status === 404) return { status, headers: responseHeaders, json };
    if (status >= 200 && status < 300) return { status, headers: responseHeaders, json };
    throw this._mapHttpError(method, label, status, responseHeaders, responseText, json);
  }

  _mapHttpError(method, label, status, headers, responseText, json) {
    const safeResponseText = truncate(this._scrub(responseText), MAX_RESPONSE_TEXT);
    const apiMessage = typeof json?.message === 'string' ? this._scrub(json.message) : '';
    const errorsText = json?.errors ? truncate(this._scrub(safeStringify(json.errors)), 1_000) : '';
    const details = {
      method,
      path: label,
      status,
      ...(apiMessage ? { apiMessage } : {}),
      ...(errorsText && errorsText !== apiMessage ? { errors: errorsText } : {}),
    };
    const base = { status, details, responseText: safeResponseText };

    if (status === 401) {
      return this._createError(
        `${this._provider.label} token 无效或已过期（HTTP 401）。请重新生成访问令牌：${SCOPE_HINT}`,
        { ...base, code: 'invalid-token' },
      );
    }

    if (status === 403) {
      const remaining = headers?.get?.('x-ratelimit-remaining');
      const resetAt = resetAtFromHeaders(headers);
      if (remaining === '0') {
        const when = resetAt ? new Date(resetAt).toISOString() : '';
        return this._createError(
          `${this._provider.label} API 速率限制已达上限（HTTP 403）${when ? `，额度预计在 ${when} 重置` : ''}。请稍后重试，或减少请求频率。`,
          {
            ...base,
            code: 'github-rate-limit',
            rateLimitReset: resetAt,
            details: { ...details, resetAt },
          },
        );
      }
      const acceptedRaw = headers?.get?.('x-accepted-oauth-scopes') ?? headers?.get?.('x-oauth-scopes') ?? '';
      const acceptedScopes = String(acceptedRaw)
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean);
      return this._createError(
        `${this._provider.label} token 权限不足（HTTP 403）。${SCOPE_HINT}${
          acceptedScopes.length ? `（${this._provider.label} 要求权限：${acceptedScopes.join(', ')}）` : ''
        }`,
        {
          ...base,
          code: 'insufficient-scope',
          details: { ...details, acceptedScopes },
        },
      );
    }

    if (status === 404) {
      return this._createError(
        `${this._provider.label} 资源不存在（HTTP 404，${method} ${label}）${apiMessage ? `：${apiMessage}` : ''}`,
        { ...base, code: 'not-found' },
      );
    }

    if (status === 422) {
      const combined = `${apiMessage} ${errorsText}`;
      if (/already[ _]exists/i.test(combined)) {
        return this._createError(
          `目标名称已被占用（HTTP 422）${apiMessage ? `：${apiMessage}` : ''}。请更换仓库名，或选择复用已有仓库。`,
          { ...base, code: 'name-taken' },
        );
      }
      return this._createError(
        `${this._provider.label} 拒绝了请求参数（HTTP 422）${apiMessage ? `：${apiMessage}` : ''}`,
        { ...base, code: 'bad-request' },
      );
    }

    if (status === 429) {
      const resetAt = resetAtFromHeaders(headers);
      return this._createError(
        `${this._provider.label} API 请求过于频繁（HTTP 429）${resetAt ? `，额度预计在 ${new Date(resetAt).toISOString()} 重置` : ''}。请稍后重试。`,
        {
          ...base,
          code: 'github-rate-limit',
          rateLimitReset: resetAt,
          details: { ...details, resetAt },
        },
      );
    }

    if (status >= 500) {
      const error = this._createError(
        `${this._provider.label} 服务暂时不可用（HTTP ${status}，${method} ${label}），自动重试后仍然失败，请稍后再试。`,
        { ...base, code: 'github-network' },
      );
      error.retryable = true;
      return error;
    }

    const error = this._createError(
      `${this._provider.label} API 请求失败（HTTP ${status}，${method} ${label}）${apiMessage ? `：${apiMessage}` : ''}`,
      { ...base, code: 'github-http' },
    );
    return error;
  }

  // -- account --------------------------------------------------------------

  /**
   * @returns {Promise<{login: string, id: number|null, name: string|null,
   *   avatarUrl: string, htmlUrl: string, scopes: string[], isFineGrained: boolean}>}
   */
  async getAuthenticatedUser() {
    const response = await this.request('GET', '/user', { accept: 'application/vnd.github+json' });
    const json = response.json;
    if (!json || typeof json !== 'object' || typeof json.login !== 'string' || !json.login) {
      throw this._createError(`无法解析 ${this._provider.label} 用户信息（GET /user 返回了无法识别的响应）。`, {
        status: response.status,
        code: 'github-http',
      });
    }
    const rawScopes = response.headers?.get?.('x-oauth-scopes');
    const isFineGrained = rawScopes === null || rawScopes === undefined;
    const scopes = isFineGrained
      ? []
      : String(rawScopes)
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean);
    this._login = json.login;
    return {
      login: json.login,
      id: Number.isFinite(Number(json.id)) ? Number(json.id) : null,
      name: typeof json.name === 'string' ? json.name : null,
      avatarUrl: typeof json.avatar_url === 'string' ? json.avatar_url : '',
      htmlUrl: typeof json.html_url === 'string' ? json.html_url : '',
      scopes,
      isFineGrained,
    };
  }

  async _knownLogin() {
    if (this._login) return this._login;
    try {
      const user = await this.getAuthenticatedUser();
      return user.login || null;
    } catch {
      return null;
    }
  }

  // -- repositories ---------------------------------------------------------

  /** @returns {Promise<object|null>} unified repo fields, or null on 404. */
  async getRepo(owner, repo) {
    const response = await this.request('GET', `/repos/${encodePart(owner)}/${encodePart(repo)}`, {
      allow404: true,
    });
    if (response.status === 404 || !response.json) return null;
    return indexRepoFields(response.json, this._provider.id);
  }

  /**
   * Look up an organisation. Returns null when the org does not exist (or the
   * token cannot see it). This is how publish preflight catches a mistyped
   * owner before attempting `POST /orgs/{owner}/repos` — for example a user
   * typing their display name instead of their GitHub login.
   *
   * @param {string} org organisation login
   * @returns {Promise<{login: string, name: string, htmlUrl: string}|null>}
   */
  async getOrg(org) {
    const name = String(org ?? '').trim();
    if (!name) return null;
    const response = await this.request('GET', `/orgs/${encodePart(name)}`, { allow404: true });
    if (response.status === 404 || !response.json) return null;
    const body = response.json;
    return {
      login: typeof body.login === 'string' ? body.login : name,
      name: typeof body.name === 'string' ? body.name : '',
      htmlUrl: typeof body.html_url === 'string' ? body.html_url : '',
    };
  }

  /**
   * Create a repository. When `owner` is empty (or equals the authenticated
   * login) the repo is created under the user account (`POST /user/repos`),
   * otherwise under the organisation (`POST /orgs/{owner}/repos`).
   *
   * @returns {Promise<object>} unified repo fields
   */
  async createRepo({ name, description = '', homepage = '', private: isPrivate = false, owner = null, branch = null } = {}) {
    const repoName = String(name ?? '').trim();
    if (!repoName) {
      throw this._createError(`创建 ${this._provider.label} 仓库需要仓库名（name）。`, { code: 'bad-request', status: 0 });
    }
    const ownerName = typeof owner === 'string' ? owner.trim() : '';

    let useUserEndpoint = ownerName === '';
    if (!useUserEndpoint) {
      const knownLogin = await this._knownLogin();
      useUserEndpoint =
        typeof knownLogin === 'string' &&
        knownLogin.length > 0 &&
        knownLogin.toLowerCase() === ownerName.toLowerCase();
    }

    const apiPath = useUserEndpoint
      ? '/user/repos'
      : `/orgs/${encodePart(ownerName)}/repos`;
    // GitHub wants flags like `has_issues`; Gitee wants `public`/`path`, and
    // Forgejo wants `default_branch`. Each provider knows its own payload shape,
    // so the wire body is built from the descriptor rather than hard-coded here.
    const fields = {
      name: repoName,
      description: String(description ?? ''),
      homepage: String(homepage ?? ''),
      private: isPrivate === true,
      // Only Forgejo takes the default branch at create time; the field is
      // ignored by the other providers' payload builders.
      branch: typeof branch === 'string' && branch.trim() !== '' ? branch.trim() : null,
    };
    const body = this._provider.createRepoFields
      ? this._provider.createRepoFields(fields)
      : {
          name: repoName,
          description: fields.description,
          homepage: fields.homepage,
          private: isPrivate === true,
          has_issues: true,
          has_projects: false,
          has_wiki: false,
          auto_init: false,
        };
    const response = await this.request('POST', apiPath, { body });
    if (!response.json) {
      throw this._createError(`${this._provider.label} 创建仓库成功但返回了空响应。`, {
        status: response.status,
        code: 'github-http',
      });
    }
    return indexRepoFields(response.json, this._provider.id);
  }

  /** @returns {Promise<object>} unified repo fields */
  async updateRepo(owner, repo, { description, homepage } = {}) {
    const patch = {};
    if (description !== undefined) patch.description = String(description ?? '');
    if (homepage !== undefined) patch.homepage = String(homepage ?? '');
    // Forgejo calls the homepage `website`; Gitee keeps `homepage` but insists on
    // its `name` being echoed back. Provider data decides, so GitHub's original
    // `{description, homepage}` body is unchanged.
    const body = this._provider.updateRepoFields
      ? this._provider.updateRepoFields(patch, { name: String(repo ?? '') })
      : patch;
    const response = await this.request(
      'PATCH',
      `/repos/${encodePart(owner)}/${encodePart(repo)}`,
      { body },
    );
    if (!response.json) {
      throw this._createError(`${this._provider.label} 更新仓库成功但返回了空响应。`, {
        status: response.status,
        code: 'github-http',
      });
    }
    return indexRepoFields(response.json, this._provider.id);
  }

  /** @returns {Promise<string[]>} topics as returned by the hosting. */
  async setTopics(owner, repo, names) {
    const list = Array.isArray(names)
      ? names.map((topic) => String(topic).trim()).filter(Boolean)
      : [];
    // Gitee has no topics endpoint in its entire v5 spec. Failing here would turn
    // a missing feature into a broken publish, so the step is reported as
    // unsupported and the caller skips it.
    if (this._provider.supportsTopics !== true) {
      throw this._createError(`${this._provider.label} 不支持仓库 topics`, {
        code: 'topics-unsupported',
        status: 0,
        details: { provider: this._provider.id },
      });
    }
    const response = await this.request(
      'PUT',
      `/repos/${encodePart(owner)}/${encodePart(repo)}/topics`,
      { body: { names: list } },
    );
    const returned = response.json?.names ?? response.json?.topics;
    return Array.isArray(returned) ? returned.map((topic) => String(topic)) : list;
  }

  // -- releases -------------------------------------------------------------

  /** @returns {Promise<object>} raw release JSON from the hosting */
  async createRelease(owner, repo, { tagName, name = null, body = '', prerelease = false, draft = false, targetCommitish = null } = {}) {
    const tag = String(tagName ?? '').trim();
    if (!tag) {
      throw this._createError(`创建 ${this._provider.label} Release 需要 tag 名称（tagName）。`, {
        code: 'bad-request',
        status: 0,
      });
    }
    const normalizedName = name === null || name === undefined || String(name) === '' ? tag : String(name);
    // GitHub's optional `draft` and Forgejo's required `target_commitish` both come
    // from provider data; Gitee declares `target_commitish` as required, so the
    // caller's branch is passed through.
    const payload = this._provider.releaseFields
      ? this._provider.releaseFields({
          tagName: tag,
          name: normalizedName,
          body: String(body ?? ''),
          prerelease: prerelease === true,
          draft: draft === true,
          targetCommitish,
        })
      : {
          tag_name: tag,
          name: normalizedName,
          body: String(body ?? ''),
          prerelease: prerelease === true,
          draft: draft === true,
        };
    const response = await this.request(
      'POST',
      `/repos/${encodePart(owner)}/${encodePart(repo)}/releases`,
      { body: payload },
    );
    if (!response.json) {
      throw this._createError(`${this._provider.label} 创建 Release 成功但返回了空响应。`, {
        status: response.status,
        code: 'github-http',
      });
    }
    return response.json;
  }

  /**
   * Web page for one release.
   *
   * GitHub and Forgejo return `html_url`; Gitee's release payload has no URL
   * field at all (verified live: `id, tag_name, target_commitish, prerelease,
   * name, body, author, created_at, assets`), so the page is composed from the
   * repository URL and the tag — the same shape Gitee itself links to.
   */
  releaseUrl(owner, repo, release, tag) {
    const source = release && typeof release === 'object' ? release : {};
    const direct = source.html_url || source.htmlUrl || source.url;
    if (typeof direct === 'string' && direct !== '') return direct;
    const tagName = tag || source.tag_name || source.tagName || '';
    if (tagName === '') return '';
    const base = this._provider.webBase.replace(/\/+$/, '');
    return `${base}/${owner}/${repo}/releases/tag/${tagName}`;
  }

  /** @returns {Promise<object|null>} release or null on 404. */
  async getReleaseByTag(owner, repo, tag) {
    const response = await this.request(
      'GET',
      `/repos/${encodePart(owner)}/${encodePart(repo)}/releases/tags/${encodePart(tag)}`,
      { allow404: true },
    );
    if (response.status === 404 || !response.json) return null;
    return response.json;
  }

  /**
   * Update the body (and optionally the name) of an existing Release.
   *
   * Re-publishing the same version used to reuse the old Release verbatim, so a
   * newly written changelog never reached GitHub. This patches it in place.
   *
   * @returns {Promise<object|null>} updated release, or null when the id is unknown
   */
  async updateRelease(owner, repo, releaseId, { tagName = null, name = null, body = null, prerelease = null, draft = null } = {}) {
    const id = Number(releaseId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const payload = {};
    if (tagName !== null) payload.tag_name = String(tagName);
    if (name !== null) payload.name = String(name);
    if (body !== null) payload.body = String(body);
    if (prerelease !== null) payload.prerelease = prerelease === true;
    if (draft !== null) payload.draft = draft === true;
    if (Object.keys(payload).length === 0) return null;
    const response = await this.request(
      'PATCH',
      `/repos/${encodePart(owner)}/${encodePart(repo)}/releases/${id}`,
      { body: payload },
    );
    return response.json || null;
  }

  /** @returns {Promise<object|null>} latest release or null on 404. */
  async getLatestRelease(owner, repo) {
    const response = await this.request(
      'GET',
      `/repos/${encodePart(owner)}/${encodePart(repo)}/releases/latest`,
      { allow404: true },
    );
    if (response.status === 404 || !response.json) return null;
    return response.json;
  }

  // -- rate limit -----------------------------------------------------------

  /** @returns {Promise<{limit: number, remaining: number, resetAt: number|null}>} */
  async rateLimit() {
    const response = await this.request('GET', '/rate_limit');
    const core = response.json?.resources?.core ?? response.json?.rate ?? {};
    const limit = Number(core.limit);
    const remaining = Number(core.remaining);
    const resetSeconds = Number(core.reset);
    return {
      limit: Number.isFinite(limit) ? limit : 0,
      remaining: Number.isFinite(remaining) ? remaining : 0,
      resetAt:
        Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 : null,
    };
  }
}
