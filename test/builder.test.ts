import { SqliteDialect } from 'kysely'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { getOrSetDBVersion, optimizePragma } from '../packages/sqlite-utils/src'
import type { InferDatabase } from '../packages/sqlite-builder/src/schema'
import { defineLiteral, defineObject, defineTable, useSchema } from '../packages/sqlite-builder/src/schema'
import { SqliteBuilder } from '../packages/sqlite-builder/src'

const testTable = defineTable({
  id: { type: 'increments' },
  person: { type: 'object', defaultTo: { name: 'test' } },
  gender: { type: 'boolean', notNull: true },
  array: defineObject<string[]>(),
  literal: defineLiteral<'l1' | 'l2'>(),
  buffer: { type: 'blob' },
}, {
  primary: 'id',
  index: ['person', ['id', 'gender']],
  timeTrigger: { create: true, update: true },
})

const baseTables = {
  test: testTable,
}
type DB = InferDatabase<typeof baseTables>

function getDatabase(debug = false) {
  return new SqliteBuilder<DB>({
    dialect: new SqliteDialect({
      database: new Database(':memory:'),
      async onCreateConnection(connection) {
        await optimizePragma(connection)
      },
    }),
    logger: debug ? console : undefined,
    onQuery: debug,
  })
}
describe('test sync table', async () => {
  let db: SqliteBuilder<any>
  beforeEach(async () => {
    db = getDatabase()
    await db.updateTableSchema(useSchema(baseTables, { log: false }))
  })
  it('should create new table', async () => {
    const foo = defineTable({
      col1: { type: 'increments' },
      col2: { type: 'string' },
    })

    await db.updateTableSchema(useSchema({
      ...baseTables,
      foo,
    }, { log: false }))

    const _tables = await db.kysely.introspection.getTables()
    expect(_tables.length).toBe(2)
    expect(_tables[0].name).toBe('foo')
    expect(_tables[1].name).toBe('test')
  })
  it('should drop old table', async () => {
    await db.updateTableSchema(useSchema({ }, { log: false }))

    const _tables = await db.kysely.introspection.getTables()
    expect(_tables.length).toBe(0)
  })
  it('should update and diff same table with columns', async () => {
    const foo = defineTable(
      {
        id: { type: 'increments' },
        person: { type: 'int' },
        bool: { type: 'boolean', notNull: true },
        array: defineObject<string[]>(),
        buffer: { type: 'blob' },
      },
      {
        primary: 'id',
        timeTrigger: { create: true, update: true },
      },
    )
    await db.updateTableSchema(useSchema({ test: foo }, { log: false }))
    const [_tables] = await db.kysely.introspection.getTables()
    expect(_tables
      .columns
      .filter(({ name }) => name === 'person')[0]
      .dataType,
    ).toBe('INTEGER')
    expect(_tables
      .columns
      .filter(({ name }) => name === 'gender')
      .length,
    ).toBe(0)
    expect(_tables
      .columns
      .filter(({ name }) => name === 'bool')[0]
      .dataType,
    ).toBe('TEXT')
  })
})
describe('test builder', async () => {
  const db = getDatabase()
  await getOrSetDBVersion(db.kysely, 2)
  await db.updateTableSchema(useSchema(baseTables))
  it('should insert', async () => {
    //  generate table
    console.log(await db.transaction(async () => {
      await db.execute(d => d.insertInto('test').values([{ gender: false }, { gender: true }]))
      return db.execute(d => d.updateTable('test').set({ gender: true }).where('id', '=', 2).returningAll())
    }, {
      afterCommit: () => {
        console.log('after commit')
      },
    }))
    const result = await db.execute(d => d.selectFrom('test').selectAll())
    expect(result).toBeInstanceOf(Array)
    expect(result![0].person).toStrictEqual({ name: 'test' })
    expect(result![0].gender).toStrictEqual(false)
    expect(result![0].createAt).toBeInstanceOf(Date)
    expect(result![0].updateAt).toBeInstanceOf(Date)
    const result2 = await db.executeTakeFirst(d => d.selectFrom('test').selectAll())
    expect(result2).toBeInstanceOf(Object)
    expect(result2!.person).toStrictEqual({ name: 'test' })
    expect(result2!.gender).toStrictEqual(false)
    expect(result2!.createAt).toBeInstanceOf(Date)
    expect(result2!.updateAt).toBeInstanceOf(Date)
  })
  it('should precompile', async () => {
    const select = db.precompile(
      db => db.selectFrom('test').selectAll(),
    ).setParam<{ person: { name: string } }>(({ qb, param }) =>
      qb.where('person', '=', param('person')),
    )
    const insert = db.precompile(
      db => db.insertInto('test'),
    ).setParam<{ gender: boolean }>(({ qb, param }) =>
      qb.values({ gender: param('gender') }),
    )
    const update = db.precompile(
      db => db.updateTable('test'),
    ).setParam<{ gender: boolean }>(({ qb, param }) =>
      qb.set({ gender: param('gender') }).where('id', '=', 1),
    )

    const start = performance.now()

    const { parameters, sql } = select({ person: { name: '1' } })
    expect(sql).toBe('select * from "test" where "person" = ?')
    expect(parameters).toStrictEqual(['{"name":"1"}'])

    const start2 = performance.now()
    console.log('no compiled:', `${(start2 - start).toFixed(2)}ms`)

    const { parameters: p1, sql: s1 } = select({ person: { name: 'test' } })
    expect(s1).toBe('select * from "test" where "person" = ?')
    expect(p1).toStrictEqual(['{"name":"test"}'])

    console.log('   compiled:', `${(performance.now() - start2).toFixed(2)}ms`)

    const result = await db.execute(insert({ gender: true }))
    expect(result.rows).toStrictEqual([])
    const result2 = await db.execute(update({ gender: false }))
    expect(result2.rows).toStrictEqual([])
  })
})
