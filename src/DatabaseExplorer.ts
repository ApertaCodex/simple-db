import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from './logger';
import type { IDatabaseProvider, DatabaseItem, DatabaseType, TableSettings } from './types';

/** Resolve the per-provider SVG icon path (works for both light & dark themes). */
function providerIconPath(extensionPath: string, providerType: string): { light: vscode.Uri; dark: vscode.Uri } {
    const iconFile = path.join(extensionPath, 'icons', `${providerType}.svg`);
    return { light: vscode.Uri.file(iconFile), dark: vscode.Uri.file(iconFile) };
}

let _extensionPath: string = '';

/** Must be called once at activation time so tree items can resolve icon paths. */
export function setExtensionPath(p: string) {
    _extensionPath = p;
}

class DatabaseTreeItem extends vscode.TreeItem {
    public readonly tableName: string;

    constructor(
        public readonly connection: DatabaseItem | null,
        label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        public readonly recordCount?: number
    ) {
        super(label, collapsibleState);
        this.tableName = label;
        
        // Handle empty state items
        if (contextValue === 'emptyState' || contextValue === 'actionButton') {
            this.tooltip = label;
            this.contextValue = contextValue;
            
            if (contextValue === 'emptyState') {
                this.iconPath = new vscode.ThemeIcon('info');
                this.description = '';
            } else if (contextValue === 'actionButton') {
                // Map action button labels to commands + provider icon key
                const actionCommandMap: Record<string, { command: string; title: string; icon: string }> = {
                    'SQLite': { command: 'simpleDB.addSQLite', title: 'Add SQLite Database', icon: 'sqlite' },
                    'MongoDB': { command: 'simpleDB.addMongoDB', title: 'Add MongoDB Connection', icon: 'mongodb' },
                    'PostgreSQL': { command: 'simpleDB.addPostgreSQL', title: 'Add PostgreSQL Connection', icon: 'postgresql' },
                    'MySQL': { command: 'simpleDB.addMySQL', title: 'Add MySQL Connection', icon: 'mysql' },
                    'Redis': { command: 'simpleDB.addRedis', title: 'Add Redis Connection', icon: 'redis' },
                    'LibSQL': { command: 'simpleDB.addLibSQL', title: 'Add LibSQL/Turso Connection', icon: 'libsql' },
                };
                let matched = false;
                for (const [keyword, entry] of Object.entries(actionCommandMap)) {
                    if (label.includes(keyword)) {
                        this.command = { command: entry.command, title: entry.title };
                        this.iconPath = providerIconPath(_extensionPath, entry.icon);
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    this.iconPath = new vscode.ThemeIcon('add');
                }
            }
            return;
        }
        
        // Normal tree items
        if (connection) {
            this.tooltip = `${connection.name} - ${label}`;
        }
        this.contextValue = contextValue;

        if (contextValue === 'connection' && connection) {
            this.iconPath = providerIconPath(_extensionPath, connection.type);
            // Show table count for database connections
            if (connection.tables && connection.tables.length > 0) {
                this.description = `${connection.tables.length} ${connection.tables.length === 1 ? 'table' : 'tables'}`;
            }
        } else if (contextValue === 'table') {
            // Show record count on the right side of the row
            if (recordCount !== undefined) {
                this.description = `${recordCount.toLocaleString()} rows`;
            }
            this.iconPath = connection
                ? providerIconPath(_extensionPath, `table-${connection.type}`)
                : new vscode.ThemeIcon('table');
            // Auto-open table data on click
            this.command = {
                command: 'simpleDB.viewData',
                title: 'View Data',
                arguments: [this]
            };
        }
    }
}

export class DatabaseExplorer {
    connections: DatabaseItem[] = [];
    private _disposables: vscode.Disposable[] = [];
    private _treeDataProvider: DatabaseTreeDataProvider;
    private readonly defaultPageSize = 20;
    private readonly TABLE_SETTINGS_KEY = 'simpleDB.tableSettings';

    constructor(
        private providers: Map<DatabaseType, IDatabaseProvider>,
        private context: vscode.ExtensionContext
    ) {
        this._treeDataProvider = new DatabaseTreeDataProvider(this);
        this.loadConnections();
    }

    /**
     * Get the provider for a given connection, throwing if not registered.
     */
    getProvider(connection: DatabaseItem): IDatabaseProvider {
        const provider = this.providers.get(connection.type);
        if (!provider) {
            throw new Error(`No provider registered for database type: ${connection.type}`);
        }
        return provider;
    }

    /**
     * Get the provider for a given database type, throwing if not registered.
     */
    getProviderByType(type: DatabaseType): IDatabaseProvider {
        const provider = this.providers.get(type);
        if (!provider) {
            throw new Error(`No provider registered for database type: ${type}`);
        }
        return provider;
    }

    // Save table settings to extension cache (globalState)
    saveTableSettings(databaseName: string, tableName: string, settings: TableSettings): void {
        const allSettings = this.context.globalState.get<{ [key: string]: TableSettings }>(this.TABLE_SETTINGS_KEY) || {};
        const key = `${databaseName}:${tableName}`;
        allSettings[key] = settings;
        this.context.globalState.update(this.TABLE_SETTINGS_KEY, allSettings);
    }

    // Load table settings from extension cache (globalState)
    getTableSettings(databaseName: string, tableName: string): TableSettings | undefined {
        const allSettings = this.context.globalState.get<{ [key: string]: TableSettings }>(this.TABLE_SETTINGS_KEY) || {};
        const key = `${databaseName}:${tableName}`;
        return allSettings[key];
    }

    getTreeDataProvider() {
        return this._treeDataProvider;
    }

    async addSQLite() {
        const uri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            filters: { 'SQLite Database': ['db', 'sqlite', 'sqlite3'] }
        });

        if (uri && uri[0]) {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter connection name',
                value: path.basename(uri[0].fsPath, path.extname(uri[0].fsPath))
            });

            if (name) {
                await this.addSQLiteConnection(uri[0].fsPath, name);
            }
        }
    }

    async openSQLiteFile(filePath: string) {
        // Check if this file is already in connections
        const existingConnection = this.connections.find(
            conn => conn.type === 'sqlite' && conn.path === filePath
        );

        if (existingConnection) {
            // File already added, just show a message
            vscode.window.showInformationMessage(`SQLite database "${existingConnection.name}" is already open`);
            this._treeDataProvider.refresh();
            return;
        }

        // Auto-add the file with a default name
        const name = path.basename(filePath, path.extname(filePath));
        await this.addSQLiteConnection(filePath, name);
    }

    private async addSQLiteConnection(filePath: string, name: string) {
        logger.info(`Adding SQLite connection: ${name} (${filePath})`);
        const connection: DatabaseItem = {
            name,
            type: 'sqlite',
            path: filePath,
            tables: [],
            countsLoaded: false
        };

        try {
            const provider = this.getProvider(connection);
            connection.tables = await provider.getTableNames(filePath);
            this.connections.push(connection);
            this.saveConnections();
            this._treeDataProvider.refresh();
            logger.info(`SQLite database "${name}" added successfully with ${connection.tables.length} tables`);
            vscode.window.showInformationMessage(`SQLite database "${name}" added successfully with ${connection.tables.length} tables`);
        } catch (error) {
            logger.error(`Failed to connect to SQLite database "${name}"`, error);
            vscode.window.showErrorMessage(`Failed to connect to SQLite database: ${error}`);
        }
    }

    async addMongoDB() {
        const connectionString = await vscode.window.showInputBox({
            prompt: 'Enter MongoDB connection string',
            value: 'mongodb://localhost:27017'
        });

        if (connectionString) {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter connection name',
                value: 'MongoDB'
            });

            if (name) {
                const connection: DatabaseItem = {
                    name,
                    type: 'mongodb',
                    path: connectionString,
                    tables: [],
                    countsLoaded: false
                };

                try {
                    logger.info(`Adding MongoDB connection: ${name} (${connectionString})`);
                    const provider = this.getProvider(connection);
                    connection.tables = await provider.getTableNames(connectionString);
                    this.connections.push(connection);
                    this.saveConnections();
                    this._treeDataProvider.refresh();
                    logger.info(`MongoDB connection "${name}" added successfully with ${connection.tables.length} collections`);
                    vscode.window.showInformationMessage(`MongoDB connection "${name}" added successfully with ${connection.tables.length} collections`);
                } catch (error) {
                    logger.error(`Failed to connect to MongoDB "${name}"`, error);
                    vscode.window.showErrorMessage(`Failed to connect to MongoDB: ${error}`);
                }
            }
        }
    }

    async addPostgreSQL() {
        const connectionString = await vscode.window.showInputBox({
            prompt: 'Enter PostgreSQL connection string',
            value: 'postgresql://user:password@localhost:5432/mydb',
            placeHolder: 'postgresql://user:password@host:port/database'
        });

        if (connectionString) {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter connection name',
                value: 'PostgreSQL'
            });

            if (name) {
                const connection: DatabaseItem = {
                    name,
                    type: 'postgresql',
                    path: connectionString,
                    tables: [],
                    countsLoaded: false
                };

                try {
                    logger.info(`Adding PostgreSQL connection: ${name}`);
                    const provider = this.getProvider(connection);
                    connection.tables = await provider.getTableNames(connectionString);
                    this.connections.push(connection);
                    this.saveConnections();
                    this._treeDataProvider.refresh();
                    logger.info(`PostgreSQL connection "${name}" added successfully with ${connection.tables.length} tables`);
                    vscode.window.showInformationMessage(`PostgreSQL connection "${name}" added successfully with ${connection.tables.length} tables`);
                } catch (error) {
                    logger.error(`Failed to connect to PostgreSQL "${name}"`, error);
                    vscode.window.showErrorMessage(`Failed to connect to PostgreSQL: ${error}`);
                }
            }
        }
    }

    async addMySQL() {
        const connectionString = await vscode.window.showInputBox({
            prompt: 'Enter MySQL connection string',
            value: 'mysql://user:password@localhost:3306/mydb',
            placeHolder: 'mysql://user:password@host:port/database'
        });

        if (connectionString) {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter connection name',
                value: 'MySQL'
            });

            if (name) {
                const connection: DatabaseItem = {
                    name,
                    type: 'mysql',
                    path: connectionString,
                    tables: [],
                    countsLoaded: false
                };

                try {
                    logger.info(`Adding MySQL connection: ${name}`);
                    const provider = this.getProvider(connection);
                    connection.tables = await provider.getTableNames(connectionString);
                    this.connections.push(connection);
                    this.saveConnections();
                    this._treeDataProvider.refresh();
                    logger.info(`MySQL connection "${name}" added successfully with ${connection.tables.length} tables`);
                    vscode.window.showInformationMessage(`MySQL connection "${name}" added successfully with ${connection.tables.length} tables`);
                } catch (error) {
                    logger.error(`Failed to connect to MySQL "${name}"`, error);
                    vscode.window.showErrorMessage(`Failed to connect to MySQL: ${error}`);
                }
            }
        }
    }

    async addRedis() {
        const connectionString = await vscode.window.showInputBox({
            prompt: 'Enter Redis connection string',
            value: 'redis://localhost:6379',
            placeHolder: 'redis://[:password@]host:port[/db]'
        });

        if (connectionString) {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter connection name',
                value: 'Redis'
            });

            if (name) {
                const connection: DatabaseItem = {
                    name,
                    type: 'redis',
                    path: connectionString,
                    tables: [],
                    countsLoaded: false
                };

                try {
                    logger.info(`Adding Redis connection: ${name}`);
                    const provider = this.getProvider(connection);
                    connection.tables = await provider.getTableNames(connectionString);
                    this.connections.push(connection);
                    this.saveConnections();
                    this._treeDataProvider.refresh();
                    logger.info(`Redis connection "${name}" added successfully with ${connection.tables.length} key prefixes`);
                    vscode.window.showInformationMessage(`Redis connection "${name}" added successfully with ${connection.tables.length} key prefixes`);
                } catch (error) {
                    logger.error(`Failed to connect to Redis "${name}"`, error);
                    vscode.window.showErrorMessage(`Failed to connect to Redis: ${error}`);
                }
            }
        }
    }

    async addLibSQL() {
        const connectionString = await vscode.window.showInputBox({
            prompt: 'Enter LibSQL/Turso connection string',
            value: 'file:local.db',
            placeHolder: 'file:path.db or libsql://db-name.turso.io?authToken=TOKEN'
        });

        if (connectionString) {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter connection name',
                value: 'LibSQL'
            });

            if (name) {
                const connection: DatabaseItem = {
                    name,
                    type: 'libsql',
                    path: connectionString,
                    tables: [],
                    countsLoaded: false
                };

                try {
                    logger.info(`Adding LibSQL/Turso connection: ${name}`);
                    const provider = this.getProvider(connection);
                    connection.tables = await provider.getTableNames(connectionString);
                    this.connections.push(connection);
                    this.saveConnections();
                    this._treeDataProvider.refresh();
                    logger.info(`LibSQL connection "${name}" added successfully with ${connection.tables.length} tables`);
                    vscode.window.showInformationMessage(`LibSQL connection "${name}" added successfully with ${connection.tables.length} tables`);
                } catch (error) {
                    logger.error(`Failed to connect to LibSQL "${name}"`, error);
                    vscode.window.showErrorMessage(`Failed to connect to LibSQL: ${error}`);
                }
            }
        }
    }

    async refreshTables(connection: DatabaseItem) {
        try {
            logger.info(`Refreshing tables for connection: ${connection.name}`);
            // Reset counts so they get fetched again
            connection.countsLoaded = false;
            connection.tableCounts = {};
            
            const provider = this.getProvider(connection);
            const tables = await provider.getTableNames(connection.path);
            connection.tables = tables;
            this.saveConnections();
            this._treeDataProvider.refresh();
            logger.info(`Tables refreshed for "${connection.name}": ${tables.length} tables/collections`);
            vscode.window.showInformationMessage(`Tables refreshed for "${connection.name}"`);
        } catch (error) {
            logger.error(`Failed to refresh tables/collections for "${connection.name}"`, error);
            vscode.window.showErrorMessage(`Failed to refresh tables/collections: ${error}`);
        }
    }

    async removeConnection(item: DatabaseTreeItem) {
        if (!item.connection) {
            return;
        }
        const index = this.connections.findIndex(c => c.name === item.connection!.name);
        if (index !== -1) {
            this.connections.splice(index, 1);
            this.saveConnections();
            this._treeDataProvider.refresh();
            vscode.window.showInformationMessage(`Connection "${item.connection.name}" removed`);
        }
    }

    async viewData(item: DatabaseTreeItem) {
        if (!item.connection) {
            vscode.window.showErrorMessage('No database connection available');
            return;
        }
        
        logger.info(`Viewing data for table: ${item.tableName} in ${item.connection.name}`);
        const connection = item.connection; // Store reference for callbacks
        
        try {
            const pageSize = this.defaultPageSize;
            const provider = this.getProvider(connection);
            const [data, totalRows] = await Promise.all([
                provider.getTableData(connection.path, item.tableName, pageSize, 0),
                provider.getRowCount(connection.path, item.tableName)
            ]);

            const panel = this.showDataGrid(data, item.tableName, totalRows, pageSize, connection.type, connection.name);

            // Send database list and selection to webview
            panel.webview.postMessage({
                command: 'updateDatabases',
                databases: this.connections.map(conn => ({
                    name: conn.name,
                    type: conn.type,
                    tables: conn.tables
                })),
                currentDatabase: connection.name,
                currentTable: item.tableName
            });

            panel.webview.onDidReceiveMessage(
                async message => {
                    if (message.command === 'exportCSV') {
                        try {
                            const uri = await vscode.window.showSaveDialog({
                                defaultUri: vscode.Uri.file(message.filename || 'export.csv'),
                                filters: { 'CSV Files': ['csv'] }
                            });

                            if (uri) {
                                await vscode.workspace.fs.writeFile(uri, Buffer.from(message.data, 'utf8'));
                                vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
                                // Automatically open the file in the IDE
                                const document = await vscode.workspace.openTextDocument(uri.fsPath);
                                await vscode.window.showTextDocument(document);
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(`Export failed: ${error}`);
                        }
                    } else if (message.command === 'exportJSON') {
                        try {
                            const uri = await vscode.window.showSaveDialog({
                                defaultUri: vscode.Uri.file(message.filename || 'export.json'),
                                filters: { 'JSON Files': ['json'] }
                            });

                            if (uri) {
                                await vscode.workspace.fs.writeFile(uri, Buffer.from(message.data, 'utf8'));
                                vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
                                // Automatically open the file in the IDE
                                const document = await vscode.workspace.openTextDocument(uri.fsPath);
                                await vscode.window.showTextDocument(document);
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(`Export failed: ${error}`);
                        }
                    } else if (message.command === 'loadPage') {
                        try {
                            // Use table/database from message, falling back to original values
                            const targetDbName = message.database || connection.name;
                            const targetTable = message.table || item.tableName;
                            const targetConnection = this.connections.find(c => c.name === targetDbName) || connection;
                            const targetProvider = this.getProvider(targetConnection);

                            // Get sortConfig from message
                            const sortConfig = Array.isArray(message.sortConfig) ? message.sortConfig : undefined;

                            // Get total rows for the target table
                            const targetTotalRows = await targetProvider.getRowCount(targetConnection.path, targetTable);

                            const requestedPageSize = this.normalizePageSize(message.pageSize, pageSize);
                            const totalPages = Math.max(1, Math.ceil(targetTotalRows / requestedPageSize));
                            const requestedPage = this.normalizePageNumber(message.page, totalPages);
                            const offset = (requestedPage - 1) * requestedPageSize;

                            const pageData = await targetProvider.getTableData(
                                targetConnection.path,
                                targetTable,
                                requestedPageSize,
                                offset,
                                sortConfig
                            );

                            panel.webview.postMessage({
                                command: 'pageData',
                                data: pageData,
                                page: requestedPage,
                                pageSize: requestedPageSize,
                                totalRows: targetTotalRows
                            });
                        } catch (error) {
                            panel.webview.postMessage({
                                command: 'pageError',
                                error: error instanceof Error ? error.message : String(error)
                            });
                        }
                    } else if (message.command === 'executeQuery') {
                        try {
                            const queryProvider = this.getProvider(connection);
                            const result = await queryProvider.executeQuery(
                                connection.path,
                                message.query,
                                { tableName: item.tableName }
                            );

                            panel.webview.postMessage({
                                command: 'queryResult',
                                data: result,
                                rowCount: Array.isArray(result) ? result.length : 0
                            });
                        } catch (error) {
                            panel.webview.postMessage({
                                command: 'queryError',
                                error: error instanceof Error ? error.message : String(error)
                            });
                        }
                    } else if (message.command === 'generateAIQuery') {
                        try {
                            // Get the current table from the message (webview tracks current table)
                            const currentTable = message.tableName || item.tableName;
                            const currentDb = message.database ? this.connections.find(c => c.name === message.database) : connection;
                            
                            if (!currentDb) {
                                panel.webview.postMessage({
                                    command: 'aiQueryError',
                                    error: 'Database not found'
                                });
                                return;
                            }
                            
                            if (currentDb.type !== 'sqlite') {
                                panel.webview.postMessage({
                                    command: 'aiQueryError',
                                    error: 'AI query generation is currently only supported for SQLite databases'
                                });
                                return;
                            }

                            const sqlQuery = await this.generateAIQueryForTable(currentDb, currentTable, message.prompt);
                            panel.webview.postMessage({
                                command: 'aiQueryResult',
                                sqlQuery: sqlQuery
                            });
                        } catch (error) {
                            panel.webview.postMessage({
                                command: 'aiQueryError',
                                error: error instanceof Error ? error.message : String(error)
                            });
                        }
                    } else if (message.command === 'loadTable') {
                        // Handle table switch from webview
                        try {
                            const dbConnection = this.connections.find(c => c.name === message.database);
                            if (!dbConnection) {
                                panel.webview.postMessage({
                                    command: 'queryError',
                                    error: 'Database not found'
                                });
                                return;
                            }

                            const loadTableProvider = this.getProvider(dbConnection);
                            const tableData = await loadTableProvider.getTableData(dbConnection.path, message.table, pageSize, 0);
                            const tableRowCount = await loadTableProvider.getRowCount(dbConnection.path, message.table);

                            panel.webview.postMessage({
                                command: 'tableData',
                                data: tableData,
                                table: message.table,
                                totalRows: tableRowCount,
                                database: message.database
                            });
                        } catch (error) {
                            panel.webview.postMessage({
                                command: 'queryError',
                                error: error instanceof Error ? error.message : String(error)
                            });
                        }
                    } else if (message.command === 'saveTableSettings') {
                        // Save table settings to extension cache
                        try {
                            this.saveTableSettings(
                                message.database,
                                message.table,
                                {
                                    visibleColumns: message.visibleColumns,
                                    columnFilters: message.columnFilters,
                                    sortConfig: message.sortConfig
                                }
                            );
                        } catch (error) {
                            console.error('Failed to save table settings:', error);
                        }
                    } else if (message.command === 'loadTableSettings') {
                        // Load table settings from extension cache
                        try {
                            const settings = this.getTableSettings(message.database, message.table);
                            panel.webview.postMessage({
                                command: 'tableSettings',
                                settings: settings || null,
                                database: message.database,
                                table: message.table
                            });
                        } catch (error) {
                            panel.webview.postMessage({
                                command: 'tableSettings',
                                settings: null,
                                database: message.database,
                                table: message.table
                            });
                        }
                    } else if (message.command === 'updateCell') {
                        // Handle cell update request from webview
                        try {
                            const { rowData, columnName, newValue, tableName } = message;
                            
                            if (!rowData || !columnName || tableName === undefined) {
                                panel.webview.postMessage({
                                    command: 'updateCellError',
                                    error: 'Missing required parameters for cell update'
                                });
                                return;
                            }

                            const updateProvider = this.getProvider(connection);
                            const whereClause = await updateProvider.getRecordIdentifier(connection.path, tableName, rowData);
                            const result = await updateProvider.updateRecord(
                                connection.path,
                                tableName,
                                whereClause,
                                { [columnName]: newValue }
                            );

                            if (result.affectedCount === 0) {
                                throw new Error('No rows were updated. The record may have been deleted or modified by another process.');
                            } else if (result.affectedCount > 1) {
                                throw new Error(`Warning: ${result.affectedCount} rows were updated. This may indicate duplicate records.`);
                            }

                            if (result.success) {
                                panel.webview.postMessage({
                                    command: 'updateCellSuccess',
                                    columnName,
                                    newValue,
                                    rowsAffected: result.affectedCount
                                });
                                logger.info(`Successfully updated ${columnName} in ${tableName}`);
                            }
                        } catch (error) {
                            const errorMessage = error instanceof Error ? error.message : String(error);
                            panel.webview.postMessage({
                                command: 'updateCellError',
                                error: errorMessage
                            });
                            logger.error(`Failed to update cell in ${item.tableName}`, error);
                        }
                    }
                },
                undefined,
                this._disposables
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load data: ${error}`);
        }
    }

    async exportToJSON(item: DatabaseTreeItem, data?: any[]) {
        if (!item.connection) {
            vscode.window.showErrorMessage('No database connection available');
            return;
        }

        const connection = item.connection;

        try {
            const tableName = item.label ? (typeof item.label === 'string' ? item.label : item.label.label) : 'unknown';
            const timestamp = Math.floor(Date.now() / 1000);

            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${tableName}_${timestamp}.json`),
                filters: { 'JSON Files': ['json'] },
                title: 'Export to JSON'
            });

            if (!uri) {
                return; // User cancelled
            }

            let outputPath: string;
            const exportProvider = this.getProvider(connection);
            outputPath = await exportProvider.exportToJSON(connection.path, tableName, uri.fsPath, data);

            vscode.window.showInformationMessage(
                `Exported ${data ? data.length + ' rows' : 'table/collection'} to: ${outputPath}`
            );

            // Automatically open the file in the IDE
            const document = await vscode.workspace.openTextDocument(outputPath);
            await vscode.window.showTextDocument(document);
        } catch (error) {
            vscode.window.showErrorMessage(`Export failed: ${error}`);
        }
    }

    async exportToCSV(item: DatabaseTreeItem, data?: any[]) {
        if (!item.connection) {
            vscode.window.showErrorMessage('No database connection available');
            return;
        }

        const connection = item.connection;

        try {
            const tableName = item.label ? (typeof item.label === 'string' ? item.label : item.label.label) : 'unknown';
            const timestamp = Math.floor(Date.now() / 1000);

            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${tableName}_${timestamp}.csv`),
                filters: { 'CSV Files': ['csv'] },
                title: 'Export to CSV'
            });

            if (!uri) {
                return; // User cancelled
            }

            let outputPath: string;
            const csvProvider = this.getProvider(connection);
            outputPath = await csvProvider.exportToCSV(connection.path, tableName, uri.fsPath, data);

            vscode.window.showInformationMessage(
                `Exported ${data ? data.length + ' rows' : 'table/collection'} to: ${outputPath}`
            );

            // Automatically open the file in the IDE
            const document = await vscode.workspace.openTextDocument(outputPath);
            await vscode.window.showTextDocument(document);
        } catch (error) {
            vscode.window.showErrorMessage(`Export failed: ${error}`);
        }
    }

    async importFromJSON(item: DatabaseTreeItem) {
        if (!item.connection) {
            vscode.window.showErrorMessage('No database connection available');
            return;
        }

        const connection = item.connection;

        try {
            const uri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectMany: false,
                filters: { 'JSON Files': ['json'] },
                title: 'Select JSON file to import'
            });

            if (!uri || uri.length === 0) {
                return;
            }

            const tableName = await vscode.window.showInputBox({
                prompt: 'Enter table name for imported data',
                value: uri[0].fsPath.split('/').pop()?.replace('.json', '') || 'imported_data',
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Table name is required';
                    }
                    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
                        return 'Table name must start with letter or underscore, and contain only letters, numbers, underscores';
                    }
                    return null;
                }
            });

            if (!tableName) {
                return;
            }

            const importProvider = this.getProvider(connection);
            const rowCount = await importProvider.importFromJSON(connection.path, tableName, uri[0].fsPath);
            vscode.window.showInformationMessage(`Imported ${rowCount} rows into table "${tableName}"`);

            await this.refreshTables(connection);
            this._treeDataProvider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Import failed: ${error}`);
        }
    }

    async importFromCSV(item: DatabaseTreeItem) {
        if (!item.connection) {
            vscode.window.showErrorMessage('No database connection available');
            return;
        }

        const connection = item.connection;

        try {
            const uri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectMany: false,
                filters: { 'CSV Files': ['csv'] },
                title: 'Select CSV file to import'
            });

            if (!uri || uri.length === 0) {
                return;
            }

            const tableName = await vscode.window.showInputBox({
                prompt: 'Enter table name for imported data',
                value: uri[0].fsPath.split('/').pop()?.replace('.csv', '') || 'imported_data',
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Table name is required';
                    }
                    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
                        return 'Table name must start with letter or underscore, and contain only letters, numbers, underscores';
                    }
                    return null;
                }
            });

            if (!tableName) {
                return;
            }

            const csvImportProvider = this.getProvider(connection);
            const rowCount = await csvImportProvider.importFromCSV(connection.path, tableName, uri[0].fsPath);
            vscode.window.showInformationMessage(`Imported ${rowCount} rows into table "${tableName}"`);

            await this.refreshTables(connection);
            this._treeDataProvider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Import failed: ${error}`);
        }
    }

    async generateAIQueryForTable(connection: DatabaseItem, tableName: string, prompt: string): Promise<string> {
        try {
            // Get OpenAI API key from environment or settings
            let apiKey = process.env.OPENAI_API_KEY;
            
            if (!apiKey) {
                // Try to get from VSCode settings
                const config = vscode.workspace.getConfiguration('simpleDB');
                apiKey = config.get<string>('openaiApiKey');
                
                if (!apiKey) {
                    // Ask user to provide API key
                    const result = await vscode.window.showInputBox({
                        prompt: 'Enter your OpenAI API key (will be saved in settings)',
                        password: true,
                        validateInput: (value) => {
                            if (!value || value.trim().length === 0) {
                                return 'API key is required';
                            }
                            if (!value.startsWith('sk-')) {
                                return 'Invalid OpenAI API key format';
                            }
                            return null;
                        }
                    });
                    
                    if (result) {
                        apiKey = result;
                        // Save to settings
                        await config.update('openaiApiKey', apiKey, vscode.ConfigurationTarget.Global);
                    } else {
                        throw new Error('OpenAI API key is required for AI query generation');
                    }
                }
            }

            // Get table schema for context
            let tableSchema = '';
            let sampleData = '';
            if (connection.type === 'sqlite') {
                const aiProvider = this.getProvider(connection);
                const tableData = await aiProvider.getTableData(connection.path, tableName, 3, 0);
                if (tableData.length > 0) {
                    const columns = Object.keys(tableData[0]);
                    tableSchema = `Table: ${tableName}\nColumns: ${columns.join(', ')}`;
                    // Include sample data to help AI understand column types/values
                    sampleData = `\nSample data (first ${tableData.length} rows):\n${JSON.stringify(tableData, null, 2)}`;
                }
            }

            const systemPrompt = `You are a SQL expert. The user is currently viewing the "${tableName}" table. Convert their natural language query to SQL for this specific table.

${tableSchema}${sampleData}

Rules:
- ALWAYS use the table "${tableName}" - the user is looking at this table right now
- Only return the raw SQL query, nothing else
- Use proper SQLite syntax
- Do not include markdown formatting or code blocks
- Do not include explanations or comments
- If the user asks to "show all", "get everything", use SELECT * FROM ${tableName}
- If the user mentions filtering, use WHERE clauses
- If the user mentions sorting, use ORDER BY
- If the user mentions counting or aggregating, use appropriate aggregate functions
- Default to LIMIT 100 unless user specifies otherwise`;

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-3.5-turbo',
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    max_tokens: 500,
                    temperature: 0.1
                })
            });

            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json() as any;
            let sqlQuery = data.choices?.[0]?.message?.content?.trim();
            
            if (!sqlQuery) {
                throw new Error('No SQL query generated');
            }

            // Clean up any markdown formatting that might have slipped through
            sqlQuery = sqlQuery.replace(/^```sql\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

            return sqlQuery;
        } catch (error) {
            throw new Error(`AI query generation failed: ${error}`);
        }
    }
    
    async generateAIQuery(item: DatabaseTreeItem, prompt: string): Promise<string> {
        if (!item.connection) {
            throw new Error('No database connection available');
        }
        const tableName = item.tableName || (item.label ? (typeof item.label === 'string' ? item.label : item.label.label) : 'unknown');
        return this.generateAIQueryForTable(item.connection, tableName, prompt);
    }

    private showDataGrid(
        data: any[],
        tableName: string,
        totalRows: number,
        pageSize: number,
        dbType: DatabaseType,
        databaseName: string
    ): vscode.WebviewPanel {
        const panel = vscode.window.createWebviewPanel(
            'dataGrid',
            `Data: ${tableName}`,
            vscode.ViewColumn.One,
            { 
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(path.join(__dirname, '..'))]
            }
        );

        // Load the index.html file as webview
        const htmlPath = path.join(__dirname, '..', 'index.html');
        const fs = require('fs');
        let html = fs.readFileSync(htmlPath, 'utf8');
        
        // Get all databases and tables for the dropdown (with counts)
        // We'll fetch counts asynchronously and update the UI
        const databases = this.connections.map(conn => ({
            name: conn.name,
            type: conn.type,
            tables: conn.tables
        }));
        
        // Inject initial data and configuration BEFORE the main script loads
        const initScript = `
            <script>
                console.log('Injecting initial data...');
                window.initialTableData = ${JSON.stringify(data)};
                window.initialTableName = ${JSON.stringify(tableName)};
                window.initialDatabaseName = ${JSON.stringify(databaseName)};
                window.initialTotalRows = ${totalRows};
                window.initialPageSize = ${pageSize};
                window.dbType = ${JSON.stringify(dbType)};
                window.isVSCodeWebview = true;
                window.availableDatabases = ${JSON.stringify(databases)};
                console.log('Initial data injected:', {
                    rows: window.initialTableData.length,
                    table: window.initialTableName,
                    databases: window.availableDatabases.length
                });
            </script>
        `;
        
        // Inject the script in the HEAD (before other scripts load)
        html = html.replace('</head>', `${initScript}</head>`);
        
        panel.webview.html = html;
        
        // Fetch table counts asynchronously and send update
        this.fetchAndSendTableCounts(panel, databases);
        
        return panel;
    }

    private async fetchAndSendTableCounts(panel: vscode.WebviewPanel, databases: any[]) {
        try {
            const databasesWithCounts = await Promise.all(databases.map(async db => {
                const conn = this.connections.find(c => c.name === db.name);
                if (!conn) return db;
                
                const countProvider = this.getProvider(conn);
                const tablesWithCounts = await Promise.all(db.tables.map(async (tableName: string) => {
                    try {
                        const count = await countProvider.getRowCount(conn.path, tableName);
                        return { name: tableName, count };
                    } catch {
                        return { name: tableName, count: 0 };
                    }
                }));
                
                return {
                    name: db.name,
                    type: db.type,
                    tables: tablesWithCounts
                };
            }));
            
            // Send updated database info with counts
            panel.webview.postMessage({
                command: 'updateDatabasesWithCounts',
                databases: databasesWithCounts
            });
        } catch (error) {
            console.error('Failed to fetch table counts:', error);
        }
    }

    private normalizePageSize(value: unknown, fallback: number): number {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return fallback;
        }
        return Math.floor(parsed);
    }

    private normalizePageNumber(value: unknown, maxPage: number): number {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return 1;
        }
        return Math.min(Math.floor(parsed), Math.max(1, maxPage));
    }


    getConnections(): DatabaseItem[] {
        return this.connections;
    }

    private loadConnections() {
        const config = vscode.workspace.getConfiguration('simpleDB');
        const connections = config.get<any[]>('connections') || [];
        this.connections = connections;
    }

    private saveConnections() {
        const config = vscode.workspace.getConfiguration('simpleDB');
        config.update('connections', this.connections, vscode.ConfigurationTarget.Global);
    }
}

class DatabaseTreeDataProvider implements vscode.TreeDataProvider<DatabaseTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DatabaseTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private _loadingCounts: Set<string> = new Set();

    constructor(private explorer: DatabaseExplorer) {}

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: DatabaseTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
        if (!element) {
            // Check if there are no connections - show empty state
            if (this.explorer.connections.length === 0) {
                return [
                    new DatabaseTreeItem(null, 'No databases connected', vscode.TreeItemCollapsibleState.None, 'emptyState'),
                    new DatabaseTreeItem(null, 'Add SQLite Database', vscode.TreeItemCollapsibleState.None, 'actionButton'),
                    new DatabaseTreeItem(null, 'Add MongoDB Connection', vscode.TreeItemCollapsibleState.None, 'actionButton'),
                    new DatabaseTreeItem(null, 'Add PostgreSQL Connection', vscode.TreeItemCollapsibleState.None, 'actionButton'),
                    new DatabaseTreeItem(null, 'Add MySQL Connection', vscode.TreeItemCollapsibleState.None, 'actionButton'),
                    new DatabaseTreeItem(null, 'Add Redis Connection', vscode.TreeItemCollapsibleState.None, 'actionButton'),
                    new DatabaseTreeItem(null, 'Add LibSQL/Turso Connection', vscode.TreeItemCollapsibleState.None, 'actionButton'),
                ];
            }
            
            return this.explorer.connections.map(connection => 
                new DatabaseTreeItem(connection, connection.name, vscode.TreeItemCollapsibleState.Expanded, 'connection')
            );
        } else if (element.contextValue === 'connection' && element.connection) {
            const connection = element.connection;
            
            // If counts are already loaded, use them
            if (connection.countsLoaded && connection.tableCounts) {
                return connection.tables.map(table => 
                    new DatabaseTreeItem(connection, table, vscode.TreeItemCollapsibleState.None, 'table', connection.tableCounts![table])
                );
            }
            
            // Show tables immediately without counts, then fetch counts in background
            const items = connection.tables.map(table => {
                const count = connection.tableCounts?.[table];
                return new DatabaseTreeItem(connection, table, vscode.TreeItemCollapsibleState.None, 'table', count);
            });
            
            // Fetch counts in background if not already loading
            if (!this._loadingCounts.has(connection.name)) {
                this._loadingCounts.add(connection.name);
                this.fetchTableCountsAsync(connection).then(() => {
                    this._loadingCounts.delete(connection.name);
                });
            }
            
            return items;
        }
        return [];
    }
    
    private async fetchTableCountsAsync(connection: DatabaseItem): Promise<void> {
        try {
            connection.tableCounts = connection.tableCounts || {};
            const countProvider = this.explorer.getProvider(connection);
            
            // Fetch counts one by one to show progress faster
            for (const table of connection.tables) {
                try {
                    const count = await countProvider.getRowCount(connection.path, table);
                    connection.tableCounts[table] = count;
                    // Refresh the tree to show updated count
                    this._onDidChangeTreeData.fire(undefined);
                } catch (error) {
                    connection.tableCounts[table] = 0;
                }
            }
            
            connection.countsLoaded = true;
        } catch (error) {
            console.error('Failed to fetch table counts:', error);
        }
    }
}
