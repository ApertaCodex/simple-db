declare module 'duckdb' {
	interface QueryResult {}

	class Connection {
		all(sql: string, ...params: any[]): void;
		run(sql: string, ...params: any[]): void;
	}

	class Database {
		constructor(path: string, config?: Record<string, string>, callback?: (err: Error | null) => void);
		constructor(path: string, callback?: (err: Error | null) => void);
		connect(): Connection;
		close(callback?: (err: Error | null) => void): void;
	}
}
