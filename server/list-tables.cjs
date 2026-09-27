const Database = require('better-sqlite3');
const db = new Database('./data/iraq-dark.db');

const tables = db.prepare(`
  SELECT name
  FROM sqlite_master
  WHERE type = 'table'
  ORDER BY name
`).all();

console.table(tables);
db.close();
