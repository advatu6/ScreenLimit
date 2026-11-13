'use strict';
const Database = require('better-sqlite3');

/** Opens (and creates on first run) the SQLite database that holds everything. */
module.exports = function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, username TEXT NOT NULL, uname TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL, hash TEXT NOT NULL, rec_salt TEXT, rec_hash TEXT,
      admin INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens(
      hash TEXT PRIMARY KEY, uid TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS tokens_uid ON tokens(uid);
    CREATE TABLE IF NOT EXISTS docs(
      path TEXT PRIMARY KEY, coll TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS docs_coll ON docs(coll);
    CREATE TABLE IF NOT EXISTS files(
      id TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS files_uid ON files(uid);
  `);
  return db;
};
