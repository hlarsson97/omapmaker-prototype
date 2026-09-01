const ACCOUNT_CACHE_KEY = 'omapmaker.account.v1';

export class AccountApiError extends Error {
  constructor(message, {status = 0, code = '', current = null} = {}) {
    super(message);
    this.name = 'AccountApiError';
    this.status = status;
    this.code = code;
    this.current = current;
  }
}

async function responseJson(response) {
  let value = {};
  try { value = await response.json(); } catch {}
  if (!response.ok) throw new AccountApiError(value.error || 'Servern kunde inte slutföra begäran', {status: response.status, code: value.code, current: value.current});
  return value;
}

export function workspaceCacheKey(userId) {
  return `omapmaker.workspaces.user.${userId}`;
}

export function userMapCacheKey(userId) {
  return `omapmaker.user-map.${userId}`;
}

export function readJsonStorage(storage, key, fallback) {
  try { return JSON.parse(storage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; }
}

export function createAccountApi({fetchImpl = globalThis.fetch, storage = globalThis.localStorage} = {}) {
  let csrfToken = null;
  const writeAccountCache = user => {
    if (user) storage?.setItem(ACCOUNT_CACHE_KEY, JSON.stringify(user));
    else storage?.removeItem(ACCOUNT_CACHE_KEY);
  };
  const cachedUser = () => readJsonStorage(storage, ACCOUNT_CACHE_KEY, null);
  const cacheWorkspaces = (userId, workspaces) => storage?.setItem(workspaceCacheKey(userId), JSON.stringify(workspaces));
  const cachedWorkspaces = userId => readJsonStorage(storage, workspaceCacheKey(userId), []);

  async function request(path, {method = 'GET', body, csrf = false} = {}) {
    const headers = {'Accept': 'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf) {
      if (!csrfToken) await session();
      if (!csrfToken) throw new AccountApiError('Inloggningen behöver förnyas', {status: 401, code: 'authentication_required'});
      headers['X-OMapMaker-CSRF'] = csrfToken;
    }
    return responseJson(await fetchImpl(path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin'}));
  }

  async function session() {
    const value = await request('/api/auth/session');
    csrfToken = value.authenticated ? value.csrfToken : null;
    writeAccountCache(value.authenticated ? value.user : null);
    return value;
  }

  async function login(username, password) {
    const value = await request('/api/auth/login', {method: 'POST', body: {username, password}});
    csrfToken = value.csrfToken;
    writeAccountCache(value.user);
    return value;
  }

  async function logout() {
    const value = await request('/api/auth/logout', {method: 'POST', body: {}, csrf: true});
    csrfToken = null;
    writeAccountCache(null);
    return value;
  }

  async function listWorkspaces(userId) {
    const value = await request('/api/workspaces');
    cacheWorkspaces(userId, value.workspaces);
    return value.workspaces;
  }

  async function createWorkspace(userId, workspace) {
    const value = await request('/api/workspaces', {method: 'POST', body: workspace, csrf: true});
    const workspaces = [value, ...cachedWorkspaces(userId).filter(item => item.id !== value.id)];
    cacheWorkspaces(userId, workspaces);
    return value;
  }

  async function updateWorkspace(userId, workspaceId, changes, expectedRevision) {
    const value = await request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {method: 'PATCH', body: {changes, expectedRevision}, csrf: true});
    const workspaces = cachedWorkspaces(userId).map(item => item.id === value.id ? value : item);
    cacheWorkspaces(userId, workspaces);
    return value;
  }

  async function importWorkspaces(userId, workspaces, migrationId = crypto.randomUUID()) {
    const value = await request('/api/workspaces/import', {method: 'POST', body: {migrationId, workspaces}, csrf: true});
    const byId = new Map(cachedWorkspaces(userId).map(item => [item.id, item]));
    value.workspaces.forEach(item => byId.set(item.id, item));
    cacheWorkspaces(userId, [...byId.values()]);
    return value;
  }

  async function userData(since = 0) {
    return request(`/api/user-data?since=${encodeURIComponent(since)}`);
  }

  async function syncUserData(objects, fieldSurveys = [], layerOverrides = [], mutationId = crypto.randomUUID()) {
    return request('/api/user-data/sync', {method: 'POST', body: {mutationId, objects, fieldSurveys, layerOverrides}, csrf: true});
  }

  async function importUserData(objects, fieldSurveys = [], layerOverrides = [], migrationId = crypto.randomUUID()) {
    return request('/api/user-data/import', {method: 'POST', body: {migrationId, objects, fieldSurveys, layerOverrides}, csrf: true});
  }

  async function lantmaterietSession() {
    return request('/api/lantmateriet-session');
  }

  async function connectLantmateriet(username, password, orderId) {
    return request('/api/lantmateriet-session', {method: 'POST', body: {username, password, orderId}, csrf: true});
  }

  async function disconnectLantmateriet() {
    return request('/api/lantmateriet-session', {method: 'DELETE', csrf: true});
  }

  return {session, login, logout, listWorkspaces, createWorkspace, updateWorkspace, importWorkspaces, userData, syncUserData, importUserData, lantmaterietSession, connectLantmateriet, disconnectLantmateriet, cachedUser, cachedWorkspaces, cacheWorkspaces};
}
