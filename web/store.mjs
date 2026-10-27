// Small IndexedDB key-value store. Every call fails soft: without storage the page simply refetches.
let opening;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('rail-planner', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opening;
}

async function run(mode, action) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('kv', mode);
      const request = action(transaction.objectStore('kv'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    return undefined;
  }
}

export const get = key => run('readonly', store => store.get(key));
export const set = (key, value) => run('readwrite', store => store.put(value, key));

// Deletes entries under `prefix` that `keep` rejects.
export async function prune(prefix, keep) {
  await run('readwrite', store => {
    const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    request.addEventListener('success', () => {
      const cursor = request.result;
      if (!cursor) return;
      if (!keep(cursor.value)) cursor.delete();
      cursor.continue();
    });
    return request;
  });
}
