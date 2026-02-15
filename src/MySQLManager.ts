import * as fs from 'fs';
import { logger } from './logger';
import { BaseDatabaseProvider } from './BaseDatabaseProvider';
import type { DatabaseType, SortConfig, UpdateResult } from './types';

// Lazy-loaded mysql2 module
let mysql2Module: typeof import('mysql2/promise') | null = null;
let mysql2LoadError: Error | null = null;

async function getMysql2() {
	if (mysql2LoadError) {
		throw mysql2LoadError;
	}
	if (!mysql2Module) {
		mysql2Module = await import('mysql2/promise');
		logger.info('mysql2 module loaded successfully');
	}
	return mysql2Module;
}

export class MySQLManager extends BaseDatabaseProvider {

	getType(): DatabaseType {
		return 'mysql';
	}

	private async withConnection<T>(connectionString: string, fn: (conn: import('mysql2/promise').Connection) => Promise<T>): Promise<T> {
		const mysql2 = await getMysql2();
		const conn = await mysql2.createConnection(connectionString);
		try {
			return await fn(conn);
		} finally {
			await conn.end();
		}
	}

	async getTableNames(connectionString: string): Promise<string[]> {
		logger.debug(`Getting tables from MySQL: ${connectionString}`);
		return this.withConnection(connectionString, async (conn) => {
			const [rows] = await conn.query('SHOW TABLES');
			const tables = (rows as any[]).map((row: any) => Object.values(row)[0] as string);
			logger.debug(`Found ${tables.length} tables in MySQL`);
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
		return this.withConnection(connectionString, async (conn) => {
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
			const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit)
				? Math.max(0, Math.floor(limit))
				: undefined;
			const normalizedOffset = typeof offset === 'number' && Number.isFinite(offset)
				? Math.max(0, Math.floor(offset))
				: 0;

			if (normalizedLimit !== undefined) {
				query += ` LIMIT ?`;
				params.push(normalizedLimit);
				if (normalizedOffset > 0) {
					query += ` OFFSET ?`;
					params.push(normalizedOffset);
				}
			}

			const [rows] = await conn.query(query, params);
			return rows as any[];
		});
	}

	async getRowCount(connectionString: string, tableName: string): Promise<number> {
		return this.withConnection(connectionString, async (conn) => {
			const safeTable = this.quoteIdentifier(tableName);
			const [rows] = await conn.query(`SELECT COUNT(*) as count FROM ${safeTable}`);
			return (rows as any[])[0]?.count ?? 0;
		});
	}

	async executeQuery(
		connectionString: string,
		query: string,
		_context?: { tableName?: string; limit?: number }
	): Promise<any[]> {
		return this.withConnection(connectionString, async (conn) => {
			const [rows] = await conn.query(query);
			return Array.isArray(rows) ? rows : [rows];
		});
	}

	async updateRecord(
		connectionString: string,
		tableName: string,
		filter: Record<string, any>,
		updates: Record<string, any>
	): Promise<UpdateResult> {
		return this.withConnection(connectionString, async (conn) => {
			const updateKeys = Object.keys(updates);
			const filterKeys = Object.keys(filter);

			if (updateKeys.length === 0) {
				throw new Error('No columns to update');
			}
			if (filterKeys.length === 0) {
				throw new Error('WHERE clause is required for safety');
			}

			const setClauses = updateKeys.map(col => `${this.quoteIdentifier(col)} = ?`);
			const whereClauses = filterKeys.map(col => `${this.quoteIdentifier(col)} = ?`);

			const sql = `UPDATE ${this.quoteIdentifier(tableName)} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`;
			const params = [
				...updateKeys.map(col => updates[col]),
				...filterKeys.map(col => filter[col])
			];

			logger.info(`Executing MySQL UPDATE: ${sql}`, { params });
			const [result] = await conn.query(sql, params);
			const affectedCount = (result as any).affectedRows ?? 0;
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
		return this.withConnection(connectionString, async (conn) => {
			const [rows] = await conn.query(
				`SHOW KEYS FROM ${this.quoteIdentifier(tableName)} WHERE Key_name = 'PRIMARY'`
			);
			return (rows as any[]).map((row: any) => row.Column_name);
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
		return this.withConnection(connectionString, async (conn) => {
			const columns = Object.keys(data[0]);
			const safeTable = this.quoteIdentifier(tableName);

			// Create table if not exists (all TEXT columns for simplicity)
			const columnDefs = columns.map(col => `${this.quoteIdentifier(col)} TEXT`).join(', ');
			await conn.query(`CREATE TABLE IF NOT EXISTS ${safeTable} (${columnDefs})`);

			let inserted = 0;
			await conn.beginTransaction();

			for (const row of data) {
				const placeholders = columns.map(() => '?').join(', ');
				const colNames = columns.map(c => this.quoteIdentifier(c)).join(', ');
				const values = columns.map(col => row[col] ?? null);

				await conn.query(
					`INSERT INTO ${safeTable} (${colNames}) VALUES (${placeholders})`,
					values
				);
				inserted++;
			}

			await conn.commit();
			return inserted;
		});
	}

	private quoteIdentifier(name: string): string {
		return `\`${name.replace(/`/g, '``')}\``;
	}
}
