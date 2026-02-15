import * as fs from 'fs';
import { logger } from './logger';
import { BaseDatabaseProvider } from './BaseDatabaseProvider';
import type { DatabaseType, SortConfig, UpdateResult } from './types';

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

export class SQLiteManager extends BaseDatabaseProvider {

    getType(): DatabaseType {
        return 'sqlite';
    }

    async getTableNames(connectionPath: string): Promise<string[]> {
        return this.getTablesInternal(connectionPath);
    }

    private async getTablesInternal(dbPath: string): Promise<string[]> {
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

    async getTableData(dbPath: string, tableName: string, limit?: number, offset?: number, sortConfig?: SortConfig[]): Promise<any[]> {
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
            let query = `SELECT * FROM "${tableName}"`;

            // Add ORDER BY clause if sortConfig is provided
            if (sortConfig && sortConfig.length > 0) {
                const orderClauses = sortConfig.map(sort => {
                    // Sanitize column name to prevent SQL injection
                    const safeCol = sort.col.replace(/"/g, '""');
                    const direction = sort.dir === 'desc' ? 'DESC' : 'ASC';
                    return `"${safeCol}" ${direction}`;
                });
                query += ` ORDER BY ${orderClauses.join(', ')}`;
            }

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

    async getRowCount(connectionPath: string, tableName: string): Promise<number> {
        return this.getRowCountInternal(connectionPath, tableName);
    }

    private async getRowCountInternal(dbPath: string, tableName: string): Promise<number> {
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

    async executeQuery(
        connectionPath: string,
        query: string,
        _context?: { tableName?: string; limit?: number }
    ): Promise<any[]> {
        const sqlite3 = await getSqlite3();
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(connectionPath, sqlite3.OPEN_READONLY, (err) => {
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

    async getTablePrimaryKeys(dbPath: string, tableName: string): Promise<string[]> {
        const sqlite3 = await getSqlite3();
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) reject(err);
            });

            db.all(`PRAGMA table_info("${tableName}")`, [], (err, rows: any[]) => {
                if (err) {
                    logger.error(`Failed to get table info for ${tableName}`, err);
                    db.close();
                    reject(err);
                } else {
                    const primaryKeys = rows.filter(row => row.pk > 0).map(row => row.name);
                    logger.debug(`Primary keys for ${tableName}: ${primaryKeys.join(', ')}`);
                    db.close();
                    resolve(primaryKeys);
                }
            });
        });
    }

    async getColumnInfo(dbPath: string, tableName: string): Promise<Array<{ name: string; type: string; notnull: boolean; pk: boolean }>> {
        const sqlite3 = await getSqlite3();
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) reject(err);
            });

            db.all(`PRAGMA table_info("${tableName}")`, [], (err, rows: any[]) => {
                if (err) {
                    logger.error(`Failed to get column info for ${tableName}`, err);
                    db.close();
                    reject(err);
                } else {
                    const columns = rows.map(row => ({
                        name: row.name,
                        type: row.type,
                        notnull: row.notnull === 1,
                        pk: row.pk > 0
                    }));
                    logger.debug(`Column info for ${tableName}: ${columns.length} columns`);
                    db.close();
                    resolve(columns);
                }
            });
        });
    }

    async updateRecord(
        connectionPath: string,
        tableName: string,
        filter: Record<string, any>,
        updates: Record<string, any>
    ): Promise<UpdateResult> {
        const sqlite3 = await getSqlite3();
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(connectionPath, sqlite3.OPEN_READWRITE, (err) => {
                if (err) {
                    logger.error(`Failed to open database for update: ${connectionPath}`, err);
                    reject(err);
                    return;
                }
            });

            // Build UPDATE statement with parameterized queries
            const updateColumns = Object.keys(updates);
            const whereColumns = Object.keys(filter);

            if (updateColumns.length === 0) {
                db.close();
                reject(new Error('No columns to update'));
                return;
            }

            if (whereColumns.length === 0) {
                db.close();
                reject(new Error('WHERE clause is required for safety'));
                return;
            }

            const setClause = updateColumns.map(col => `"${col.replace(/"/g, '""')}" = ?`).join(', ');
            const whereClauseSql = whereColumns.map(col => `"${col.replace(/"/g, '""')}" = ?`).join(' AND ');
            const sql = `UPDATE "${tableName.replace(/"/g, '""')}" SET ${setClause} WHERE ${whereClauseSql}`;

            const params = [
                ...updateColumns.map(col => updates[col]),
                ...whereColumns.map(col => filter[col])
            ];

            logger.info(`Executing UPDATE: ${sql}`, { params });

            db.run(sql, params, function(err) {
                if (err) {
                    logger.error(`Failed to update record in ${tableName}`, err);
                    db.close();
                    reject(err);
                } else {
                    const affectedCount = this.changes;
                    logger.info(`Updated ${affectedCount} row(s) in ${tableName}`);
                    db.close();
                    resolve({ success: true, affectedCount });
                }
            });
        });
    }

    async getRecordIdentifier(
        connectionPath: string,
        tableName: string,
        rowData: Record<string, any>
    ): Promise<Record<string, any>> {
        const primaryKeys = await this.getTablePrimaryKeys(connectionPath, tableName);
        const identifier: Record<string, any> = {};

        if (primaryKeys.length === 0) {
            // No primary key — use all columns except the one being updated as identifier
            logger.warn(`Table ${tableName} has no primary key, using all values as WHERE clause`);
            for (const key of Object.keys(rowData)) {
                identifier[key] = rowData[key];
            }
        } else {
            for (const pkCol of primaryKeys) {
                if (rowData[pkCol] === undefined) {
                    throw new Error(`Primary key column ${pkCol} not found in row data`);
                }
                identifier[pkCol] = rowData[pkCol];
            }
        }
        return identifier;
    }

    // Export/import — use base class implementations; override only import

    async importFromJSON(connectionPath: string, tableName: string, filePath: string): Promise<number> {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const data = JSON.parse(content);

        if (!Array.isArray(data) || data.length === 0) {
            throw new Error('JSON file must contain a non-empty array of objects');
        }

        return this.importData(connectionPath, tableName, data);
    }

    async importFromCSV(connectionPath: string, tableName: string, filePath: string): Promise<number> {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const data = BaseDatabaseProvider.parseCSV(content);

        if (data.length === 0) {
            throw new Error('CSV file is empty or has no data rows');
        }

        return this.importData(connectionPath, tableName, data);
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
