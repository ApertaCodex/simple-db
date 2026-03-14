import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { BaseDatabaseProvider } from './BaseDatabaseProvider';
import type { DatabaseType, SortConfig, UpdateResult } from './types';

// Lazy-loaded duckdb module (shared with DuckDBManager)
let duckdbModule: typeof import('duckdb') | null = null;
let duckdbLoadError: Error | null = null;

async function getDuckDB() {
	if (duckdbLoadError) {
		throw duckdbLoadError;
	}
	if (!duckdbModule) {
		duckdbModule = await import('duckdb');
		logger.info('DuckDB module loaded successfully (CSV provider)');
	}
	return duckdbModule;
}

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
 * CSV provider for Simple DB.
 *
 * Uses DuckDB in-memory to load and query CSV files via read_csv_auto().
 * The CSV file is treated as a single-table database where the table name
 * is the filename without extension.
 */
export class CSVManager extends BaseDatabaseProvider {

	getType(): DatabaseType {
		return 'csv';
	}

	/**
	 * Derive the virtual table name from the CSV file path.
	 */
	private getTableNameFromPath(csvPath: string): string {
		return path.basename(csvPath, path.extname(csvPath));
	}

	/**
	 * Build the escaped read_csv_auto() source expression for a file path.
	 */
	private csvSource(csvPath: string): string {
		const escaped = csvPath.replace(/'/g, "''");
		return `read_csv_auto('${escaped}')`;
	}

	/**
	 * Open an in-memory DuckDB instance. Each call creates a fresh connection.
	 */
	private async openMemoryDB(): Promise<{ db: import('duckdb').Database; conn: import('duckdb').Connection }> {
		const duckdb = await getDuckDB();
		return new Promise((resolve, reject) => {
			const db = new duckdb.Database(':memory:', (err: Error | null) => {
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
		// Verify the file exists
		await fs.promises.access(connectionPath, fs.constants.R_OK);
		return [this.getTableNameFromPath(connectionPath)];
	}

	async getTableData(
		connectionPath: string,
		_tableName: string,
		limit?: number,
		offset?: number,
		sortConfig?: SortConfig[]
	): Promise<any[]> {
		const { db, conn } = await this.openMemoryDB();

		const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit)
			? Math.max(0, Math.floor(limit))
			: undefined;
		const normalizedOffset = typeof offset === 'number' && Number.isFinite(offset)
			? Math.max(0, Math.floor(offset))
			: 0;

		let query = `SELECT * FROM ${this.csvSource(connectionPath)}`;

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

	async getRowCount(connectionPath: string, _tableName: string): Promise<number> {
		const { db, conn } = await this.openMemoryDB();
		const rows = await runQuery(conn, `SELECT COUNT(*) as count FROM ${this.csvSource(connectionPath)}`);
		await this.closeDB(db);
		return rows[0]?.count ?? 0;
	}

	async executeQuery(
		connectionPath: string,
		query: string,
		context?: { tableName?: string; limit?: number }
	): Promise<any[]> {
		const { db, conn } = await this.openMemoryDB();

		// Create a view so users can reference the table by name in their queries
		const viewName = context?.tableName || this.getTableNameFromPath(connectionPath);
		const safeName = viewName.replace(/"/g, '""');
		await runStatement(conn, `CREATE VIEW "${safeName}" AS SELECT * FROM ${this.csvSource(connectionPath)}`);

		const rows = await runQuery(conn, query);
		await this.closeDB(db);
		return rows;
	}

	async updateRecord(
		connectionPath: string,
		_tableName: string,
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

		// Strategy: load entire CSV into DuckDB, update in-memory, write back
		const { db, conn } = await this.openMemoryDB();

		// Load CSV into a writable table
		await runStatement(conn, `CREATE TABLE csv_data AS SELECT * FROM ${this.csvSource(connectionPath)}`);

		// Perform the update
		const setClause = updateColumns.map(col => `"${col.replace(/"/g, '""')}" = ?`).join(', ');
		const whereClauseSql = whereColumns.map(col => `"${col.replace(/"/g, '""')}" = ?`).join(' AND ');
		const sql = `UPDATE csv_data SET ${setClause} WHERE ${whereClauseSql}`;
		const params = [
			...updateColumns.map(col => updates[col]),
			...whereColumns.map(col => filter[col])
		];

		logger.info(`Executing CSV UPDATE via DuckDB: ${sql}`, { params });
		await runStatement(conn, sql, params);

		// Write updated data back to CSV
		const escaped = connectionPath.replace(/'/g, "''");
		await runStatement(conn, `COPY csv_data TO '${escaped}' (HEADER, DELIMITER ',')`);

		await this.closeDB(db);
		logger.info(`Updated record in CSV file: ${connectionPath}`);
		return { success: true, affectedCount: 1 };
	}

	async getRecordIdentifier(
		_connectionPath: string,
		_tableName: string,
		rowData: Record<string, any>
	): Promise<Record<string, any>> {
		// CSV has no primary key — use all column values as identifier
		const identifier: Record<string, any> = {};
		for (const key of Object.keys(rowData)) {
			identifier[key] = rowData[key];
		}
		return identifier;
	}

	async importFromJSON(connectionPath: string, _tableName: string, filePath: string): Promise<number> {
		const content = await fs.promises.readFile(filePath, 'utf8');
		const data = JSON.parse(content);

		if (!Array.isArray(data) || data.length === 0) {
			throw new Error('JSON file must contain a non-empty array of objects');
		}

		return this.appendToCSV(connectionPath, data);
	}

	async importFromCSV(connectionPath: string, _tableName: string, filePath: string): Promise<number> {
		const content = await fs.promises.readFile(filePath, 'utf8');
		const data = BaseDatabaseProvider.parseCSV(content);

		if (data.length === 0) {
			throw new Error('CSV file is empty or has no data rows');
		}

		return this.appendToCSV(connectionPath, data);
	}

	/**
	 * Append rows to the CSV file. Loads existing data + new rows via DuckDB, writes back.
	 */
	private async appendToCSV(csvPath: string, data: any[]): Promise<number> {
		const { db, conn } = await this.openMemoryDB();

		// Load existing CSV
		await runStatement(conn, `CREATE TABLE csv_data AS SELECT * FROM ${this.csvSource(csvPath)}`);

		// Insert new rows
		const columns = Object.keys(data[0]);
		const placeholders = columns.map(() => '?').join(', ');
		const insertSQL = `INSERT INTO csv_data (${columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ')}) VALUES (${placeholders})`;

		for (const row of data) {
			const values = columns.map(col => row[col] ?? null);
			await runStatement(conn, insertSQL, values);
		}

		// Write back
		const escaped = csvPath.replace(/'/g, "''");
		await runStatement(conn, `COPY csv_data TO '${escaped}' (HEADER, DELIMITER ',')`);

		await this.closeDB(db);
		return data.length;
	}
}
