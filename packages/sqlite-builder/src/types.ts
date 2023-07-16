import type { DeleteQueryBuilder, Dialect, Generated, InsertQueryBuilder, KyselyPlugin, SelectQueryBuilder, Sql, UpdateQueryBuilder } from 'kysely'
import type { CompiledQuery } from 'kysely/dist/cjs/query-compiler/compiled-query'

type Prettify<T> = {
  [K in keyof T]: T[K]
} & {}

export type TriggerEvent = 'insert' | 'update' | 'delete'

export type InferColumnType<T> =
  T extends string ? 'string' :
    T extends boolean ? 'boolean' :
      T extends number ? 'number' :
        T extends Generated<any> ? 'increments' :
          T extends Date ? 'date' :
            T extends ArrayBufferLike ? 'blob' :
              'object'

export type ColumeOption<T> = Prettify<{
  type: InferColumnType<T>
  defaultTo?: T | ((sql: Sql) => unknown)
  notNull?: boolean
}>
export type TableOption<T> = Prettify<{
  primary?: keyof T | Array<keyof T>
  unique?: Array<keyof T | Array<keyof T>>
  index?: Array<keyof T | Array<keyof T>>
  /**
   * set `True` to use default field
   * - create field: 'createAt'
   * - update field: 'updateAt'
   */
  timestamp?: boolean | { create?: keyof T; update?: keyof T }
}>
export type Column<T> = Prettify<{
  [k in keyof T]: ColumeOption<T[k]>
}>
export type ITable<T> = Prettify<{
  columns: Column<T>
  property?: TableOption<T>
}>
export type Tables<T> = Prettify<{
  [Key in keyof T]: ITable<T[Key]>
}>
export interface SqliteBuilderOption<T> {
  tables: Tables<T>
  dialect: Dialect
  dropTableBeforeInit?: boolean
  onQuery?: (queryInfo: CompiledQuery, time: number) => any
  plugins?: Array<KyselyPlugin>
  logger?: Logger
}
export type Logger = {
  info: (msg: string) => void
  debug: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string, e?: Error) => void
}

export type AvailableBuilder<DB, O> =
  | SelectQueryBuilder<DB, keyof DB, O>
  | UpdateQueryBuilder<DB, keyof DB, keyof DB, O>
  | InsertQueryBuilder<DB, keyof DB, O>
  | DeleteQueryBuilder<DB, keyof DB, O>
