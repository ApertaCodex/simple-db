import * as fs from 'fs';
import { logger } from './logger';
import { BaseDatabaseProvider } from './BaseDatabaseProvider';
import type { DatabaseType, SortConfig, UpdateResult } from './types';

// Lazy-loaded @libsql/client module
let libsqlModule: typeof import('@libsql/client') | null = null;
let libsqlLoadError: Error | null = null;

async function getLibsql() {
	if (libsqlLoadError) {
		throw libsqlLoadError;
	}
	if (!libsqlModule) {
		libsqlModule = await import('@libsql/client');
		logger.info('@libsql/client module loaded successfully');
	}
	return libsqlModule;
}

/**
 * LibSQL / Turso provider for Simple DB.
 *
 * Connection string formats:
 *   - Local: file:path/to/db.db
 *   - Remote: libsql://your-db.turso.io?authToken=TOKEN
 *   - HTTP:  https://your-db.turso.io  (with authToken)
 */
export class LibSQLManager extends BaseDatabaseProvider {

	getType(): DatabaseType {
		return 'libsql';
	}

	private async createClient(connectionString: string): Promise<import('@libsql/client').Client> {
		const libsql = await getLibsql();

		// Parse authToken from query string if present
		let url = connectionString;
		let authToken: string | undefined;

		const tokenMatch = connectionString.match(/[?&]authToken=([^&]+)/);
		if (tokenMatch) {
			authToken = tokenMatch[1];
			url = connectionString.replace(/[?&]authToken=[^&]+/, '');
		}

		return libsql.createClient({ url, authToken });
	}

	private async withClient<T>(connectionString: string, fn: (client: import('@libsql/client').Client) => Promise<T>): Promise<T> {
		const client = await this.createClient(connectionString);
		try {
			return await fn(client);
		} finally {
			client.close();
		}
	}

	async getTableNames(connectionString: string): Promise<string[]> {
		logger.debug(`Getting tables from LibSQL: ${connectionString}`);
		return this.withClient(connectionString, async (client) => {
			const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
			const tables = result.rows.map((row: any) => String(row.name ?? row[0]));
			logger.debug(`Found ${tables.length} tables in LibSQL`);
			return tables;
		});
	}

	async getTableData(
		connectionString: string,
		tableName: string,
		limit?: number,
		offset?: number,
		sortConfig?: SortConfig[]
	): Promise<any[]> {
		return this.withClient(connectionString, async (client) => {
			const safeTable = this.quoteIdentifier(tableName);
			let query = `SELECT * FROM ${safeTable}`;

			if (sortConfig && sortConfig.length > 0) {
				const orderClauses = sortConfig.map(sort => {
					const safeCol = this.quoteIdentifier(sort.col);
					return `${safeCol} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
				});
				query += ` ORDER BY ${orderClauses.join(', ')}`;
			}

			const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit)
				? Math.max(0, Math.floor(limit))
				: undefined;
			const normalizedOffset = typeof offset === 'number' && Number.isFinite(offset)
				? Math.max(0, Math.floor(offset))
				: 0;

			if (normalizedLimit !== undefined) {
				query += ` LIMIT ${normalizedLimit}`;
				if (normalizedOffset > 0) {
					query += ` OFFSET ${normalizedOffset}`;
				}
			}

			const result = await client.execute(query);
			// Convert ResultSet rows to plain objects
			return result.rows.map(row => this.rowToObject(row, result.columns));
		});
	}

	async getRowCount(connectionString: string, tableName: string): Promise<number> {
		return this.withClient(connectionString, async (client) => {
			const safeTable = this.quoteIdentifier(tableName);
			const result = await client.execute(`SELECT COUNT(*) as count FROM ${safeTable}`);
			const row = result.rows[0];
			return Number(row?.count ?? row?.[0] ?? 0);
		});
	}

	async executeQuery(
		connectionString: string,
		query: string,
		_context?: { tableName?: string; limit?: number }
	): Promise<any[]> {
		return this.withClient(connectionString, async (client) => {
			const result = await client.execute(query);
			return result.rows.map(row => this.rowToObject(row, result.columns));
		});
	}

	async updateRecord(
		connectionString: string,
		tableName: string,
		filter: Record<string, any>,
		updates: Record<string, any>
	): Promise<UpdateResult> {
		return this.withClient(connectionString, async (client) => {
			const updateKeys = Object.keys(updates);
			const filterKeys = Object.keys(filter);

			if (updateKeys.length === 0) {
				throw new Error('No columns to update');
			}
			if (filterKeys.length === 0) {
				throw new Error('WHERE clause is required for safety');
			}

			const setClauses = updateKeys.map(col =>
				`${this.quoteIdentifier(col)} = ?`
			);
			const whereClauses = filterKeys.map(col =>
				`${this.quoteIdentifier(col)} = ?`
			);

			const sql = `UPDATE ${this.quoteIdentifier(tableName)} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`;
			const args = [
				...updateKeys.map(col => updates[col]),
				...filterKeys.map(col => filter[col])
			];

			logger.info(`Executing LibSQL UPDATE: ${sql}`, { args });
			const result = await client.execute({ sql, args });
			const affectedCount = result.rowsAffected;
			logger.info(`Updated ${affectedCount} row(s) in ${tableName}`);
			return { success: true, affectedCount };
		});
	}

	async getRecordIdentifier(
		connectionString: string,
		tableName: string,
		rowData: Record<string, any>
	): Promise<Record<string, any>> {
		const primaryKeys = await this.getTablePrimaryKeys(connectionString, tableName);
		const identifier: Record<string, any> = {};

		if (primaryKeys.length === 0) {
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

	private async getTablePrimaryKeys(connectionString: string, tableName: string): Promise<string[]> {
		return this.withClient(connectionString, async (client) => {
			const result = await client.execute(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`);
			return result.rows
				.filter((row: any) => {
					const pk = row.pk ?? row[5];
					return Number(pk) > 0;
				})
				.map((row: any) => String(row.name ?? row[1]));
		});
	}

	async importFromJSON(connectionString: string, tableName: string, filePath: string): Promise<number> {
		const content = await fs.promises.readFile(filePath, 'utf8');
		const data = JSON.parse(content);

		if (!Array.isArray(data) || data.length === 0) {
			throw new Error('JSON file must contain a non-empty array of objects');
		}

		return this.importData(connectionString, tableName, data);
	}

	async importFromCSV(connectionString: string, tableName: string, filePath: string): Promise<number> {
		const content = await fs.promises.readFile(filePath, 'utf8');
		const data = BaseDatabaseProvider.parseCSV(content);

		if (data.length === 0) {
			throw new Error('CSV file is empty or has no data rows');
		}

		return this.importData(connectionString, tableName, data);
	}

	private async importData(connectionString: string, tableName: string, data: any[]): Promise<number> {
		return this.withClient(connectionString, async (client) => {
			const columns = Object.keys(data[0]);
			const safeTable = this.quoteIdentifier(tableName);

			// Create table if not exists
			const columnDefs = columns.map(col => `${this.quoteIdentifier(col)} TEXT`).join(', ');
			await client.execute(`CREATE TABLE IF NOT EXISTS ${safeTable} (${columnDefs})`);

			let inserted = 0;

			// LibSQL supports batch — use it for efficiency
			const statements = data.map(row => {
				const placeholders = columns.map(() => '?').join(', ');
				const colNames = columns.map(c => this.quoteIdentifier(c)).join(', ');
				const args = columns.map(col => row[col] ?? null);
				return { sql: `INSERT INTO ${safeTable} (${colNames}) VALUES (${placeholders})`, args };
			});

			const results = await client.batch(statements, 'write');
			for (const r of results) {
				inserted += r.rowsAffected;
			}

			return inserted;
		});
	}

	private quoteIdentifier(name: string): string {
		return `"${name.replace(/"/g, '""')}"`;
	}

	/**
	 * Convert a libsql Row (which may be array-like) to a plain object using column names.
	 */
	private rowToObject(row: any, columns: string[]): Record<string, any> {
		// If the row is already a plain object with named keys, return it
		if (row && typeof row === 'object' && !Array.isArray(row)) {
			const obj: Record<string, any> = {};
			for (const col of columns) {
				obj[col] = row[col];
			}
			return obj;
		}
		// Array-indexed row
		const obj: Record<string, any> = {};
		for (let i = 0; i < columns.length; i++) {
			obj[columns[i]] = row[i];
		}
		return obj;
	}
}
