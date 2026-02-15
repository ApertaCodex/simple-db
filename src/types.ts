/**
 * Shared types and interfaces for the Simple DB extension.
 * 
 * To add a new database provider:
 * 1. Add the new type to DatabaseType union below
 * 2. Create a new class extending BaseDatabaseProvider
 * 3. Implement all abstract methods
 * 4. Register it in extension.ts provider registry
 * 5. Add a command + contribution point in package.json
 * No changes needed in DatabaseExplorer itself.
 */

// ------------------------------------------------------------------
// Database type union — extend this when adding new providers
// ------------------------------------------------------------------
export type DatabaseType = 'sqlite' | 'mongodb' | 'postgresql' | 'mysql' | 'redis' | 'libsql';

// ------------------------------------------------------------------
// Shared data structures
// ------------------------------------------------------------------

export interface SortConfig {
	col: string;
	dir: 'asc' | 'desc';
}

export interface UpdateResult {
	success: boolean;
	affectedCount: number;
}

export interface ColumnInfo {
	name: string;
	type: string;
	notnull: boolean;
	pk: boolean;
}

export interface DatabaseItem {
	name: string;
	type: DatabaseType;
	path: string; // file path for SQLite, connection string for MongoDB, etc.
	tables: string[];
	tableCounts?: { [tableName: string]: number };
	countsLoaded?: boolean;
}

export interface TableSettings {
	visibleColumns: string[];
	columnFilters: { [column: string]: { op: string; value: string; value2?: string } };
	sortConfig: { column: string; direction: 'asc' | 'desc' }[];
}

// ------------------------------------------------------------------
// Provider interface — every database provider must implement this
// ------------------------------------------------------------------

export interface IDatabaseProvider {
	/**
	 * Returns the database type identifier for this provider.
	 */
	getType(): DatabaseType;

	/**
	 * List all table/collection names for the given connection.
	 */
	getTableNames(connectionPath: string): Promise<string[]>;

	/**
	 * Fetch paginated rows/documents from a table/collection.
	 */
	getTableData(
		connectionPath: string,
		tableName: string,
		limit?: number,
		offset?: number,
		sortConfig?: SortConfig[]
	): Promise<any[]>;

	/**
	 * Get the total row/document count for a table/collection.
	 */
	getRowCount(connectionPath: string, tableName: string): Promise<number>;

	/**
	 * Execute a raw query string. The provider interprets the query
	 * in whatever syntax is native to its engine (SQL, JSON filter, etc.).
	 *
	 * @param context Optional context for providers that need it
	 *               (e.g., MongoDB needs a collection name).
	 */
	executeQuery(
		connectionPath: string,
		query: string,
		context?: { tableName?: string; limit?: number }
	): Promise<any[]>;

	/**
	 * Update a single record/document.
	 */
	updateRecord(
		connectionPath: string,
		tableName: string,
		filter: Record<string, any>,
		updates: Record<string, any>
	): Promise<UpdateResult>;

	/**
	 * Build the filter/where-clause object that uniquely identifies a row.
	 * e.g., SQLite uses primary keys, MongoDB uses _id.
	 *
	 * @param rowData The full row data from which to extract the identifier.
	 */
	getRecordIdentifier(
		connectionPath: string,
		tableName: string,
		rowData: Record<string, any>
	): Promise<Record<string, any>>;

	/**
	 * Export a table/collection to a JSON file.
	 * If `data` is provided, export that data instead of fetching from the DB.
	 */
	exportToJSON(
		connectionPath: string,
		tableName: string,
		outputPath: string,
		data?: any[]
	): Promise<string>;

	/**
	 * Export a table/collection to a CSV file.
	 * If `data` is provided, export that data instead of fetching from the DB.
	 */
	exportToCSV(
		connectionPath: string,
		tableName: string,
		outputPath: string,
		data?: any[]
	): Promise<string>;

	/**
	 * Import data from a JSON file into a table/collection.
	 */
	importFromJSON(
		connectionPath: string,
		tableName: string,
		filePath: string
	): Promise<number>;

	/**
	 * Import data from a CSV file into a table/collection.
	 */
	importFromCSV(
		connectionPath: string,
		tableName: string,
		filePath: string
	): Promise<number>;
}
