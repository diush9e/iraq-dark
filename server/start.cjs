/**
 * Production entry point: serves the built UI (dist/) together with the API.
 *
 *   npm run build
 *   npm start
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

require('./server.cjs');
