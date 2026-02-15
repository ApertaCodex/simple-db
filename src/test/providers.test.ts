/**
 * Provider integration tests for Simple DB.
 *
 * Run:  npm test
 *
 * - SQLite and LibSQL are fully integration-tested (file-based, no external server).
 * - MongoDB, PostgreSQL, MySQL, Redis are tested for interface conformance
 *   and will run full integration when the corresponding server is reachable
 *   (controlled via env vars: MONGODB_URI, POSTGRESQL_URI, MYSQL_URI, REDIS_URI).
 */

import * as assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import type { IDatabaseProvider, DatabaseType } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function tmpFile(name: string): string {
	return path.join(tmpDir, name);
}

function writeFixture(name: string, content: string): string {
	const p = tmpFile(name);
	fs.writeFileSync(p, content, 'utf8');
	return p;
}

// ---------------------------------------------------------------------------
// vscode mock is preloaded via --require ./out/test/vscode-mock.js
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Import providers
// ---------------------------------------------------------------------------

import { SQLiteManager } from '../SQLiteManager';
import { MongoDBManager } from '../MongoDBManager';
import { PostgreSQLManager } from '../PostgreSQLManager';
import { MySQLManager } from '../MySQLManager';
import { RedisManager } from '../RedisManager';
import { LibSQLManager } from '../LibSQLManager';

// ---------------------------------------------------------------------------
// Shared interface-conformance checks
// ---------------------------------------------------------------------------

function interfaceConformance(name: string, provider: IDatabaseProvider, expectedType: DatabaseType) {
	describe(`${name} – interface conformance`, () => {
		it('implements getType() correctly', () => {
			assert.equal(provider.getType(), expectedType);
		});

		const requiredMethods: (keyof IDatabaseProvider)[] = [
			'getType',
			'getTableNames',
			'getTableData',
			'getRowCount',
			'executeQuery',
			'updateRecord',
			'getRecordIdentifier',
			'exportToJSON',
			'exportToCSV',
			'importFromJSON',
			'importFromCSV',
		];

		for (const method of requiredMethods) {
			it(`has method ${method}`, () => {
				assert.equal(typeof (provider as any)[method], 'function');
			});
		}
	});
}

// ---------------------------------------------------------------------------
// SQLite – full integration tests (file-based, always available)
// ---------------------------------------------------------------------------

describe('SQLiteManager', () => {
	const provider = new SQLiteManager();
	let dbPath: string;

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simpledb-test-'));
		dbPath = tmpFile('test.db');
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	interfaceConformance('SQLiteManager', provider, 'sqlite');

	it('importFromJSON creates table and inserts rows', async () => {
		const fixture = writeFixture('import.json', JSON.stringify([
			{ id: '1', name: 'Alice', age: '30' },
			{ id: '2', name: 'Bob', age: '25' },
			{ id: '3', name: 'Charlie', age: '35' },
		]));

		const count = await provider.importFromJSON(dbPath, 'users', fixture);
		assert.equal(count, 3);
	});

	it('getTableNames lists the created table', async () => {
		const tables = await provider.getTableNames(dbPath);
		assert.ok(tables.includes('users'));
	});

	it('getRowCount returns correct count', async () => {
		const count = await provider.getRowCount(dbPath, 'users');
		assert.equal(count, 3);
	});

	it('getTableData returns all rows with no limit', async () => {
		const data = await provider.getTableData(dbPath, 'users');
		assert.equal(data.length, 3);
		assert.ok(data.some((r: any) => r.name === 'Alice'));
	});

	it('getTableData respects limit and offset', async () => {
		const page = await provider.getTableData(dbPath, 'users', 2, 1);
		assert.equal(page.length, 2);
	});

	it('getTableData respects sortConfig', async () => {
		const sorted = await provider.getTableData(dbPath, 'users', 10, 0, [
			{ col: 'name', dir: 'desc' },
		]);
		assert.equal(sorted[0].name, 'Charlie');
	});

	it('executeQuery works with SQL', async () => {
		const result = await provider.executeQuery(dbPath, "SELECT name FROM users WHERE id = '1'");
		assert.equal(result.length, 1);
		assert.equal(result[0].name, 'Alice');
	});

	it('getRecordIdentifier falls back to all columns when no PK', async () => {
		const row = { id: '1', name: 'Alice', age: '30' };
		const identifier = await provider.getRecordIdentifier(dbPath, 'users', row);
		// users table was created with all TEXT columns and no explicit PK
		assert.ok(Object.keys(identifier).length > 0);
	});

	it('updateRecord modifies a row', async () => {
		const result = await provider.updateRecord(dbPath, 'users', { id: '1' }, { name: 'Alice Updated' });
		assert.equal(result.success, true);
		assert.equal(result.affectedCount, 1);

		const rows = await provider.executeQuery(dbPath, "SELECT name FROM users WHERE id = '1'");
		assert.equal(rows[0].name, 'Alice Updated');
	});

	it('exportToJSON writes a valid JSON file', async () => {
		const outPath = tmpFile('export.json');
		const returned = await provider.exportToJSON(dbPath, 'users', outPath);
		assert.equal(returned, outPath);

		const content = JSON.parse(fs.readFileSync(outPath, 'utf8'));
		assert.ok(Array.isArray(content));
		assert.equal(content.length, 3);
	});

	it('exportToCSV writes a valid CSV file', async () => {
		const outPath = tmpFile('export.csv');
		const returned = await provider.exportToCSV(dbPath, 'users', outPath);
		assert.equal(returned, outPath);

		const lines = fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean);
		assert.ok(lines.length >= 4); // header + 3 rows
	});

	it('importFromCSV creates table and inserts rows', async () => {
		const csv = 'col_a,col_b\nfoo,bar\nbaz,qux\n';
		const fixture = writeFixture('import.csv', csv);
		const count = await provider.importFromCSV(dbPath, 'csv_test', fixture);
		assert.equal(count, 2);

		const rows = await provider.getTableData(dbPath, 'csv_test');
		assert.equal(rows.length, 2);
		assert.equal(rows[0].col_a, 'foo');
	});
});

// ---------------------------------------------------------------------------
// LibSQL – full integration tests (file-based, always available)
// ---------------------------------------------------------------------------

describe('LibSQLManager', () => {
	const provider = new LibSQLManager();
	let connString: string;

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simpledb-test-libsql-'));
		connString = `file:${tmpFile('libsql-test.db')}`;
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	interfaceConformance('LibSQLManager', provider, 'libsql');

	it('importFromJSON creates table and inserts rows', async () => {
		const fixture = writeFixture('import-libsql.json', JSON.stringify([
			{ id: '1', city: 'Paris' },
			{ id: '2', city: 'Tokyo' },
		]));

		const count = await provider.importFromJSON(connString, 'cities', fixture);
		assert.equal(count, 2);
	});

	it('getTableNames lists the created table', async () => {
		const tables = await provider.getTableNames(connString);
		assert.ok(tables.includes('cities'));
	});

	it('getRowCount returns correct count', async () => {
		const count = await provider.getRowCount(connString, 'cities');
		assert.equal(count, 2);
	});

	it('getTableData returns rows', async () => {
		const data = await provider.getTableData(connString, 'cities');
		assert.equal(data.length, 2);
		assert.ok(data.some((r: any) => r.city === 'Paris'));
	});

	it('getTableData respects limit and offset', async () => {
		const page = await provider.getTableData(connString, 'cities', 1, 1);
		assert.equal(page.length, 1);
	});

	it('getTableData respects sortConfig', async () => {
		const sorted = await provider.getTableData(connString, 'cities', 10, 0, [
			{ col: 'city', dir: 'desc' },
		]);
		assert.equal(sorted[0].city, 'Tokyo');
	});

	it('executeQuery works with SQL', async () => {
		const result = await provider.executeQuery(connString, "SELECT city FROM cities WHERE id = '2'");
		assert.equal(result.length, 1);
		assert.equal(result[0].city, 'Tokyo');
	});

	it('updateRecord modifies a row', async () => {
		const result = await provider.updateRecord(connString, 'cities', { id: '1' }, { city: 'Lyon' });
		assert.equal(result.success, true);
		assert.equal(result.affectedCount, 1);

		const rows = await provider.executeQuery(connString, "SELECT city FROM cities WHERE id = '1'");
		assert.equal(rows[0].city, 'Lyon');
	});

	it('getRecordIdentifier returns all columns when no PK', async () => {
		const row = { id: '1', city: 'Lyon' };
		const identifier = await provider.getRecordIdentifier(connString, 'cities', row);
		assert.ok(Object.keys(identifier).length > 0);
	});

	it('exportToJSON writes a valid JSON file', async () => {
		const outPath = tmpFile('export-libsql.json');
		const returned = await provider.exportToJSON(connString, 'cities', outPath);
		assert.equal(returned, outPath);

		const content = JSON.parse(fs.readFileSync(outPath, 'utf8'));
		assert.ok(Array.isArray(content));
		assert.equal(content.length, 2);
	});

	it('exportToCSV writes a valid CSV file', async () => {
		const outPath = tmpFile('export-libsql.csv');
		const returned = await provider.exportToCSV(connString, 'cities', outPath);
		assert.equal(returned, outPath);

		const lines = fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean);
		assert.ok(lines.length >= 3); // header + 2 rows
	});

	it('importFromCSV creates table and inserts rows', async () => {
		const csv = 'x,y\n10,20\n30,40\n';
		const fixture = writeFixture('import-libsql.csv', csv);
		const count = await provider.importFromCSV(connString, 'coords', fixture);
		assert.equal(count, 2);

		const rows = await provider.getTableData(connString, 'coords');
		assert.equal(rows.length, 2);
	});
});

// ---------------------------------------------------------------------------
// MongoDB – interface conformance + integration when MONGODB_URI is set
// ---------------------------------------------------------------------------

describe('MongoDBManager', () => {
	const provider = new MongoDBManager();

	interfaceConformance('MongoDBManager', provider, 'mongodb');

	it('importFromJSON throws (not supported)', async () => {
		await assert.rejects(
			() => provider.importFromJSON('fake', 'table', 'file.json'),
			/not supported/i
		);
	});

	it('importFromCSV throws (not supported)', async () => {
		await assert.rejects(
			() => provider.importFromCSV('fake', 'table', 'file.csv'),
			/not supported/i
		);
	});

	it('getRecordIdentifier throws without _id', async () => {
		await assert.rejects(
			() => provider.getRecordIdentifier('fake', 'col', { name: 'test' }),
			/_id/
		);
	});

	it('getRecordIdentifier returns _id when present', async () => {
		const id = await provider.getRecordIdentifier('fake', 'col', { _id: 'abc123', name: 'test' });
		assert.deepEqual(id, { _id: 'abc123' });
	});

	const mongoUri = process.env.MONGODB_URI;
	if (mongoUri) {
		it('getTableNames connects and returns collections', async () => {
			const tables = await provider.getTableNames(mongoUri);
			assert.ok(Array.isArray(tables));
		});
	}
});

// ---------------------------------------------------------------------------
// PostgreSQL – interface conformance + integration when POSTGRESQL_URI is set
// ---------------------------------------------------------------------------

describe('PostgreSQLManager', () => {
	const provider = new PostgreSQLManager();

	interfaceConformance('PostgreSQLManager', provider, 'postgresql');

	const pgUri = process.env.POSTGRESQL_URI;
	if (pgUri) {
		const testTable = `simpledb_test_${Date.now()}`;
		after(async () => {
			// Cleanup test table
			await provider.executeQuery(pgUri, `DROP TABLE IF EXISTS "${testTable}"`).catch(() => {});
		});

		it('importFromJSON and getTableNames work', async () => {
			const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'simpledb-pg-'));
			const fixture = path.join(tmpd, 'pg.json');
			fs.writeFileSync(fixture, JSON.stringify([{ a: '1', b: '2' }]));
			const count = await provider.importFromJSON(pgUri, testTable, fixture);
			assert.equal(count, 1);

			const tables = await provider.getTableNames(pgUri);
			assert.ok(tables.includes(testTable));
			fs.rmSync(tmpd, { recursive: true, force: true });
		});

		it('getRowCount and getTableData work', async () => {
			const count = await provider.getRowCount(pgUri, testTable);
			assert.ok(count >= 1);
			const data = await provider.getTableData(pgUri, testTable, 10, 0);
			assert.ok(data.length >= 1);
		});

		it('executeQuery returns results', async () => {
			const rows = await provider.executeQuery(pgUri, `SELECT * FROM "${testTable}"`);
			assert.ok(rows.length >= 1);
		});
	}
});

// ---------------------------------------------------------------------------
// MySQL – interface conformance + integration when MYSQL_URI is set
// ---------------------------------------------------------------------------

describe('MySQLManager', () => {
	const provider = new MySQLManager();

	interfaceConformance('MySQLManager', provider, 'mysql');

	const mysqlUri = process.env.MYSQL_URI;
	if (mysqlUri) {
		const testTable = `simpledb_test_${Date.now()}`;
		after(async () => {
			await provider.executeQuery(mysqlUri, `DROP TABLE IF EXISTS \`${testTable}\``).catch(() => {});
		});

		it('importFromJSON and getTableNames work', async () => {
			const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'simpledb-mysql-'));
			const fixture = path.join(tmpd, 'mysql.json');
			fs.writeFileSync(fixture, JSON.stringify([{ a: '1', b: '2' }]));
			const count = await provider.importFromJSON(mysqlUri, testTable, fixture);
			assert.equal(count, 1);

			const tables = await provider.getTableNames(mysqlUri);
			assert.ok(tables.includes(testTable));
			fs.rmSync(tmpd, { recursive: true, force: true });
		});

		it('getRowCount and getTableData work', async () => {
			const count = await provider.getRowCount(mysqlUri, testTable);
			assert.ok(count >= 1);
			const data = await provider.getTableData(mysqlUri, testTable, 10, 0);
			assert.ok(data.length >= 1);
		});
	}
});

// ---------------------------------------------------------------------------
// Redis – interface conformance + integration when REDIS_URI is set
// ---------------------------------------------------------------------------

describe('RedisManager', () => {
	const provider = new RedisManager();

	interfaceConformance('RedisManager', provider, 'redis');

	it('importFromJSON throws (not supported)', async () => {
		await assert.rejects(
			() => (provider as any).importFromJSON('fake', 'table', 'file.json'),
			/not supported/i
		);
	});

	it('importFromCSV throws (not supported)', async () => {
		await assert.rejects(
			() => (provider as any).importFromCSV('fake', 'table', 'file.csv'),
			/not supported/i
		);
	});

	it('getRecordIdentifier throws without key field', async () => {
		await assert.rejects(
			() => provider.getRecordIdentifier('fake', 'prefix', { value: 'test' }),
			/key/
		);
	});

	it('getRecordIdentifier returns key when present', async () => {
		const id = await provider.getRecordIdentifier('fake', 'prefix', { key: 'mykey', value: 'v' });
		assert.deepEqual(id, { key: 'mykey' });
	});

	const redisUri = process.env.REDIS_URI;
	if (redisUri) {
		const testKey = `simpledb:test:${Date.now()}`;
		after(async () => {
			await provider.executeQuery(redisUri, `DEL ${testKey}`).catch(() => {});
		});

		it('executeQuery SET and GET work', async () => {
			await provider.executeQuery(redisUri, `SET ${testKey} hello`);
			const result = await provider.executeQuery(redisUri, `GET ${testKey}`);
			assert.equal(result[0].result, 'hello');
		});

		it('getTableNames returns prefixes', async () => {
			const tables = await provider.getTableNames(redisUri);
			assert.ok(Array.isArray(tables));
			assert.ok(tables.includes('simpledb'));
		});

		it('getTableData returns key info', async () => {
			const data = await provider.getTableData(redisUri, 'simpledb', 100, 0);
			assert.ok(data.some((r: any) => r.key === testKey));
		});

		it('updateRecord changes a string key', async () => {
			const result = await provider.updateRecord(redisUri, 'simpledb', { key: testKey }, { value: 'world' });
			assert.equal(result.success, true);
			const check = await provider.executeQuery(redisUri, `GET ${testKey}`);
			assert.equal(check[0].result, 'world');
		});
	}
});
