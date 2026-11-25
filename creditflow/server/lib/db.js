// MySQL access. Every query uses a real server-side prepared statement
// (`execute`), so values are never spliced into SQL text.
import mysql from 'mysql2/promise';

class Runner {
  constructor(target) {
    this.target = target;
  }

  async run(sql, params = []) {
    const [result] = await this.target.execute(sql, params);
    return result;
  }

  async all(sql, params = []) {
    return this.run(sql, params);
  }

  async one(sql, params = []) {
    const rows = await this.run(sql, params);
    return rows[0] ?? null;
  }

  async insert(sql, params = []) {
    return Number((await this.run(sql, params)).insertId);
  }
}

export class Db extends Runner {
  constructor(cfg) {
    const pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      charset: 'utf8mb4',
      connectionLimit: cfg.connectionLimit ?? 10,
      multipleStatements: false,
      dateStrings: true, // DATE and DATETIME stay as plain text, no time-zone shifts
      decimalNumbers: false, // DECIMAL stays as text, converted to cents by Money.fromDb
      timezone: 'Z',
      ssl: cfg.ssl ? { rejectUnauthorized: true } : undefined,
    });
    // Every connection works in UTC so stored times are comparable.
    pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));
    super(pool);
    this.pool = pool;
  }

  /** Runs `fn` on one connection inside a transaction and rolls back if it throws. */
  async tx(fn) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const out = await fn(new Runner(conn));
      await conn.commit();
      return out;
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  end() {
    return this.pool.end();
  }
}
