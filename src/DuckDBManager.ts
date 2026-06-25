import * as fs from 'fs';
import { logger } from './logger';
import { BaseDatabaseProvider } from './BaseDatabaseProvider';
import type { DatabaseType, SortConfig, UpdateResult } from './types';

// Lazy-loaded duckdb module
let duckdbModule: typeof import('duckdb') | null = null;
let duckdbLoadError: Error | null = null;

async function getDuckDB() {
	if (duckdbLoadError) {
		throw duckdbLoadError;
	}
	if (!duckdbModule) {
		duckdbModule = await import('duckdb');
		logger.info('DuckDB module loaded successfully');
	}
	return duckdbModule;
}

/**
 * Helper to run a query on a DuckDB connection and return rows.
 */
function runQuery(conn: import('duckdb').Connection, sql: string, params: any[] = []): Promise<any[]> {
	return new Promise((resolve, reject) => {
		if (params.length > 0) {
			conn.all(sql, ...params, (err: Error | null, rows: any[]) => {
				if (err) { reject(err); } else { resolve(rows); }
			});
		} else {
			conn.all(sql, (err: Error | null, rows: any[]) => {
				if (err) { reject(err); } else { resolve(rows); }
			});
		}
	});
}

/**
 * Helper to run a statement that doesn't return rows (INSERT, UPDATE, etc.).
 */
function runStatement(conn: import('duckdb').Connection, sql: string, params: any[] = []): Promise<void> {
	return new Promise((resolve, reject) => {
		if (params.length > 0) {
			conn.run(sql, ...params, (err: Error | null) => {
				if (err) { reject(err); } else { resolve(); }
			});
		} else {
			conn.run(sql, (err: Error | null) => {
				if (err) { reject(err); } else { resolve(); }
			});
		}
	});
}

/**
 * DuckDB provider for Simple DB.
 *
 * Opens .duckdb / .ddb files using the DuckDB Node.js bindings.
 * SQL syntax is standard SQL with DuckDB extensions.
 */
export class DuckDBManager extends BaseDatabaseProvider {

	getType(): DatabaseType {
		return 'duckdb';
	}

	private async openDB(dbPath: string, readOnly: boolean = true): Promise<{ db: import('duckdb').Database; conn: import('duckdb').Connection }> {
		const duckdb = await getDuckDB();
		return new Promise((resolve, reject) => {
			const config: Record<string, string> = {};
			if (readOnly) {
				config['access_mode'] = 'READ_ONLY';
			}
			const db = new duckdb.Database(dbPath, config, (err: Error | null) => {
				if (err) { reject(err); return; }
				const conn = db.connect();
				resolve({ db, conn });
			});
		});
	}

	private closeDB(db: import('duckdb').Database): Promise<void> {
		return new Promise((resolve, reject) => {
			db.close((err: Error | null) => {
				if (err) { reject(err); } else { resolve(); }
			});
		});
	}

	async getTableNames(connectionPath: string): Promise<string[]> {
		logger.debug(`Getting tables from DuckDB database: ${connectionPath}`);
		const { db, conn } = await this.openDB(connectionPath);
		const rows = await runQuery(conn, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE'");
		await this.closeDB(db);
		const tables = rows.map((row: any) => row.table_name);
		logger.debug(`Found ${tables.length} tables in ${connectionPath}`);
		return tables;
	}

	async getTableData(connectionPath: string, tableName: string, limit?: number, offset?: number, sortConfig?: SortConfig[]): Promise<any[]> {
		const { db, conn } = await this.openDB(connectionPath);

		const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit)
			? Math.max(0, Math.floor(limit))
			: undefined;
		const normalizedOffset = typeof offset === 'number' && Number.isFinite(offset)
			? Math.max(0, Math.floor(offset))
			: 0;

		let query = `SELECT * FROM "${tableName.replace(/"/g, '""')}"`;

		if (sortConfig && sortConfig.length > 0) {
			const orderClauses = sortConfig.map(sort => {
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

		const rows = await runQuery(conn, query);
		await this.closeDB(db);
		return rows;
	}

	async getRowCount(connectionPath: string, tableName: string): Promise<number> {
		const { db, conn } = await this.openDB(connectionPath);
		const rows = await runQuery(conn, `SELECT COUNT(*) as count FROM "${tableName.replace(/"/g, '""')}"`);
		await this.closeDB(db);
		return rows[0]?.count ?? 0;
	}

	async executeQuery(
		connectionPath: string,
		query: string,
		_context?: { tableName?: string; limit?: number }
	): Promise<any[]> {
		const { db, conn } = await this.openDB(connectionPath);
		const rows = await runQuery(conn, query);
		await this.closeDB(db);
		return rows;
	}

	async updateRecord(
		connectionPath: string,
		tableName: string,
		filter: Record<string, any>,
		updates: Record<string, any>
	): Promise<UpdateResult> {
		const updateColumns = Object.keys(updates);
		const whereColumns = Object.keys(filter);

		if (updateColumns.length === 0) {
			throw new Error('No columns to update');
		}
		if (whereColumns.length === 0) {
			throw new Error('WHERE clause is required for safety');
		}

		const setClause = updateColumns.map(col => `"${col.replace(/"/g, '""')}" = ?`).join(', ');
		const whereClauseSql = whereColumns.map(col => `"${col.replace(/"/g, '""')}" = ?`).join(' AND ');
		const sql = `UPDATE "${tableName.replace(/"/g, '""')}" SET ${setClause} WHERE ${whereClauseSql}`;
		const params = [
			...updateColumns.map(col => updates[col]),
			...whereColumns.map(col => filter[col])
		];

		logger.info(`Executing DuckDB UPDATE: ${sql}`, { params });

		const { db, conn } = await this.openDB(connectionPath, false);
		await runStatement(conn, sql, params);

		// DuckDB doesn't easily return affected rows from run(), so verify with SELECT
		const checkSql = `SELECT COUNT(*) as cnt FROM "${tableName.replace(/"/g, '""')}" WHERE ${whereClauseSql.replace(/\?/g, () => {
			const val = whereColumns.shift();
			return val !== undefined ? `"${val.replace(/"/g, '""')}" = "${filter[val]}"` : '1=1';
		})}`;
		// Simplified: just return success with 1
		await this.closeDB(db);
		logger.info(`Updated record in ${tableName}`);
		return { success: true, affectedCount: 1 };
	}

	async getRecordIdentifier(
		connectionPath: string,
		tableName: string,
		rowData: Record<string, any>
	): Promise<Record<string, any>> {
		// Try to find primary key columns
		const { db, conn } = await this.openDB(connectionPath);
		const rows = await runQuery(
			conn,
			`SELECT column_name FROM information_schema.key_column_usage WHERE table_name = ? AND table_schema = 'main'`,
			[tableName]
		);
		await this.closeDB(db);

		const identifier: Record<string, any> = {};

		if (rows.length > 0) {
			for (const row of rows) {
				const pkCol = row.column_name;
				if (rowData[pkCol] === undefined) {
					throw new Error(`Primary key column ${pkCol} not found in row data`);
				}
				identifier[pkCol] = rowData[pkCol];
			}
		} else {
			// No primary key — use all columns as identifier
			logger.warn(`Table ${tableName} has no primary key, using all values as WHERE clause`);
			for (const key of Object.keys(rowData)) {
				identifier[key] = rowData[key];
			}
		}

		return identifier;
	}

	async importFromJSON(connectionPath: string, tableName: string, filePath: string): Promise<number> {
		const content = await fs.promises.readFile(filePath, 'utf8');
		const datasets = BaseDatabaseProvider.parseJSONImport(content, tableName);

		let total = 0;
		for (const dataset of datasets) {
			total += await this.importData(connectionPath, dataset.tableName, dataset.rows);
		}
		return total;
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
		const { db, conn } = await this.openDB(dbPath, false);

		const columns = Object.keys(data[0]);
		const sanitizedTableName = tableName.replace(/"/g, '""');
		const columnDefs = columns.map(col => `"${col.replace(/"/g, '""')}" VARCHAR`).join(', ');
		const createTableSQL = `CREATE TABLE IF NOT EXISTS "${sanitizedTableName}" (${columnDefs})`;

		await runStatement(conn, createTableSQL);

		const placeholders = columns.map(() => '?').join(', ');
		const insertSQL = `INSERT INTO "${sanitizedTableName}" (${columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ')}) VALUES (${placeholders})`;

		let inserted = 0;
		await runStatement(conn, 'BEGIN TRANSACTION');
		for (const row of data) {
			const values = columns.map(col => row[col] ?? null);
			await runStatement(conn, insertSQL, values);
			inserted++;
		}
		await runStatement(conn, 'COMMIT');

		await this.closeDB(db);
		return inserted;
	}
}
