import * as Y from 'yjs'
import { IndexedDBDocStore } from './storage/IndexedDBDocStore'
import { Y_MAP, LOCAL_ORIGIN } from './constants'

/**
 * 本地同步引擎(阶段 1:无 remote)。
 * 持有 Y.Doc、本地持久化、UndoManager;把本地 update 落 IndexedDB。
 */
export class LocalSyncEngine {
  readonly docId: string
  readonly doc: Y.Doc
  readonly undoManager: Y.UndoManager
  private readonly store: IndexedDBDocStore
  private pending: Promise<void> = Promise.resolve()

  private constructor(docId: string, doc: Y.Doc, store: IndexedDBDocStore) {
    this.docId = docId
    this.doc = doc
    this.store = store
    this.undoManager = new Y.UndoManager(
      [
        Y_MAP.meta,
        Y_MAP.damageEvents,
        Y_MAP.castEvents,
        Y_MAP.annotations,
        Y_MAP.composition,
        Y_MAP.statData,
      ].map(n => doc.getMap(n)),
      { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 400 }
    )
    this.doc.on('update', this.onUpdate)
  }

  /**
   * 打开一条时间轴。
   * @param seed 仅在新建时间轴时传入(本地无持久化数据时用作初始 Y.Doc)
   */
  static async create(docId: string, seed?: Y.Doc): Promise<LocalSyncEngine> {
    const store = new IndexedDBDocStore()
    await store.open()
    const persisted = await store.loadDoc(docId)
    const doc = new Y.Doc()
    if (persisted) {
      Y.applyUpdate(doc, persisted, 'persisted')
    } else if (seed) {
      const seedUpdate = Y.encodeStateAsUpdate(seed)
      Y.applyUpdate(doc, seedUpdate, 'persisted')
      // 新建文档:把初始状态落盘,后续 delta 才能完整回放
      await store.appendUpdate(docId, seedUpdate)
    }
    return new LocalSyncEngine(docId, doc, store)
  }

  private onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === 'persisted') return // 来自加载,无需再落盘
    this.pending = this.pending
      .then(() => this.store.appendUpdate(this.docId, update))
      .catch(err => {
        console.error('[collab] persist update failed', err)
      })
  }

  /** 等所有待持久化的 update 落盘 */
  flush(): Promise<void> {
    return this.pending
  }

  destroy(): void {
    this.doc.off('update', this.onUpdate)
    this.undoManager.destroy()
  }
}
