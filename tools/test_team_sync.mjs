import assert from 'node:assert/strict';
import {createTeamSync, entityKey} from '../js/team_sync.mjs';

const storage = () => {const values = new Map(); return {getItem: key => values.get(key) || null, setItem: (key,value) => values.set(key,value)};};
const object = (id, x = 18) => ({kind: 'object', id, category: 'point', payload: {coordinates: [x,59]}, deleted: false});
function server() {
  let sequence = 0, loseNextReply = false;
  const entities = new Map(), receipts = new Map();
  return {
    loseReply: () => {loseNextReply = true;},
    request: async (path, body) => {
      if (path.startsWith('data')) return {entities: [...entities.values()], cursor: sequence, role: 'editor'};
      if (receipts.has(body.mutationId)) return receipts.get(body.mutationId);
      const conflicts = body.changes.filter(change => (entities.get(entityKey(change))?.revision || 0) !== change.expectedRevision).map(change => entities.get(entityKey(change)));
      if (conflicts.length) throw Object.assign(new Error('Conflict'), {code: 'team_conflict', current: conflicts});
      const saved = body.changes.map(({expectedRevision,...value}) => {const result={...value,revision:expectedRevision+1};sequence++;entities.set(entityKey(value),result);return result;});
      const result = {entities: saved}; receipts.set(body.mutationId, result);
      if (loseNextReply) {loseNextReply = false;throw new Error('Disconnected after commit');}
      return result;
    }, entities
  };
}
function client(backend, disk=storage()) {return createTeamSync({storage: disk, key: 'test', request: backend.request});}

{
  const backend = server(), disk = storage(), a = client(backend,disk);
  a.set(object('a')); backend.loseReply(); await assert.rejects(a.sync());
  const restarted = client(backend,disk); assert.equal(restarted.pendingCount(),1);
  await restarted.sync(); assert.equal(restarted.pendingCount(),0);
  assert.equal(backend.entities.get(entityKey(object('a'))).revision,1);
}
{
  const backend = server(), a = client(backend), b = client(backend);
  a.set(object('a')); await a.sync(); await b.sync();
  a.set(object('a',19)); b.set(object('a',20)); b.set(object('b'));
  await a.sync(); await b.sync();
  assert.equal(b.conflicts().length,1); assert.equal(backend.entities.has(entityKey(object('b'))),true);
  assert.equal(b.conflicts()[0].base.payload.coordinates[0],18);
  b.resolve(entityKey(object('a')),'local');
  a.set(object('a',21)); await a.sync(); await b.sync();
  assert.equal(b.conflicts().length,1); // Conflict resolution is also revision-checked.
  b.resolve(entityKey(object('a')),'remote'); assert.equal(b.pendingCount(),0);
}
{
  const backend = server(), a = client(backend);
  a.set(object('a')); await a.sync();
  a.set({...object('a'),deleted:true});await a.sync();
  const b=client(backend);await b.sync();assert.equal(b.values()[0].deleted,true);
}
{
  const backend=server();let release, started;
  const began=new Promise(resolve=>started=resolve), pause=new Promise(resolve=>release=resolve);
  const a=createTeamSync({storage:storage(),key:'test',request:async(path,body)=>{if(body){started();await pause;}return backend.request(path,body);}});
  a.set(object('a'));const inFlight=a.sync();await began;a.set(object('a',22));release();await inFlight;
  assert.equal(a.pendingCount(),1);await a.sync();assert.equal(a.pendingCount(),0);
  assert.equal(backend.entities.get(entityKey(object('a'))).payload.coordinates[0],22);
}
console.log('Team sync: restart, lost replies, conflicts, independent edits, deletion and in-flight edits passed.');

{
  const backend=server(),a=client(backend),b=client(backend);
  a.setMany([object('a'),object('b')]);await a.sync();await b.sync();
  a.setMany([object('a',20),object('b',20)]);
  b.set(object('a',21));await b.sync();await a.sync();
  assert.equal(a.conflicts().length,1);
  assert.equal(backend.entities.get(entityKey(object('b'))).payload.coordinates[0],18,'Related change must wait for conflict resolution');
  a.resolve(entityKey(object('a')),'local');await a.sync();
  assert.equal(backend.entities.get(entityKey(object('b'))).payload.coordinates[0],20);
  assert.equal(a.pendingCount(),0);
}
