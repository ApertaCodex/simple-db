import * as sqlite3 from 'sqlite3';

export class SQLiteManager {
    async getTables(dbPath: string): Promise<string[]> {
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) reject(err);
            });

            db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows: any[]) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows.map(row => row.name));
                }
                db.close();
            });
        });
    }

    async getTableData(dbPath: string, tableName: string, limit?: number, offset?: number): Promise<any[]> {
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) reject(err);
            });

            const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit)
                ? Math.max(0, Math.floor(limit))
                : undefined;
            const normalizedOffset = typeof offset === 'number' && Number.isFinite(offset)
                ? Math.max(0, Math.floor(offset))
                : 0;
            let query = `SELECT * FROM ${tableName}`;
            if (normalizedLimit !== undefined) {
                query += ` LIMIT ${normalizedLimit}`;
                if (normalizedOffset > 0) {
                    query += ` OFFSET ${normalizedOffset}`;
                }
            }

            db.all(query, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
                db.close();
            });
        });
    }

    async getTableRowCount(dbPath: string, tableName: string): Promise<number> {
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) reject(err);
            });

            db.get(`SELECT COUNT(*) as count FROM ${tableName}`, [], (err, row: any) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row?.count ?? 0);
                }
                db.close();
            });
        });
    }

    async executeQuery(dbPath: string, query: string): Promise<any[]> {
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) reject(err);
            });

            db.all(query, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
                db.close();
            });
        });
    }
}
