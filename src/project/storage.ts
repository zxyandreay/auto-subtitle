import type { AutoSubtitleProject } from '../types/subtitles'

const DB_NAME = 'auto-subtitle'
const DB_VERSION = 1
const STORE_NAME = 'projects'
const AUTOSAVE_KEY = 'autosave'

export type AutosaveRecord = {
  key: typeof AUTOSAVE_KEY
  savedAt: string
  project: AutoSubtitleProject
  history?: AutoSubtitleProject['subtitles'][]
}

export async function saveAutosave(project: AutoSubtitleProject): Promise<void> {
  const db = await openDatabase()
  await requestToPromise(
    db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put({
      key: AUTOSAVE_KEY,
      savedAt: new Date().toISOString(),
      project,
    } satisfies AutosaveRecord),
  )
  db.close()
}

export async function loadAutosave(): Promise<AutosaveRecord | null> {
  const db = await openDatabase()
  const record = await requestToPromise<AutosaveRecord | undefined>(
    db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(AUTOSAVE_KEY),
  )
  db.close()
  return record ?? null
}

export async function clearAutosave(): Promise<void> {
  const db = await openDatabase()
  await requestToPromise(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(AUTOSAVE_KEY))
  db.close()
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available in this browser.'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB.'))
  })
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}
