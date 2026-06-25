import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from './logger';
import { BaseDatabaseProvider } from './BaseDatabaseProvider';
import type { DatabaseType, SortConfig, UpdateResult } from './types';

// Lazy-loaded duckdb module (shared with DuckDBManager / CSVManager)
let duckdbModule: typeof import('duckdb') | null = null;
let duckdbLoadError: Error | null = null;

// Monotonic counter for unique temp file names during executeQuery.
let tempFileCounter = 0;

async function getDuckDB() {
	if (duckdbLoadError) {
		throw duckdbLoadError;
	}
	if (!duckdbModule) {
		duckdbModule = await import('duckdb');
		logger.info('DuckDB module loaded successfully (JSON provider)');
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
 * In-memory representation of a parsed JSON data-source file.
 *
 * `shape` records how the file was originally written so it can be
 * round-tripped back to disk in the same form:
 *   - 'array'  → a top-level array of objects (single table).
 *   - 'object' → an object mapping table names to arrays of objects.
 * `order` preserves table ordering; `tables` maps table name → rows.
 */
interface JSONDatasets {
	shape: 'array' | 'object';
	order: string[];
	tables: Record<string, any[]>;
}

/**
 * JSON provider for Simple DB.
 *
 * Treats a `.json` file as a database. Two file shapes are supported:
 *   - An array of objects `[{...}, {...}]` → a single table whose name is
 *     the filename without extension.
 *   - An object mapping table names to arrays of objects
 *     `{ "users": [{...}], "orders": [{...}] }` → one table per key.
 *
 * Reads, row counts, sorting/paging and edits are handled in pure
 * JavaScript. `executeQuery` loads the datasets into an in-memory DuckDB
 * instance (via read_json_auto) so the SQL Query panel works just like CSV.
 */
export class JSONManager extends BaseDatabaseProvider {

	getType(): DatabaseType {
		return 'json';
	}

	/**
	 * Derive the default (single-table) name from the JSON file path.
	 */
	private getTableNameFromPath(jsonPath: string): string {
		return path.basename(jsonPath, path.extname(jsonPath));
	}

	/**
	 * Read and parse the JSON file into named datasets, detecting the shape.
	 * An empty / whitespace-only file is treated as an empty single table.
	 */
	private async readDatasets(connectionPath: string): Promise<JSONDatasets> {
		const content = await fs.promises.readFile(connectionPath, 'utf8');
		const trimmed = content.trim();
		const parsed = trimmed.length ? JSON.parse(trimmed) : [];

		// Shape 1 — array of objects → single table named after the file.
		if (Array.isArray(parsed)) {
			const name = this.getTableNameFromPath(connectionPath);
			return { shape: 'array', order: [name], tables: { [name]: parsed } };
		}

		// Shape 2 — object whose array-valued keys are tables.
		if (parsed && typeof parsed === 'object') {
			const order: string[] = [];
			const tables: Record<string, any[]> = {};
			for (const [key, value] of Object.entries(parsed)) {
				if (Array.isArray(value)) {
					order.push(key);
					tables[key] = value;
				}
			}
			return { shape: 'object', order, tables };
		}

		throw new Error(
			'JSON file must be an array of objects, or an object mapping table names to arrays of objects'
		);
	}

	/**
	 * Serialize datasets back to disk, preserving the original shape.
	 * A single-table file that started life as an array stays an array.
	 */
	private async writeDatasets(connectionPath: string, ds: JSONDatasets): Promise<void> {
		let out: any;
		if (ds.shape === 'array' && ds.order.length === 1) {
			out = ds.tables[ds.order[0]] ?? [];
		} else {
			out = {};
			for (const name of ds.order) {
				out[name] = ds.tables[name];
			}
		}
		await fs.promises.writeFile(connectionPath, JSON.stringify(out, null, 2), 'utf8');
	}

	/**
	 * Resolve the rows for a table name. Falls back to the lone table for
	 * single-table (array-shaped) files when the name doesn't match.
	 */
	private rowsFor(ds: JSONDatasets, tableName: string): any[] {
		if (Object.prototype.hasOwnProperty.call(ds.tables, tableName)) {
			return ds.tables[tableName];
		}
		if (ds.shape === 'array' && ds.order.length === 1) {
			return ds.tables[ds.order[0]];
		}
		return [];
	}

	async getTableNames(connectionPath: string): Promise<string[]> {
		const ds = await this.readDatasets(connectionPath);
		return ds.order;
	}

	async getTableData(
		connectionPath: string,
		tableName: string,
		limit?: number,
		offset?: number,
		sortConfig?: SortConfig[]
	): Promise<any[]> {
		const ds = await this.readDatasets(connectionPath);
		let rows = this.rowsFor(ds, tableName).slice();

		if (sortConfig && sortConfig.length > 0) {
			rows.sort((a, b) => {
				for (const sort of sortConfig) {
					const cmp = JSONManager.compareValues(a?.[sort.col], b?.[sort.col]);
					if (cmp !== 0) {
						return sort.dir === 'desc' ? -cmp : cmp;
					}
				}
				return 0;
			});
		}

		const normalizedOffset = typeof offset === 'number' && Number.isFinite(offset)
			? Math.max(0, Math.floor(offset))
			: 0;
		if (normalizedOffset > 0) {
			rows = rows.slice(normalizedOffset);
		}

		if (typeof limit === 'number' && Number.isFinite(limit)) {
			rows = rows.slice(0, Math.max(0, Math.floor(limit)));
		}

		return rows;
	}

	async getRowCount(connectionPath: string, tableName: string): Promise<number> {
		const ds = await this.readDatasets(connectionPath);
		return this.rowsFor(ds, tableName).length;
	}

	async executeQuery(
		connectionPath: string,
		query: string,
		_context?: { tableName?: string; limit?: number }
	): Promise<any[]> {
		const ds = await this.readDatasets(connectionPath);
		const { db, conn } = await this.openMemoryDB();
		const tempFiles: string[] = [];

		try {
			// Load each non-empty dataset into a real DuckDB table so it can be
			// referenced by name in the query. DuckDB infers the schema from a
			// plain JSON array written to a temp file.
			for (const name of ds.order) {
				const rows = ds.tables[name] ?? [];
				if (rows.length === 0) {
					continue;
				}
				const tmp = path.join(
					os.tmpdir(),
					`simpledb-json-${process.pid}-${tempFileCounter++}.json`
				);
				await fs.promises.writeFile(tmp, JSON.stringify(rows), 'utf8');
				tempFiles.push(tmp);

				const safeName = name.replace(/"/g, '""');
				const escaped = tmp.replace(/'/g, "''");
				await runStatement(
					conn,
					`CREATE TABLE "${safeName}" AS SELECT * FROM read_json_auto('${escaped}')`
				);
			}

			return await runQuery(conn, query);
		} finally {
			try { await this.closeDB(db); } catch { /* ignore */ }
			await Promise.all(
				tempFiles.map(f => fs.promises.unlink(f).catch(() => { /* ignore */ }))
			);
		}
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

		const ds = await this.readDatasets(connectionPath);
		const rows = this.rowsFor(ds, tableName);

		let affectedCount = 0;
		for (const row of rows) {
			if (whereColumns.every(col => JSONManager.looseEquals(row?.[col], filter[col]))) {
				for (const col of updateColumns) {
					row[col] = updates[col];
				}
				affectedCount++;
			}
		}

		if (affectedCount > 0) {
			await this.writeDatasets(connectionPath, ds);
			logger.info(`Updated ${affectedCount} record(s) in JSON file: ${connectionPath}`);
		}

		return { success: affectedCount > 0, affectedCount };
	}

	async getRecordIdentifier(
		_connectionPath: string,
		_tableName: string,
		rowData: Record<string, any>
	): Promise<Record<string, any>> {
		// JSON has no primary key — use all column values as the identifier.
		const identifier: Record<string, any> = {};
		for (const key of Object.keys(rowData)) {
			identifier[key] = rowData[key];
		}
		return identifier;
	}

	async importFromJSON(connectionPath: string, tableName: string, filePath: string): Promise<number> {
		const content = await fs.promises.readFile(filePath, 'utf8');
		const incoming = BaseDatabaseProvider.parseJSONImport(content, tableName);

		const ds = await this.readDatasets(connectionPath);
		let total = 0;
		for (const dataset of incoming) {
			this.appendRows(ds, dataset.tableName, dataset.rows);
			total += dataset.rows.length;
		}

		await this.writeDatasets(connectionPath, ds);
		return total;
	}

	async importFromCSV(connectionPath: string, tableName: string, filePath: string): Promise<number> {
		const content = await fs.promises.readFile(filePath, 'utf8');
		const data = BaseDatabaseProvider.parseCSV(content);

		if (data.length === 0) {
			throw new Error('CSV file is empty or has no data rows');
		}

		const ds = await this.readDatasets(connectionPath);
		const target = tableName || this.getTableNameFromPath(connectionPath);
		this.appendRows(ds, target, data);

		await this.writeDatasets(connectionPath, ds);
		return data.length;
	}

	/**
	 * Append rows into a (possibly new) table, promoting the file to the
	 * multi-table object shape once it holds more than one table.
	 */
	private appendRows(ds: JSONDatasets, tableName: string, rows: any[]): void {
		if (!Object.prototype.hasOwnProperty.call(ds.tables, tableName)) {
			ds.tables[tableName] = [];
			ds.order.push(tableName);
		}
		ds.tables[tableName].push(...rows);
		if (ds.order.length > 1) {
			ds.shape = 'object';
		}
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

	/**
	 * Order-by comparator. Numbers compare numerically, everything else by
	 * string value; null/undefined sort last.
	 */
	private static compareValues(a: any, b: any): number {
		const aEmpty = a === null || a === undefined;
		const bEmpty = b === null || b === undefined;
		if (aEmpty && bEmpty) { return 0; }
		if (aEmpty) { return 1; }
		if (bEmpty) { return -1; }

		if (typeof a === 'number' && typeof b === 'number') {
			return a < b ? -1 : a > b ? 1 : 0;
		}

		const as = typeof a === 'object' ? JSON.stringify(a) : String(a);
		const bs = typeof b === 'object' ? JSON.stringify(b) : String(b);
		return as.localeCompare(bs);
	}

	/**
	 * Loose equality used to match a row against an edit filter. Values
	 * round-trip through the webview as JSON, so compare by serialized form
	 * for objects and by string value for primitives.
	 */
	private static looseEquals(a: any, b: any): boolean {
		if (a === b) { return true; }
		const aEmpty = a === null || a === undefined;
		const bEmpty = b === null || b === undefined;
		if (aEmpty || bEmpty) { return aEmpty && bEmpty; }
		if (typeof a === 'object' || typeof b === 'object') {
			return JSON.stringify(a) === JSON.stringify(b);
		}
		return String(a) === String(b);
	}
}
