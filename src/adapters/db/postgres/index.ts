import pg from 'pg';
import type { Db, QueryResult } from '../../../core/ports';

const { Pool } = pg;

export const createPool = (databaseUrl: string): pg.Pool =>
  new Pool({ connectionString: databaseUrl, max: 8 });

const wrap = (runner: pg.Pool | pg.PoolClient, inTx: boolean): Db => ({
  async query<R = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    const res = await runner.query(text, params as unknown[]);
    return { rows: res.rows as R[], rowCount: res.rowCount ?? 0 };
  },

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    // Anidar transacciones reutiliza la actual: sin savepoints, que acá no hacen falta.
    if (inTx) return fn(wrap(runner, true));

    const client = await (runner as pg.Pool).connect();
    try {
      await client.query('begin');
      const out = await fn(wrap(client, true));
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },
});

export const pgDb = (pool: pg.Pool): Db => wrap(pool, false);
