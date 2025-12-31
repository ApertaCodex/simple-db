import * as sqlite3 from '@vscode/sqlite3';

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

    async getTableData(dbPath: string, tableName: string): Promise<any[]> {
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) reject(err);
            });

            db.all(`SELECT * FROM ${tableName}`, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
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
