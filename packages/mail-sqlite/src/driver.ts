export type SqlValue = null | string | number | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlTransaction {
  exec(sql: string): Promise<void>;
  execute(
    sql: string,
    bindings?: readonly SqlValue[],
  ): Promise<{ changedRows: number }>;
  query(sql: string, bindings?: readonly SqlValue[]): Promise<SqlRow[]>;
}

export interface SqliteDriver {
  close(): Promise<void>;
  read<T>(work: (tx: SqlTransaction) => Promise<T>): Promise<T>;
  /**
   * `deferForeignKeys` turns foreign keys off around the transaction.
   *
   * SQLite cannot alter a CHECK constraint, so changing one means rebuilding the
   * table, and its documented procedure for that requires foreign keys to be
   * disabled *outside* the transaction — the pragma is a silent no-op inside one.
   * With keys on, dropping a table another table references fails outright, so
   * the rebuild is impossible without this.
   */
  write<T>(
    work: (tx: SqlTransaction) => Promise<T>,
    options?: { deferForeignKeys?: boolean },
  ): Promise<T>;
}
