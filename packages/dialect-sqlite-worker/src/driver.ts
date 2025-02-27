import type { DatabaseConnection, Driver, QueryResult } from 'kysely'
import type { MainMsg, SqliteWorkerDialectConfig, WorkerMsg } from './type'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { CompiledQuery, SelectQueryNode } from 'kysely'

export class SqliteWorkerDriver implements Driver {
  private connectionMutex = new ConnectionMutex()
  private connection?: SqliteWorkerConnection
  private worker?: Worker
  private emit?: EventEmitter

  constructor(
    private config: SqliteWorkerDialectConfig,
  ) { }

  async init(): Promise<void> {
    const { dbOption, source, onCreateConnection } = this.config
    const src = typeof source === 'function' ? await source() : source
    this.emit = new EventEmitter()
    this.worker = new Worker(
      this.config.workerPath || join(__dirname, 'worker.js'),
      { workerData: { src, option: dbOption } },
    )
    this.worker.on('message', ([type, data, err]: WorkerMsg) => {
      this.emit?.emit(type, data, err)
    })
    this.connection = new SqliteWorkerConnection(this.worker, this.emit)

    await onCreateConnection?.(this.connection)
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    // SQLite only has one single connection. We use a mutex here to wait
    // until the single connection has been released.
    await this.connectionMutex.lock()
    return this.connection!
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin'))
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'))
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'))
  }

  async releaseConnection(): Promise<void> {
    this.connectionMutex.unlock()
  }

  async destroy(): Promise<void> {
    this.worker?.postMessage(['1'] satisfies MainMsg)
    return new Promise<void>((resolve, reject) => {
      this.emit?.once('1', (_, err) => {
        if (err) {
          reject(err)
          return
        }
        this.worker?.terminate()
        this.emit?.removeAllListeners()
        this.emit = undefined
        resolve()
      })
    })
  }
}
class ConnectionMutex {
  private promise?: Promise<void>
  private resolve?: () => void

  async lock(): Promise<void> {
    while (this.promise) {
      await this.promise
    }

    this.promise = new Promise((resolve) => {
      this.resolve = resolve
    })
  }

  unlock(): void {
    const resolve = this.resolve

    this.promise = undefined
    this.resolve = undefined

    resolve?.()
  }
}
export class SqliteWorkerConnection implements DatabaseConnection {
  constructor(
    private worker: Worker,
    private mitt?: EventEmitter,
  ) { }

  async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    const { parameters, sql, query } = compiledQuery
    if (!SelectQueryNode.is(query)) {
      throw new Error('Sqlite worker dialect only supported SELECT queries')
    }
    this.worker.postMessage(['2', sql, parameters] satisfies MainMsg)
    let done = false
    let resolveFn: (value: IteratorResult<QueryResult<R>>) => void
    let rejectFn: (reason?: any) => void

    const dataListener = (data: QueryResult<any>[] | null, err: unknown): void => {
      if (err) {
        rejectFn(err)
      } else {
        resolveFn({ value: { rows: data as any }, done: false })
      }
    }
    this.mitt!.on('2'/* data */, dataListener)

    const endListener = (_: null, err: unknown): void => {
      if (err) {
        rejectFn(err)
      } else {
        resolveFn({ value: undefined, done: true })
      }
    }
    this.mitt!.on('3'/* end */, endListener)

    while (!done) {
      const result = await new Promise<IteratorResult<QueryResult<R>>>((res, rej) => {
        resolveFn = res
        rejectFn = rej
      })

      if (result.done) {
        done = true
        this.mitt?.off('2'/* data */, dataListener)
        this.mitt?.off('3'/* end */, endListener)
      } else {
        yield result.value
      }
    }
  }

  async executeQuery<R>(compiledQuery: CompiledQuery<unknown>): Promise<QueryResult<R>> {
    const { parameters, sql } = compiledQuery
    this.worker.postMessage(['0', sql, parameters] satisfies MainMsg)
    return new Promise((resolve, reject) => {
      if (!this.mitt) {
        reject(new Error('kysely instance has been destroyed'))
      }
      this.mitt!.once('0', (data: QueryResult<any>, err) => (data && !err) ? resolve(data) : reject(err))
    })
  }
}
