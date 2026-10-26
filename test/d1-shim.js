/*
 * test/d1-shim.js  —  a D1-shaped wrapper around node:sqlite
 * ============================================================================
 * Cloudflare D1 is SQLite. This exposes the slice of the D1 binding API that
 * server/_lib/db-d1.js uses (prepare().bind().all(), batch()) over Node's
 * built-in SQLite, so the whole API suite can run against the real D1 driver
 * and the real db/d1/schema.sql with no Cloudflare account.
 *
 *   NAFUME_TEST_DB=d1 node test/run-tests.js
 */
"use strict";

const fs   = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

function createShim() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(fs.readFileSync(path.join(__dirname, "..", "db", "d1", "schema.sql"), "utf8"));

  function statement(sql, params) {
    return {
      bind: function () { return statement(sql, Array.prototype.slice.call(arguments)); },
      all: async function () {
        const s = sqlite.prepare(sql);
        return { results: s.all.apply(s, params).map(function (r) { return Object.assign({}, r); }) };
      },
      _runSync: function () {
        const s = sqlite.prepare(sql);
        return { results: s.all.apply(s, params).map(function (r) { return Object.assign({}, r); }) };
      }
    };
  }

  return {
    prepare: function (sql) { return statement(sql, []); },
    batch: async function (stmts) {
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map(function (s) { return s._runSync(); });
        sqlite.exec("COMMIT");
        return out;
      } catch (err) { sqlite.exec("ROLLBACK"); throw err; }
    },
    _reset: function () {
      const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      sqlite.exec("PRAGMA foreign_keys = OFF;");
      tables.forEach(function (t) { if (t.name !== "schema_migrations") sqlite.exec('DELETE FROM "' + t.name + '"'); });
      sqlite.exec("PRAGMA foreign_keys = ON;");
    },
    _sqlite: sqlite
  };
}

module.exports = { createShim };
