import * as fs from 'fs';
import { logger } from './logger';

// Lazy-loaded sqlite3 module to prevent extension activation failures
let sqlite3Module: typeof import('@vscode/sqlite3') | null = null;
let sqlite3LoadError: Error | null = null;

async function getSqlite3() {
    if (sqlite3LoadError) {
        throw sqlite3LoadError;
    }
    if (!sqlite3Module) {
        try {
            sqlite3Module = await import('@vscode/sqlite3');
            logger.info('SQLite3 module loaded successfully');
        } catch (error) {
            sqlite3LoadError = error instanceof Error ? error : new Error(String(error));
            logger.error('Failed to load SQLite3 module', sqlite3LoadError);
            throw new Error(`Failed to load SQLite3 native module: ${sqlite3LoadError.message}. Please check the extension logs for details.`);
        }
    }
    return sqlite3Module;
}

export class SQLiteManager {
    async getTables(dbPath: string): Promise<string[]> {
        logger.debug(`Getting tables from SQLite database: ${dbPath}`);
        const sqlite3 = await getSqlite3();
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
        const sqlite3 = await getSqlite3();
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
        const sqlite3 = await getSqlite3();
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
        const sqlite3 = await getSqlite3();
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

    async importFromJSON(dbPath: string, tableName: string, jsonPath: string): Promise<number> {
        const content = await fs.promises.readFile(jsonPath, 'utf8');
        const data = JSON.parse(content);

        if (!Array.isArray(data) || data.length === 0) {
            throw new Error('JSON file must contain a non-empty array of objects');
        }

        return this.importData(dbPath, tableName, data);
    }

    async importFromCSV(dbPath: string, tableName: string, csvPath: string): Promise<number> {
        const content = await fs.promises.readFile(csvPath, 'utf8');
        const data = this.parseCSV(content);

        if (data.length === 0) {
            throw new Error('CSV file is empty or has no data rows');
        }

        return this.importData(dbPath, tableName, data);
    }

    private parseCSV(content: string): any[] {
        const lines = content.split(/\r?\n/).filter(line => line.trim());
        if (lines.length < 2) {
            return [];
        }

        const headers = this.parseCSVLine(lines[0]);
        const data: any[] = [];

        for (let i = 1; i < lines.length; i++) {
            const values = this.parseCSVLine(lines[i]);
            if (values.length === headers.length) {
                const row: any = {};
                headers.forEach((header, idx) => {
                    row[header] = values[idx];
                });
                data.push(row);
            }
        }

        return data;
    }

    private parseCSVLine(line: string): string[] {
        const values: string[] = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            const nextChar = line[i + 1];

            if (inQuotes) {
                if (char === '"' && nextChar === '"') {
                    current += '"';
                    i++;
                } else if (char === '"') {
                    inQuotes = false;
                } else {
                    current += char;
                }
            } else {
                if (char === '"') {
                    inQuotes = true;
                } else if (char === ',') {
                    values.push(current);
                    current = '';
                } else {
                    current += char;
                }
            }
        }
        values.push(current);

        return values;
    }

    private async importData(dbPath: string, tableName: string, data: any[]): Promise<number> {
        const sqlite3 = await getSqlite3();
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
                if (err) reject(err);
            });

            const columns = Object.keys(data[0]);
            const sanitizedTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '_');
            const columnDefs = columns.map(col => `"${col.replace(/"/g, '""')}" TEXT`).join(', ');
            const createTableSQL = `CREATE TABLE IF NOT EXISTS "${sanitizedTableName}" (${columnDefs})`;

            db.run(createTableSQL, (err) => {
                if (err) {
                    db.close();
                    reject(new Error(`Failed to create table: ${err.message}`));
                    return;
                }

                const placeholders = columns.map(() => '?').join(', ');
                const insertSQL = `INSERT INTO "${sanitizedTableName}" (${columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ')}) VALUES (${placeholders})`;

                const stmt = db.prepare(insertSQL, (err) => {
                    if (err) {
                        db.close();
                        reject(new Error(`Failed to prepare statement: ${err.message}`));
                        return;
                    }
                });

                let inserted = 0;
                db.serialize(() => {
                    db.run('BEGIN TRANSACTION');
                    for (const row of data) {
                        const values = columns.map(col => row[col] ?? null);
                        stmt.run(values, (err) => {
                            if (!err) inserted++;
                        });
                    }
                    db.run('COMMIT', (err) => {
                        stmt.finalize();
                        db.close();
                        if (err) {
                            reject(new Error(`Failed to commit: ${err.message}`));
                        } else {
                            resolve(inserted);
                        }
                    });
                });
            });
        });
    }
}
