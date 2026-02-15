import { logger } from './logger';
import { BaseDatabaseProvider } from './BaseDatabaseProvider';
import type { DatabaseType, SortConfig, UpdateResult } from './types';

// Lazy-loaded ioredis module
let ioredisModule: typeof import('ioredis') | null = null;
let ioredisLoadError: Error | null = null;

async function getIoredis() {
	if (ioredisLoadError) {
		throw ioredisLoadError;
	}
	if (!ioredisModule) {
		ioredisModule = await import('ioredis');
		logger.info('ioredis module loaded successfully');
	}
	return ioredisModule;
}

/**
 * Redis provider for Simple DB.
 *
 * In Redis the concept of "tables" maps to key prefixes or patterns.
 * - getTableNames scans for unique prefixes (everything before the first ':')
 *   and also lists keys that have no prefix.
 * - getTableData returns key-value pairs matching a prefix pattern.
 * - executeQuery sends a raw Redis command string.
 *
 * Connection string format: redis://[:password@]host:port[/db]
 */
export class RedisManager extends BaseDatabaseProvider {

	getType(): DatabaseType {
		return 'redis';
	}

	private async withRedis<T>(connectionString: string, fn: (redis: import('ioredis').default) => Promise<T>): Promise<T> {
		const Redis = await getIoredis();
		const redis = new Redis.default(connectionString);
		try {
			return await fn(redis);
		} finally {
			redis.disconnect();
		}
	}

	/**
	 * Returns unique key prefixes (text before the first ':') as "tables".
	 * Keys without a ':' are grouped under a synthetic "__no_prefix__" table.
	 */
	async getTableNames(connectionString: string): Promise<string[]> {
		logger.debug(`Scanning Redis key prefixes: ${connectionString}`);
		return this.withRedis(connectionString, async (redis) => {
			const prefixes = new Set<string>();
			let cursor = '0';

			do {
				const [nextCursor, keys] = await redis.scan(cursor, 'COUNT', 500);
				cursor = nextCursor;
				for (const key of keys) {
					const colonIdx = key.indexOf(':');
					prefixes.add(colonIdx > 0 ? key.substring(0, colonIdx) : '__no_prefix__');
				}
			} while (cursor !== '0');

			const sorted = Array.from(prefixes).sort();
			logger.debug(`Found ${sorted.length} key prefixes in Redis`);
			return sorted;
		});
	}

	/**
	 * Returns key-value pairs for a given prefix pattern.
	 * Each row is { key, type, value, ttl }.
	 */
	async getTableData(
		connectionString: string,
		tableName: string,
		limit?: number,
		offset?: number,
		_sortConfig?: SortConfig[]
	): Promise<any[]> {
		return this.withRedis(connectionString, async (redis) => {
			const pattern = tableName === '__no_prefix__' ? '*' : `${tableName}:*`;
			const allKeys: string[] = [];
			let cursor = '0';

			do {
				const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
				cursor = nextCursor;

				if (tableName === '__no_prefix__') {
					// Only keep keys without a colon prefix
					for (const key of keys) {
						if (!key.includes(':')) {
							allKeys.push(key);
						}
					}
				} else {
					allKeys.push(...keys);
				}
			} while (cursor !== '0');

			allKeys.sort();

			const normalizedOffset = typeof offset === 'number' && Number.isFinite(offset)
				? Math.max(0, Math.floor(offset))
				: 0;
			const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit)
				? Math.max(0, Math.floor(limit))
				: allKeys.length;

			const pageKeys = allKeys.slice(normalizedOffset, normalizedOffset + normalizedLimit);

			const rows: any[] = [];
			for (const key of pageKeys) {
				const keyType = await redis.type(key);
				let value: any;

				switch (keyType) {
					case 'string':
						value = await redis.get(key);
						break;
					case 'list':
						value = JSON.stringify(await redis.lrange(key, 0, -1));
						break;
					case 'set':
						value = JSON.stringify(await redis.smembers(key));
						break;
					case 'zset':
						value = JSON.stringify(await redis.zrange(key, 0, -1, 'WITHSCORES'));
						break;
					case 'hash':
						value = JSON.stringify(await redis.hgetall(key));
						break;
					case 'stream':
						value = '[stream]';
						break;
					default:
						value = `[${keyType}]`;
				}

				const ttl = await redis.ttl(key);
				rows.push({ key, type: keyType, value, ttl: ttl === -1 ? 'none' : ttl });
			}

			return rows;
		});
	}

	async getRowCount(connectionString: string, tableName: string): Promise<number> {
		return this.withRedis(connectionString, async (redis) => {
			const pattern = tableName === '__no_prefix__' ? '*' : `${tableName}:*`;
			let count = 0;
			let cursor = '0';

			do {
				const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
				cursor = nextCursor;

				if (tableName === '__no_prefix__') {
					count += keys.filter(k => !k.includes(':')).length;
				} else {
					count += keys.length;
				}
			} while (cursor !== '0');

			return count;
		});
	}

	/**
	 * Execute a raw Redis command.
	 * e.g., "GET mykey", "HGETALL myhash", "KEYS user:*"
	 */
	async executeQuery(
		connectionString: string,
		query: string,
		_context?: { tableName?: string; limit?: number }
	): Promise<any[]> {
		return this.withRedis(connectionString, async (redis) => {
			const parts = this.parseRedisCommand(query.trim());
			if (parts.length === 0) {
				throw new Error('Empty command');
			}

			const command = parts[0].toLowerCase();
			const args = parts.slice(1);

			const result = await (redis as any).call(command, ...args);

			// Normalize result into array-of-objects for the data grid
			if (result === null || result === undefined) {
				return [{ result: '(nil)' }];
			}

			if (Array.isArray(result)) {
				if (result.length === 0) {
					return [{ result: '(empty array)' }];
				}
				return result.map((item, i) => ({ index: i, value: String(item) }));
			}

			return [{ result: String(result) }];
		});
	}

	/**
	 * Update a Redis key value. filter must contain { key }.
	 * updates must contain { value } (for string keys) or the specific field.
	 */
	async updateRecord(
		connectionString: string,
		_tableName: string,
		filter: Record<string, any>,
		updates: Record<string, any>
	): Promise<UpdateResult> {
		const redisKey = filter.key;
		if (!redisKey) {
			throw new Error('Redis update requires a "key" in filter');
		}

		return this.withRedis(connectionString, async (redis) => {
			const keyType = await redis.type(redisKey);

			if (keyType === 'string') {
				const newValue = updates.value;
				if (newValue === undefined) {
					throw new Error('String key update requires a "value" field');
				}
				await redis.set(redisKey, String(newValue));
				return { success: true, affectedCount: 1 };
			}

			if (keyType === 'hash' && updates.value) {
				// If the stored value is JSON hash data, try to SET it
				const parsed = JSON.parse(updates.value);
				if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
					await redis.del(redisKey);
					const entries = Object.entries(parsed).flat().map(String);
					if (entries.length > 0) {
						await (redis as any).hset(redisKey, ...entries);
					}
					return { success: true, affectedCount: 1 };
				}
			}

			throw new Error(`Updating ${keyType} keys is not supported through the grid editor. Use the query panel instead.`);
		});
	}

	async getRecordIdentifier(
		_connectionPath: string,
		_tableName: string,
		rowData: Record<string, any>
	): Promise<Record<string, any>> {
		if (!rowData.key) {
			throw new Error('Redis row data must have a "key" field');
		}
		return { key: rowData.key };
	}

	// Redis doesn't support traditional import — override with meaningful errors
	async importFromJSON(): Promise<number> {
		throw new Error('Import from JSON is not supported for Redis. Use the query panel to SET keys.');
	}

	async importFromCSV(): Promise<number> {
		throw new Error('Import from CSV is not supported for Redis. Use the query panel to SET keys.');
	}

	/**
	 * Parse a Redis command string into parts, respecting quoted strings.
	 */
	private parseRedisCommand(input: string): string[] {
		const parts: string[] = [];
		let current = '';
		let inSingleQuote = false;
		let inDoubleQuote = false;

		for (let i = 0; i < input.length; i++) {
			const ch = input[i];

			if (inSingleQuote) {
				if (ch === "'") {
					inSingleQuote = false;
				} else {
					current += ch;
				}
			} else if (inDoubleQuote) {
				if (ch === '"') {
					inDoubleQuote = false;
				} else if (ch === '\\' && i + 1 < input.length) {
					current += input[++i];
				} else {
					current += ch;
				}
			} else if (ch === "'") {
				inSingleQuote = true;
			} else if (ch === '"') {
				inDoubleQuote = true;
			} else if (ch === ' ' || ch === '\t') {
				if (current.length > 0) {
					parts.push(current);
					current = '';
				}
			} else {
				current += ch;
			}
		}

		if (current.length > 0) {
			parts.push(current);
		}

		return parts;
	}
}
