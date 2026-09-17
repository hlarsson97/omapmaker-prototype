// A durable outbox. Persist before sending; retry the exact mutation after a lost reply.
export const entityKey = value => JSON.stringify([value.kind, value.id]);
const clone = value => structuredClone(value);
const content = value => {
  if (!value) return null;
  const {revision, modifiedBy, modifiedAt, ...rest} = value;
  return rest;
};
const same = (a, b) => JSON.stringify(content(a)) === JSON.stringify(content(b));

export function createTeamSync({storage, key, request, uuid = () => crypto.randomUUID(), onStorageError = () => {}}) {
  const state = JSON.parse(storage.getItem(key) || '{"cursor":0,"entries":{}}');
  let running = false;
  const persist = () => {
    try { storage.setItem(key, JSON.stringify(state)); }
    catch (error) {onStorageError(error); throw new Error('Ändringarna kunde inte sparas på enheten. Behåll fliken öppen och spara en lokal säkerhetskopia.');}
  };
  const entries = () => Object.values(state.entries);
  const dirty = entry => !same(entry.local, entry.base);
  function setMany(values) {
    const changed = values.filter(value => !same(state.entries[entityKey(value)]?.local, value));
    const groups = new Set(changed.map(value => state.entries[entityKey(value)]?.group).filter(Boolean));
    const group = changed.length > 1 || groups.size ? uuid() : null;
    for (const entry of entries()) if (groups.has(entry.group)) entry.group = group;
    for (const value of changed) {
      const id = entityKey(value), previous = state.entries[id];
      if (previous) {previous.local = clone(content(value)); previous.group = group;}
      else state.entries[id] = {local: clone(content(value)), group};
    }
    persist();
  }
  const set = value => setMany([value]);
  function merge(data) {
    for (const remote of data.entities) {
      const id = entityKey(remote), entry = state.entries[id];
      if (entry && (dirty(entry) || entry.pending)) {
        if ((entry.base?.revision || 0) !== remote.revision) entry.conflict = clone(remote);
      } else state.entries[id] = {base: clone(remote), local: clone(content(remote))};
    }
    state.cursor = data.cursor;
    state.role = data.role;
    persist();
  }
  async function send(entry) {
    if (!entry.pending) {
      const related = entry.group ? entries().filter(other => other.group === entry.group) : [entry];
      if (related.some(other => other.conflict)) return;
      const changed = related.filter(dirty);
      if (!changed.length) return;
      if (changed.length > 100) throw new Error('För många sammanhängande ändringar. Spara en säkerhetskopia och dela upp arbetet.');
      const pending = {mutationId: uuid(), changes: changed.map(other => ({...clone(other.local), expectedRevision: other.base?.revision || 0}))};
      for (const other of changed) other.pending = pending;
      persist();
    }
    const sent = entry.pending;
    try {
      const result = await request('sync', sent);
      for (const remote of result.entities) {
        const current = state.entries[entityKey(remote)];
        // Editing may have continued while the request was in flight.
        const {expectedRevision, ...submitted} = sent.changes.find(change => entityKey(change) === entityKey(remote));
        if (same(current.local, submitted)) current.local = clone(content(remote));
        current.base = clone(remote);
        delete current.pending;
        delete current.conflict;
      }
      persist();
    } catch (error) {
      if (error.code !== 'team_conflict') throw error;
      for (const remote of error.current) state.entries[entityKey(remote)].conflict = clone(remote);
      for (const change of sent.changes) delete state.entries[entityKey(change)].pending;
      persist();
    }
  }
  async function sync() {
    if (running) return;
    running = true;
    try {
      // Reconcile ambiguous successes before pulling newer versions.
      for (const entry of entries()) if (entry.pending) await send(entry);
      merge(await request(`data?since=${state.cursor}`));
      if (state.role !== 'viewer') {
        for (const entry of entries()) if (dirty(entry) && !entry.conflict) await send(entry);
      }
      // Never advance the download cursor using an upload receipt.
      merge(await request(`data?since=${state.cursor}`));
    } finally { running = false; }
  }
  function resolve(id, choice) {
    if (running) throw new Error('Vänta tills synkningen är klar');
    const entry = state.entries[id];
    if (!entry?.conflict) return;
    entry.base = clone(entry.conflict);
    if (choice === 'remote') entry.local = clone(content(entry.conflict));
    delete entry.conflict;
    delete entry.pending;
    persist();
  }
  return {set, setMany, merge, sync, resolve, entries, state,
    values: () => entries().map(entry => clone(entry.local)),
    pendingCount: () => entries().filter(entry => dirty(entry) || entry.pending).length,
    conflicts: () => entries().filter(entry => entry.conflict),
    isRunning: () => running};
}

export function createTeamApi(accountApi) {
  return async (path, body) => {
    const response = await accountApi.authenticatedFetch(`/api/${path}`, body === undefined ? {} : {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || 'Arbetslaget kunde inte hämtas'), value, {status: response.status});
    return value;
  };
}
