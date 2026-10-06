import type { DB } from '../db.js';

export function ensureColumn(
  db: DB,
  table: string,
  column: string,
  decl: string,
): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

export function tableExists(db: DB, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}
