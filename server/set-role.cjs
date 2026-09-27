#!/usr/bin/env node
/**
 * Change a member's role from the command line.
 *
 *   npm run db:admin -- <username-or-email>      → promote to admin
 *   npm run db:admin -- <username-or-email> member → demote to member
 *   npm run db:admin -- --list                    → show every account + role
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'iraq-dark.db');

if (!fs.existsSync(dbPath)) {
  console.error(`✗ No database at ${dbPath}\n  Run "npm run db:init" first.`);
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const [, , rawTarget, rawRole] = process.argv;

if (!rawTarget || rawTarget === '--list') {
  const rows = db.prepare(`
    SELECT id, username, email, role, is_banned, created_at
    FROM users ORDER BY id
  `).all();

  if (!rows.length) {
    console.log('No accounts yet. Register one first, then promote it.');
    return;
  }

  console.log('\n  ID  USERNAME            ROLE     STATUS   EMAIL');
  console.log('  ──  ──────────────────  ───────  ───────  ─────────────────────');
  for (const row of rows) {
    console.log(
      `  ${String(row.id).padEnd(3)} ${row.username.padEnd(20)} ` +
      `${row.role.padEnd(8)} ${(row.is_banned ? 'banned' : 'active').padEnd(8)} ${row.email}`
    );
  }
  console.log('');
  return;
}

const role = rawRole === 'admin' ? 'admin' : 'member';
const user = db.prepare(`
  SELECT id, username, role FROM users
  WHERE username = ? OR lower(email) = lower(?)
`).get(rawTarget, rawTarget);

if (!user) {
  console.error(`✗ No account matches "${rawTarget}".`);
  console.error('  Run "npm run db:admin -- --list" to see every account.');
  process.exit(1);
}

db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);

console.log(`✓ ${user.username} is now ${role === 'admin' ? 'an ADMIN' : 'a member'}.`);
if (role === 'admin') {
  console.log('  They can open #/admin after signing in again.');
}
