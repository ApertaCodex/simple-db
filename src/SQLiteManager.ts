import * as sqlite3 from 'sqlite3';
import * as fs from 'fs';
import * as path from 'path';

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

    async exportToJSON(dbPath: string, tableName: string, outputPath?: string): Promise<string> {
        try {
            const data = await this.getTableData(dbPath, tableName);
            
            const jsonData = JSON.stringify(data, null, 2);
            
            if (!outputPath) {
                const fileName = `${tableName}_${new Date().toISOString().slice(0, 10)}.json`;
                outputPath = path.join(path.dirname(dbPath), fileName);
            }
            
            await fs.promises.writeFile(outputPath, jsonData, 'utf8');
            return outputPath;
        } catch (error) {
            throw new Error(`Failed to export table ${tableName} to JSON: ${error}`);
        }
    }

    async exportToCSV(dbPath: string, tableName: string, outputPath?: string): Promise<string> {
        try {
            const data = await this.getTableData(dbPath, tableName);
            
            if (data.length === 0) {
                throw new Error(`Table ${tableName} is empty`);
            }
            
            const headers = Object.keys(data[0]);
            const csvRows = [headers.join(',')];
            
            for (const row of data) {
                const values = headers.map(header => {
                    const value = row[header];
                    if (value === null || value === undefined) {
                        return '';
                    }
                    const stringValue = String(value);
                    if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
                        return `"${stringValue.replace(/"/g, '""')}"`;
                    }
                    return stringValue;
                });
                csvRows.push(values.join(','));
            }
            
            const csvData = csvRows.join('\n');
            
            if (!outputPath) {
                const fileName = `${tableName}_${new Date().toISOString().slice(0, 10)}.csv`;
                outputPath = path.join(path.dirname(dbPath), fileName);
            }
            
            await fs.promises.writeFile(outputPath, csvData, 'utf8');
            return outputPath;
        } catch (error) {
            throw new Error(`Failed to export table ${tableName} to CSV: ${error}`);
        }
    }
}
