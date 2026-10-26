import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export type Binding = string | number | bigint | null | Uint8Array;
export interface Statement {
  all(...bindings: Binding[]): Record<string, unknown>[];
  get(...bindings: Binding[]): Record<string, unknown> | undefined;
  run(...bindings: Binding[]): unknown;
}
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

export function openDatabase(filename: string): Database {
  // Pi's standalone executable uses Bun, which does not expose node:sqlite.
  if ("Bun" in globalThis) {
    const { Database }: typeof import("bun:sqlite") = require("bun:sqlite");
    const db = new Database(filename);
    return {
      exec(sql) { db.exec(sql); },
      prepare(sql) {
        const statement = db.prepare<Record<string, unknown>, Binding[]>(sql);
        return {
          all: (...bindings) => statement.all(...bindings),
          get: (...bindings) => statement.get(...bindings) ?? undefined,
          run: (...bindings) => statement.run(...bindings),
        };
      },
      close() { db.close(); },
    };
  }
  const { DatabaseSync }: typeof import("node:sqlite") = require("node:sqlite");
  return new DatabaseSync(filename);
}
