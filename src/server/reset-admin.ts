// Recovery tool: resets the admin login to admin/admin and forces a password change on next sign-in.
// Usage: node dist/server/reset-admin.js   (reads DATA_DIR, default /data)
import { join } from 'node:path';
import { openAppDb } from './appdb.js';
import { createUsers } from './users.js';

const dataDir = process.env.DATA_DIR || '/data';
const db = openAppDb(join(dataDir, 'sqlmcp.db'));
createUsers(db).resetAdmin();
db.close();
console.log(`Admin login reset to admin/admin in ${dataDir}/sqlmcp.db. You will be asked to set a new password when you sign in.`);
