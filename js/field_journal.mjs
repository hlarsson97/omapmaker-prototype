// Immutable, bounded GPS blocks. Metadata and points commit in the same transaction.
export const JOURNAL_BLOCK_SIZE = 128;
export const JOURNAL_BUFFER_LIMIT = 2048;
export function createFieldJournal(scope, {indexedDB = globalThis.indexedDB} = {}) {
  const opened = new Promise((resolve, reject) => {
    const request = indexedDB.open('omapmaker-field-journal', 1);
    request.onupgradeneeded = () => {
      for (const name of ['sessions', 'blocks', 'acks']) request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function transaction(names, mode, operation) {
    const db = await opened;
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(names, mode, mode === 'readwrite' ? {durability:'strict'} : undefined); }
      catch { tx = db.transaction(names, mode); }
      let result;
      tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result?.result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Sparningen avbröts'));
      try { result = operation(tx); } catch (error) { tx.abort(); reject(error); }
    });
  }
  const key = id => [scope, id];
  const get = (store, k) => transaction([store], 'readonly', tx => tx.objectStore(store).get(k));
  async function commit(meta, points) {
    const snapshot = structuredClone(meta), sequence = (snapshot.sequence || 0) + 1;
    snapshot.sequence = sequence; snapshot.savedAt = new Date().toISOString();
    const block = {sequence, meta:snapshot, points:structuredClone(points)};
    await transaction(['sessions','blocks'], 'readwrite', tx => {
      tx.objectStore('sessions').put(snapshot, key(meta.id));
      tx.objectStore('blocks').add(block, [scope, meta.id, sequence]);
    });
    return snapshot;
  }
  async function list() {
    return transaction(['sessions'], 'readonly', tx => {
      const rows = [], request = tx.objectStore('sessions').openCursor();
      request.onsuccess = () => { const cursor = request.result; if (!cursor) return; if (cursor.key[0] === scope) rows.push(cursor.value); cursor.continue(); };
      return () => rows;
    });
  }
  return {
    commit, list,
    get: id => get('sessions', key(id)),
    block: (id, sequence) => get('blocks', [scope,id,sequence]),
    ack: async id => await get('acks', key(id)) || 0,
    acknowledge: (id, sequence) => transaction(['acks'], 'readwrite', tx => tx.objectStore('acks').put(sequence,key(id))),
    async importBlock(block) {
      await transaction(['sessions','blocks','acks'], 'readwrite', tx => {
        tx.objectStore('blocks').put(block,[scope,block.meta.id,block.sequence]);
        tx.objectStore('sessions').put(block.meta,key(block.meta.id));
        tx.objectStore('acks').put(block.sequence,key(block.meta.id));
      });
    },
    async *blocks(meta, {from=1,to=meta.sequence}={}) {
      for (let sequence=Math.max(1,from); sequence<=Math.min(to,meta.sequence); sequence++) {
        const block = await get('blocks',[scope,meta.id,sequence]);
        if (!block) throw new Error('Ett sparat GPS-block saknas');
        yield block;
      }
    }
  };
}

export function createJournalWriter(journal, meta, {onSaved=()=>{}, onError=()=>{}}={}) {
  const pending=[];
  let running=Promise.resolve(), lastSignature=null;
  return {
    get buffered() { return pending.length; },
    append(point) {
      if (pending.length >= JOURNAL_BUFFER_LIMIT) throw new Error('GPS pausad: punkterna kunde inte sparas. Frigör lagringsutrymme och försök spara igen.');
      pending.push(point);
    },
    flush() {
      const work = async () => {
        // Snapshot before awaiting: new fixes remain pending for the next transaction.
        const count=pending.length, snapshot=structuredClone(meta);
        const {sequence,savedAt,persistedCount,...content}=snapshot;
        const signature=JSON.stringify(content);
        if(!count&&signature===lastSignature)return;
        let offset=0;
        do {
          const points=pending.slice(0,Math.min(JOURNAL_BLOCK_SIZE,count-offset));
          const saved=await journal.commit({...snapshot,sequence:meta.sequence,pointCount:(meta.persistedCount||0)+points.length},points);
          pending.splice(0,points.length);offset+=points.length;
          meta.sequence=saved.sequence;meta.savedAt=saved.savedAt;meta.persistedCount=saved.pointCount;
          onSaved(meta);
        } while(offset<count);
        lastSignature=signature;
      };
      const result=running.then(work);
      running=result.catch(onError);
      return result;
    }
  };
}

// Stable UUID per saved geometry piece makes crash recovery idempotent.
export function surveyPieceId(segmentId, index) {
  const suffix=(BigInt('0x'+segmentId.slice(-12))+BigInt(index)) & 0xffffffffffffn;
  return segmentId.slice(0,-12)+suffix.toString(16).padStart(12,'0');
}
