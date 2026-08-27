export function createIndexedDbStore({databaseName, version, storeName}) {
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, version);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function transact(mode, operation) {
    const database = await open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const request = operation(transaction.objectStore(storeName));
        transaction.oncomplete = () => resolve(request?.result ?? null);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }

  return {
    get: key => transact('readonly', store => store.get(key)),
    put: (key, value) => transact('readwrite', store => store.put(value, key)),
    delete: key => transact('readwrite', store => store.delete(key))
  };
}
