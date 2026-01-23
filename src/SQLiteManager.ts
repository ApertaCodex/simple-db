import * as sqlite3 from '@vscode/sqlite3';
import * as fs from 'fs';
import { logger } from './logger';

export class SQLiteManager {
    async getTables(dbPath: string): Promise<string[]> {
        logger.debug(`Getting tables from SQLite database: ${dbPath}`);
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) reject(err);
            });

            db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows: any[]) => {
                if (err) {
                    logger.error(`Failed to get tables from ${dbPath}`, err);
                    reject(err);
                } else {
                    const tables = rows.map(row => row.name);
                    logger.debug(`Found ${tables.length} tables in ${dbPath}`);
                    resolve(tables);
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

    async exportToJSON(dbPath: string, tableName: string, outputPath: string, data?: any[]): Promise<string> {
        try {
            const exportData = data ?? await this.getTableData(dbPath, tableName);
            const jsonData = JSON.stringify(exportData, null, 2);
            await fs.promises.writeFile(outputPath, jsonData, 'utf8');
            return outputPath;
        } catch (error) {
            throw new Error(`Failed to export table ${tableName} to JSON: ${error}`);
        }
    }

    async exportToCSV(dbPath: string, tableName: string, outputPath: string, data?: any[]): Promise<string> {
        try {
            const exportData = data ?? await this.getTableData(dbPath, tableName);

            if (exportData.length === 0) {
                throw new Error(`No data to export`);
            }

            const headers = Object.keys(exportData[0]);
            const csvRows = [headers.join(',')];

            for (const row of exportData) {
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
            await fs.promises.writeFile(outputPath, csvData, 'utf8');
            return outputPath;
        } catch (error) {
            throw new Error(`Failed to export table ${tableName} to CSV: ${error}`);
        }
    }

    static dataToJSON(data: any[]): string {
        return JSON.stringify(data, null, 2);
    }

    static dataToCSV(data: any[]): string {
        if (data.length === 0) {
            return '';
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

        return csvRows.join('\n');
    }
}
