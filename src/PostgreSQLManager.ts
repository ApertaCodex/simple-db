import * as fs from 'fs';
import { logger } from './logger';
import { BaseDatabaseProvider } from './BaseDatabaseProvider';
import type { DatabaseType, SortConfig, UpdateResult } from './types';

// Lazy-loaded pg module
let pgModule: typeof import('pg') | null = null;
let pgLoadError: Error | null = null;

async function getPg() {
	if (pgLoadError) {
		throw pgLoadError;
	}
	if (!pgModule) {
		pgModule = await import('pg');
		logger.info('pg module loaded successfully');
	}
	return pgModule;
}

export class PostgreSQLManager extends BaseDatabaseProvider {

	getType(): DatabaseType {
		return 'postgresql';
	}

	private async withClient<T>(connectionString: string, fn: (client: import('pg').Client) => Promise<T>): Promise<T> {
		const pg = await getPg();
		const client = new pg.Client({ connectionString });
		await client.connect();
		try {
			return await fn(client);
		} finally {
			await client.end();
		}
	}

	async getTableNames(connectionString: string): Promise<string[]> {
		logger.debug(`Getting tables from PostgreSQL: ${connectionString}`);
		return this.withClient(connectionString, async (client) => {
			const result = await client.query(
				`SELECT table_name FROM information_schema.tables
				 WHERE table_schema = 'public'
				 ORDER BY table_name`
			);
			const tables = result.rows.map((row: any) => row.table_name);
			logger.debug(`Found ${tables.length} tables in PostgreSQL`);
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

			const params: any[] = [];
			let paramIndex = 1;

			const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit)
				? Math.max(0, Math.floor(limit))
				: undefined;
			const normalizedOffset = typeof offset === 'number' && Number.isFinite(offset)
				? Math.max(0, Math.floor(offset))
				: 0;

			if (normalizedLimit !== undefined) {
				query += ` LIMIT $${paramIndex++}`;
				params.push(normalizedLimit);
				if (normalizedOffset > 0) {
					query += ` OFFSET $${paramIndex++}`;
					params.push(normalizedOffset);
				}
			}

			const result = await client.query(query, params);
			return result.rows;
		});
	}

	async getRowCount(connectionString: string, tableName: string): Promise<number> {
		return this.withClient(connectionString, async (client) => {
			const safeTable = this.quoteIdentifier(tableName);
			const result = await client.query(`SELECT COUNT(*) as count FROM ${safeTable}`);
			return parseInt(result.rows[0]?.count ?? '0', 10);
		});
	}

	async executeQuery(
		connectionString: string,
		query: string,
		_context?: { tableName?: string; limit?: number }
	): Promise<any[]> {
		return this.withClient(connectionString, async (client) => {
			const result = await client.query(query);
			return result.rows;
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

			let paramIndex = 1;
			const setClauses = updateKeys.map(col =>
				`${this.quoteIdentifier(col)} = $${paramIndex++}`
			);
			const whereClauses = filterKeys.map(col =>
				`${this.quoteIdentifier(col)} = $${paramIndex++}`
			);

			const sql = `UPDATE ${this.quoteIdentifier(tableName)} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`;
			const params = [
				...updateKeys.map(col => updates[col]),
				...filterKeys.map(col => filter[col])
			];

			logger.info(`Executing PostgreSQL UPDATE: ${sql}`, { params });
			const result = await client.query(sql, params);
			const affectedCount = result.rowCount ?? 0;
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
			const result = await client.query(
				`SELECT a.attname
				 FROM pg_index i
				 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
				 WHERE i.indrelid = $1::regclass AND i.indisprimary`,
				[tableName]
			);
			return result.rows.map((row: any) => row.attname);
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

			// Create table if not exists (all TEXT columns for simplicity)
			const columnDefs = columns.map(col => `${this.quoteIdentifier(col)} TEXT`).join(', ');
			await client.query(`CREATE TABLE IF NOT EXISTS ${safeTable} (${columnDefs})`);

			let inserted = 0;
			await client.query('BEGIN');

			for (const row of data) {
				const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
				const colNames = columns.map(c => this.quoteIdentifier(c)).join(', ');
				const values = columns.map(col => row[col] ?? null);

				await client.query(
					`INSERT INTO ${safeTable} (${colNames}) VALUES (${placeholders})`,
					values
				);
				inserted++;
			}

			await client.query('COMMIT');
			return inserted;
		});
	}

	private quoteIdentifier(name: string): string {
		return `"${name.replace(/"/g, '""')}"`;
	}
}
