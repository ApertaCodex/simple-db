import * as fs from 'fs';
import { logger } from './logger';
import type { IDatabaseProvider, DatabaseType, SortConfig, UpdateResult } from './types';

/**
 * Abstract base class for all database providers.
 *
 * Provides shared CSV / JSON utility methods so concrete providers
 * only need to implement the database-specific logic.
 *
 * To create a new provider, extend this class and implement every
 * abstract method. Then register the instance in the provider registry
 * inside extension.ts.
 */
export abstract class BaseDatabaseProvider implements IDatabaseProvider {

	// ------------------------------------------------------------------
	// Abstract — must be implemented by every concrete provider
	// ------------------------------------------------------------------

	abstract getType(): DatabaseType;

	abstract getTableNames(connectionPath: string): Promise<string[]>;

	abstract getTableData(
		connectionPath: string,
		tableName: string,
		limit?: number,
		offset?: number,
		sortConfig?: SortConfig[]
	): Promise<any[]>;

	abstract getRowCount(connectionPath: string, tableName: string): Promise<number>;

	abstract executeQuery(
		connectionPath: string,
		query: string,
		context?: { tableName?: string; limit?: number }
	): Promise<any[]>;

	abstract updateRecord(
		connectionPath: string,
		tableName: string,
		filter: Record<string, any>,
		updates: Record<string, any>
	): Promise<UpdateResult>;

	abstract getRecordIdentifier(
		connectionPath: string,
		tableName: string,
		rowData: Record<string, any>
	): Promise<Record<string, any>>;

	// ------------------------------------------------------------------
	// Default export / import implementations (override if needed)
	// ------------------------------------------------------------------

	async exportToJSON(
		connectionPath: string,
		tableName: string,
		outputPath: string,
		data?: any[]
	): Promise<string> {
		const exportData = data ?? await this.getTableData(connectionPath, tableName);
		await BaseDatabaseProvider.writeJSONFile(outputPath, exportData);
		logger.info(`Exported ${exportData.length} rows from ${tableName} to ${outputPath}`);
		return outputPath;
	}

	async exportToCSV(
		connectionPath: string,
		tableName: string,
		outputPath: string,
		data?: any[]
	): Promise<string> {
		const exportData = data ?? await this.getTableData(connectionPath, tableName);
		if (exportData.length === 0) {
			throw new Error('No data to export');
		}

		const headers = Object.keys(exportData[0]);
		await BaseDatabaseProvider.writeCSVFile(outputPath, headers, exportData);
		logger.info(`Exported ${exportData.length} rows from ${tableName} to ${outputPath}`);
		return outputPath;
	}

	async importFromJSON(
		_connectionPath: string,
		_tableName: string,
		_filePath: string
	): Promise<number> {
		throw new Error(`Import from JSON is not supported for ${this.getType()} databases`);
	}

	async importFromCSV(
		_connectionPath: string,
		_tableName: string,
		_filePath: string
	): Promise<number> {
		throw new Error(`Import from CSV is not supported for ${this.getType()} databases`);
	}

	// ------------------------------------------------------------------
	// Static shared utilities — usable by any provider or caller
	// ------------------------------------------------------------------

	/**
	 * Escape a single cell value for CSV output.
	 * Wraps in quotes and escapes inner quotes when the value contains
	 * commas, quotes, or newlines.
	 */
	static escapeCSVCell(value: any): string {
		if (value === null || value === undefined) {
			return '';
		}
		const stringValue = String(value);
		if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
			return `"${stringValue.replace(/"/g, '""')}"`;
		}
		return stringValue;
	}

	/**
	 * Serialize an array of objects to a JSON string (pretty-printed).
	 */
	static dataToJSON(data: any[]): string {
		return JSON.stringify(data, null, 2);
	}

	/**
	 * Serialize an array of objects to a CSV string.
	 */
	static dataToCSV(data: any[]): string {
		if (data.length === 0) {
			return '';
		}
		const headers = Object.keys(data[0]);
		const csvRows = [headers.join(',')];
		for (const row of data) {
			const values = headers.map(header => BaseDatabaseProvider.escapeCSVCell(row[header]));
			csvRows.push(values.join(','));
		}
		return csvRows.join('\n');
	}

	/**
	 * Write a JSON file from an array of objects.
	 */
	static async writeJSONFile(outputPath: string, data: any[]): Promise<void> {
		const jsonData = JSON.stringify(data, null, 2);
		await fs.promises.writeFile(outputPath, jsonData, 'utf8');
	}

	/**
	 * Write a CSV file from headers and row objects.
	 */
	static async writeCSVFile(outputPath: string, headers: string[], data: any[]): Promise<void> {
		const csvRows = [headers.join(',')];
		for (const row of data) {
			const values = headers.map(header => BaseDatabaseProvider.escapeCSVCell(row[header]));
			csvRows.push(values.join(','));
		}
		const csvData = csvRows.join('\n');
		await fs.promises.writeFile(outputPath, csvData, 'utf8');
	}

	/**
	 * Parse a CSV string into an array of objects.
	 * The first row is treated as the header.
	 */
	static parseCSV(content: string): any[] {
		const lines = content.split(/\r?\n/).filter(line => line.trim());
		if (lines.length < 2) {
			return [];
		}

		const headers = BaseDatabaseProvider.parseCSVLine(lines[0]);
		const data: any[] = [];
		for (let i = 1; i < lines.length; i++) {
			const values = BaseDatabaseProvider.parseCSVLine(lines[i]);
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

	/**
	 * Parse a single CSV line, respecting quoted fields.
	 */
	static parseCSVLine(line: string): string[] {
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
}
