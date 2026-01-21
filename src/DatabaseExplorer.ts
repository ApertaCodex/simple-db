import * as vscode from 'vscode';
import * as path from 'path';
import { SQLiteManager } from './SQLiteManager';
import { MongoDBManager } from './MongoDBManager';

interface DatabaseItem {
    name: string;
    type: 'sqlite' | 'mongodb';
    path: string;
    tables: string[];
    tableCounts?: { [tableName: string]: number };
    countsLoaded?: boolean;
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
                this.iconPath = new vscode.ThemeIcon('add');
                // Set command for action buttons
                if (label.includes('SQLite')) {
                    this.command = {
                        command: 'simpleDB.addSQLite',
                        title: 'Add SQLite Database'
                    };
                } else if (label.includes('MongoDB')) {
                    this.command = {
                        command: 'simpleDB.addMongoDB',
                        title: 'Add MongoDB Connection'
                    };
                }
            }
            return;
        }
        
        // Normal tree items
        if (connection) {
            this.tooltip = `${connection.name} - ${label}`;
        }
        this.contextValue = contextValue;

        // Show record count on the right side of the row
        if (recordCount !== undefined) {
            this.description = `${recordCount.toLocaleString()} rows`;
        }

        if (contextValue === 'connection' && connection) {
            this.iconPath = new vscode.ThemeIcon(connection.type === 'sqlite' ? 'database' : 'server');
        } else if (contextValue === 'table') {
            this.iconPath = new vscode.ThemeIcon('table');
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

    constructor(public sqliteManager: SQLiteManager, public mongoManager: MongoDBManager) {
        this._treeDataProvider = new DatabaseTreeDataProvider(this);
        this.loadConnections();
    }

    getProvider() {
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
        const connection: DatabaseItem = {
            name,
            type: 'sqlite',
            path: filePath,
            tables: [],
            countsLoaded: false
        };

        try {
            connection.tables = await this.sqliteManager.getTables(filePath);
            this.connections.push(connection);
            this.saveConnections();
            this._treeDataProvider.refresh();
            vscode.window.showInformationMessage(`SQLite database "${name}" added successfully with ${connection.tables.length} tables`);
        } catch (error) {
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
                    connection.tables = await this.mongoManager.getCollections(connectionString);
                    this.connections.push(connection);
                    this.saveConnections();
                    this._treeDataProvider.refresh();
                    vscode.window.showInformationMessage(`MongoDB connection "${name}" added successfully with ${connection.tables.length} collections`);
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to connect to MongoDB: ${error}`);
                }
            }
        }
    }

    async refreshTables(connection: DatabaseItem) {
        try {
            // Reset counts so they get fetched again
            connection.countsLoaded = false;
            connection.tableCounts = {};
            
            if (connection.type === 'mongodb') {
                const collections = await this.mongoManager.getCollections(connection.path);
                connection.tables = collections;
                this.saveConnections();
                this._treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Collections refreshed for "${connection.name}"`);
            } else if (connection.type === 'sqlite') {
                const tables = await this.sqliteManager.getTables(connection.path);
                connection.tables = tables;
                this.saveConnections();
                this._treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Tables refreshed for "${connection.name}"`);
            }
        } catch (error) {
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
        
        const connection = item.connection; // Store reference for callbacks
        
        try {
            const pageSize = this.defaultPageSize;
            let data: any[] = [];
            let totalRows = 0;

            if (connection.type === 'sqlite') {
                [data, totalRows] = await Promise.all([
                    this.sqliteManager.getTableData(connection.path, item.tableName, pageSize, 0),
                    this.sqliteManager.getTableRowCount(connection.path, item.tableName)
                ]);
            } else {
                [data, totalRows] = await Promise.all([
                    this.mongoManager.getCollectionData(connection.path, item.tableName, pageSize, 0),
                    this.mongoManager.getCollectionCount(connection.path, item.tableName)
                ]);
            }

            const panel = this.showDataGrid(data, item.tableName, totalRows, pageSize, connection.type);

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
                    if (message.command === 'export') {
                        try {
                            const uri = await vscode.window.showSaveDialog({
                                defaultUri: vscode.Uri.file(message.filename || 'export.csv'),
                                filters: { 'CSV Files': ['csv'] }
                            });

                            if (uri) {
                                await vscode.workspace.fs.writeFile(uri, Buffer.from(message.data, 'utf8'));
                                vscode.window.showInformationMessage(`Data exported to ${uri.fsPath}`);
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(`Export failed: ${error}`);
                        }
                    } else if (message.command === 'loadPage') {
                        const requestedPageSize = this.normalizePageSize(message.pageSize, pageSize);
                        const totalPages = Math.max(1, Math.ceil(totalRows / requestedPageSize));
                        const requestedPage = this.normalizePageNumber(message.page, totalPages);
                        const offset = (requestedPage - 1) * requestedPageSize;

                        try {
                            let pageData: any[] = [];
                            if (connection.type === 'sqlite') {
                                pageData = await this.sqliteManager.getTableData(
                                    connection.path,
                                    item.tableName,
                                    requestedPageSize,
                                    offset
                                );
                            } else {
                                pageData = await this.mongoManager.getCollectionData(
                                    connection.path,
                                    item.tableName,
                                    requestedPageSize,
                                    offset
                                );
                            }

                            panel.webview.postMessage({
                                command: 'pageData',
                                data: pageData,
                                page: requestedPage,
                                pageSize: requestedPageSize,
                                totalRows
                            });
                        } catch (error) {
                            panel.webview.postMessage({
                                command: 'pageError',
                                error: error instanceof Error ? error.message : String(error)
                            });
                        }
                    } else if (message.command === 'executeQuery') {
                        try {
                            let result;
                            if (connection.type === 'sqlite') {
                                result = await this.executeQuery(connection.path, message.query);
                            } else {
                                panel.webview.postMessage({
                                    command: 'queryError',
                                    error: 'MongoDB query execution not yet implemented'
                                });
                                return;
                            }

                            panel.webview.postMessage({
                                command: 'queryResult',
                                data: result.data || result,
                                rowCount: result.data?.length || (Array.isArray(result) ? result.length : 0)
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
                            
                            const tableData = await (dbConnection.type === 'sqlite' 
                                ? this.sqliteManager.getTableData(dbConnection.path, message.table, pageSize, 0)
                                : this.mongoManager.getCollectionData(dbConnection.path, message.table, pageSize, 0));
                            
                            const tableRowCount = await (dbConnection.type === 'sqlite'
                                ? this.sqliteManager.getTableRowCount(dbConnection.path, message.table)
                                : this.mongoManager.getCollectionCount(dbConnection.path, message.table));
                            
                            panel.webview.postMessage({
                                command: 'tableData',
                                data: tableData,
                                table: message.table,
                                totalRows: tableRowCount
                            });
                        } catch (error) {
                            panel.webview.postMessage({
                                command: 'queryError',
                                error: error instanceof Error ? error.message : String(error)
                            });
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

    async openQueryConsole(item: DatabaseTreeItem) {
        if (!item.connection) {
            vscode.window.showErrorMessage('No database connection available');
            return;
        }
        
        const connection = item.connection; // Store reference for callbacks
        
        try {
            const pageSize = this.defaultPageSize;
            let data;
            if (connection.type === 'sqlite') {
                data = await this.sqliteManager.getTableData(connection.path, item.tableName, pageSize, 0);
            } else {
                data = await this.mongoManager.getCollectionData(connection.path, item.tableName, pageSize, 0);
            }

            this.showQueryConsole(data, item.tableName, connection.path);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open query console: ${error}`);
        }
    }

    async exportToJSON(item: DatabaseTreeItem) {
        if (!item.connection) {
            vscode.window.showErrorMessage('No database connection available');
            return;
        }
        
        const connection = item.connection; // Store reference
        
        try {
            if (connection.type !== 'sqlite') {
                vscode.window.showErrorMessage('JSON export is currently only supported for SQLite databases');
                return;
            }

            const tableName = item.label ? (typeof item.label === 'string' ? item.label : item.label.label) : 'unknown';
            const outputPath = await this.sqliteManager.exportToJSON(connection.path, tableName);
            vscode.window.showInformationMessage(`Table "${tableName}" exported to JSON: ${outputPath}`);
            
            // Ask if user wants to open the exported file
            const openAction = 'Open File';
            const result = await vscode.window.showInformationMessage(
                `Export completed successfully. Would you like to open the exported file?`,
                openAction
            );
            
            if (result === openAction) {
                const document = await vscode.workspace.openTextDocument(outputPath);
                await vscode.window.showTextDocument(document);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export table to JSON: ${error}`);
        }
    }

    async exportToCSV(item: DatabaseTreeItem) {
        if (!item.connection) {
            vscode.window.showErrorMessage('No database connection available');
            return;
        }
        
        const connection = item.connection; // Store reference
        
        try {
            if (connection.type !== 'sqlite') {
                vscode.window.showErrorMessage('CSV export is currently only supported for SQLite databases');
                return;
            }

            const tableName = item.label ? (typeof item.label === 'string' ? item.label : item.label.label) : 'unknown';
            const outputPath = await this.sqliteManager.exportToCSV(connection.path, tableName);
            vscode.window.showInformationMessage(`Table "${tableName}" exported to CSV: ${outputPath}`);
            
            // Ask if user wants to open the exported file
            const openAction = 'Open File';
            const result = await vscode.window.showInformationMessage(
                `Export completed successfully. Would you like to open the exported file?`,
                openAction
            );
            
            if (result === openAction) {
                const document = await vscode.workspace.openTextDocument(outputPath);
                await vscode.window.showTextDocument(document);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export table to CSV: ${error}`);
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
                const tableData = await this.sqliteManager.getTableData(connection.path, tableName, 3, 0);
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

    async queryTable(item: DatabaseTreeItem) {
        if (!item.connection) {
            vscode.window.showErrorMessage('No database connection available');
            return;
        }
        
        const connection = item.connection; // Store reference for callbacks
        
        const panel = vscode.window.createWebviewPanel(
            'queryInterface',
            `Query: ${item.tableName}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        const sampleQueries = connection.type === 'sqlite' ? [
            { label: 'Select All Records', query: `SELECT * FROM ${item.tableName} LIMIT 100` },
            { label: 'Count Records', query: `SELECT COUNT(*) as total FROM ${item.tableName}` },
            { label: 'Select First 10', query: `SELECT * FROM ${item.tableName} LIMIT 10` },
            { label: 'Select Distinct Values', query: `SELECT DISTINCT * FROM ${item.tableName}` },
            { label: 'Delete All Records', query: `DELETE FROM ${item.tableName}` },
            { label: 'Drop Table', query: `DROP TABLE ${item.tableName}` }
        ] : [
            { label: 'Find All Documents', query: `db.${item.tableName}.find({})` },
            { label: 'Count Documents', query: `db.${item.tableName}.countDocuments({})` },
            { label: 'Find First 10', query: `db.${item.tableName}.find({}).limit(10)` },
            { label: 'Delete All Documents', query: `db.${item.tableName}.deleteMany({})` },
            { label: 'Drop Collection', query: `db.${item.tableName}.drop()` }
        ];

        panel.webview.html = this.getQueryInterfaceHtml(item.tableName, sampleQueries);

        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'executeQuery') {
                try {
                    let result;
                    if (connection.type === 'sqlite') {
                        result = await this.executeQuery(connection.path, message.query);
                    } else {
                        // MongoDB query execution
                        vscode.window.showWarningMessage('MongoDB query execution not yet implemented');
                        return;
                    }

                    panel.webview.postMessage({
                        command: 'queryResult',
                        data: result.data || result,
                        rowCount: result.data?.length || 0
                    });
                } catch (error) {
                    panel.webview.postMessage({
                        command: 'queryError',
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }
        });
    }

    private async executeQuery(dbPath: string, query: string): Promise<any> {
        try {
            // For now, we'll use SQLite manager to execute queries
            // This is a simplified implementation
            const sqlite3 = require('sqlite3').verbose();
            const db = new sqlite3.Database(dbPath);
            
            return new Promise((resolve, reject) => {
                db.all(query, [], (err: any, rows: any[]) => {
                    db.close();
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ data: rows });
                    }
                });
            });
        } catch (error) {
            throw new Error(`Query execution failed: ${error}`);
        }
    }

    private showDataGrid(data: any[], tableName: string, totalRows: number, pageSize: number, dbType: 'sqlite' | 'mongodb'): vscode.WebviewPanel {
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
                
                const tablesWithCounts = await Promise.all(db.tables.map(async (tableName: string) => {
                    try {
                        const count = conn.type === 'sqlite'
                            ? await this.sqliteManager.getTableRowCount(conn.path, tableName)
                            : await this.mongoManager.getCollectionCount(conn.path, tableName);
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

    private showQueryConsole(data: any[], tableName: string, dbPath: string) {
        const panel = vscode.window.createWebviewPanel(
            'queryConsole',
            `SQL Query: ${tableName}`,
            vscode.ViewColumn.Two,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        panel.webview.html = this.getQueryConsoleHtml(data, tableName, dbPath);
        
        // Handle messages from webview
        panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'executeQuery':
                        this.executeQuery(dbPath, message.query).then(result => {
                            panel.webview.postMessage({ command: 'queryResult', data: result });
                        }).catch(error => {
                            panel.webview.postMessage({ command: 'queryError', error: error.toString() });
                        });
                        break;
                }
            },
            undefined,
            this._disposables
        );
    }

    private getCellClass(value: any): string {
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'boolean') return 'boolean';
        if (typeof value === 'number') return 'number';
        if (typeof value === 'string') return 'string';
        return '';
    }

    private formatCellValue(value: any): string {
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'string') return value;
        if (typeof value === 'number') return value.toLocaleString();
        if (typeof value === 'boolean') return value.toString();
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value, null, 2);
            } catch {
                return '[Object]';
            }
        }
        return String(value);
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

    private getQueryConsoleHtml(data: any[], tableName: string, dbPath: string): string {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>SQL Query - ${tableName}</title>
            <style>
                :root {
                    --bg-primary: #1e1e1e;
                    --bg-secondary: #252526;
                    --bg-tertiary: #2d2d30;
                    --border-color: #3e3e42;
                    --text-primary: #cccccc;
                    --text-secondary: #969696;
                    --accent: #007acc;
                    --accent-hover: #1a8ad6;
                    --row-hover: #2a2d2e;
                    --header-bg: #333333;
                    --input-bg: #3c3c3c;
                }

                * {
                    box-sizing: border-box;
                    margin: 0;
                    padding: 0;
                }

                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    background-color: var(--bg-primary);
                    color: var(--text-primary);
                    font-size: 13px;
                    line-height: 1.4;
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }

                .console-container {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                }

                .console-header {
                    background-color: var(--bg-secondary);
                    border-bottom: 1px solid var(--border-color);
                    padding: 12px 16px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-shrink: 0;
                }

                .console-title {
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--text-primary);
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .console-controls {
                    display: flex;
                    gap: 8px;
                }

                .console-btn {
                    background-color: var(--accent);
                    color: white;
                    border: none;
                    padding: 6px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 500;
                    transition: background-color 0.2s;
                }

                .console-btn:hover {
                    background-color: var(--accent-hover);
                }

                .console-btn-secondary {
                    background-color: var(--bg-tertiary);
                    color: var(--text-primary);
                    border: 1px solid var(--border-color);
                }

                .console-btn-secondary:hover {
                    background-color: var(--row-hover);
                }

                .query-editor {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    min-height: 0;
                    overflow: hidden;
                    transition: min-height 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                }

                .query-editor.expanded {
                    min-height: 200px;
                }

                .query-textarea {
                    flex: 1;
                    background-color: var(--input-bg);
                    border: 1px solid var(--border-color);
                    color: var(--text-primary);
                    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                    font-size: 12px;
                    padding: 12px;
                    border-radius: 4px;
                    resize: none;
                    outline: none;
                    line-height: 1.5;
                }

                .query-textarea:focus {
                    border-color: var(--accent);
                }

                .query-textarea::placeholder {
                    color: var(--text-secondary);
                }

                .results-container {
                    flex: 1;
                    background-color: var(--bg-primary);
                    overflow: auto;
                    border-top: 1px solid var(--border-color);
                }

                .results-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 12px;
                }

                .results-table th,
                .results-table td {
                    padding: 8px 12px;
                    text-align: left;
                    border-bottom: 1px solid var(--border-color);
                    vertical-align: top;
                }

                .results-table th {
                    background-color: var(--header-bg);
                    color: var(--text-primary);
                    font-weight: 600;
                    position: sticky;
                    top: 0;
                    z-index: 10;
                }

                .results-table tr:hover td {
                    background-color: var(--row-hover);
                }

                .error-message {
                    color: #ff6b6b;
                    background-color: rgba(255, 107, 107, 0.1);
                    padding: 12px;
                    border-radius: 4px;
                    border: 1px solid rgba(255, 107, 107, 0.2);
                    margin: 12px;
                }

                .loading {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                    color: var(--text-secondary);
                }

                ::-webkit-scrollbar {
                    width: 12px;
                    height: 12px;
                }

                ::-webkit-scrollbar-track {
                    background: var(--bg-primary);
                }

                ::-webkit-scrollbar-thumb {
                    background: var(--border-color);
                    border-radius: 6px;
                }

                ::-webkit-scrollbar-thumb:hover {
                    background: #555555;
                }
            </style>
        </head>
        <body>
            <div class="console-container">
                <div class="console-header">
                    <div class="console-title">SQL Query</div>
                    <div class="console-controls">
                        <button class="console-btn console-btn-secondary" onclick="clearQuery()">Clear</button>
                        <button class="console-btn" onclick="executeQuery()">Execute</button>
                    </div>
                </div>
                <div class="query-editor" id="query-editor">
                    <textarea 
                        class="query-textarea" 
                        id="query-input" 
                        placeholder="SELECT * FROM ${tableName} WHERE condition ORDER BY column LIMIT 10"
                        spellcheck="false"
                    ></textarea>
                </div>
                <div class="results-container" id="results-container">
                    <div class="loading" id="loading" style="display: none;">
                        Executing query...
                    </div>
                </div>
            </div>
            
            <script>
                const vscode = acquireVsCodeApi();
                
                function clearQuery() {
                    document.getElementById('query-input').value = '';
                }
                
                function executeQuery() {
                    const query = document.getElementById('query-input').value.trim();
                    if (!query) return;
                    
                    document.getElementById('loading').style.display = 'flex';
                    document.getElementById('results-container').innerHTML = '';
                    
                    vscode.postMessage({
                        command: 'executeQuery',
                        query: query
                    });
                }
                
                function showResults(data) {
                    document.getElementById('loading').style.display = 'none';
                    
                    if (data.error) {
                        document.getElementById('results-container').innerHTML = 
                            '<div class="error-message">Error: ' + data.error + '</div>';
                        return;
                    }
                    
                    if (!data.data || data.data.length === 0) {
                        document.getElementById('results-container').innerHTML = 
                            '<div style="padding: 20px; text-align: center; color: var(--text-secondary);">No results found</div>';
                        return;
                    }
                    
                    const columns = Object.keys(data.data[0]);
                    let html = '<table class="results-table"><thead><tr>';
                    columns.forEach(col => {
                        html += '<th>' + col + '</th>';
                    });
                    html += '</tr></thead><tbody>';
                    
                    data.data.forEach(row => {
                        html += '<tr>';
                        columns.forEach(col => {
                            html += '<td>' + (row[col] === null ? 'NULL' : row[col]) + '</td>';
                        });
                        html += '</tr>';
                    });
                    
                    html += '</tbody></table>';
                    document.getElementById('results-container').innerHTML = html;
                }
                
                // Handle messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.command) {
                        case 'queryResult':
                            showResults(message.data);
                            break;
                        case 'queryError':
                            showResults({ error: message.error });
                            break;
                    }
                });
                
                // Auto-expand query editor on focus
                document.getElementById('query-input').addEventListener('focus', () => {
                    document.getElementById('query-editor').classList.add('expanded');
                });
                
                document.getElementById('query-input').addEventListener('blur', () => {
                    if (!document.getElementById('query-input').value.trim()) {
                        document.getElementById('query-editor').classList.remove('expanded');
                    }
                });
            </script>
        </body>
        </html>`;
    }

    private getQueryInterfaceHtml(tableName: string, sampleQueries: Array<{label: string, query: string}>): string {
        const sampleOptions = sampleQueries.map((sq, idx) =>
            `<option value="${idx}">${sq.label}</option>`
        ).join('');

        const queriesJson = JSON.stringify(sampleQueries.map(sq => sq.query));

        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                }
                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                }
                h2 { margin: 0; }
                .query-section {
                    margin-bottom: 20px;
                }
                .sample-queries {
                    margin-bottom: 10px;
                    display: flex;
                    gap: 10px;
                    align-items: center;
                }
                select, button {
                    padding: 6px 12px;
                    background-color: var(--vscode-dropdown-background);
                    color: var(--vscode-dropdown-foreground);
                    border: 1px solid var(--vscode-dropdown-border);
                    cursor: pointer;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                button.danger {
                    background-color: #d73a49;
                    color: white;
                }
                button.danger:hover {
                    background-color: #cb2431;
                }
                textarea {
                    width: 100%;
                    min-height: 150px;
                    padding: 10px;
                    font-family: 'Courier New', monospace;
                    font-size: 14px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    resize: vertical;
                }
                .results {
                    margin-top: 20px;
                }
                .result-info {
                    padding: 10px;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    margin-bottom: 10px;
                    border-radius: 3px;
                }
                .error {
                    color: var(--vscode-errorForeground);
                    background-color: var(--vscode-inputValidation-errorBackground);
                    padding: 10px;
                    border-radius: 3px;
                    margin-top: 10px;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 10px;
                }
                th, td {
                    padding: 8px;
                    border: 1px solid var(--vscode-panel-border);
                    text-align: left;
                }
                th {
                    background-color: var(--vscode-editor-selectionBackground);
                    font-weight: bold;
                }
                .warning {
                    background-color: #856404;
                    color: #fff3cd;
                    padding: 10px;
                    border-radius: 3px;
                    margin-bottom: 10px;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h2>Query: ${tableName}</h2>
            </div>

            <div class="query-section">
                <div class="sample-queries">
                    <label for="sampleQuery">Sample Queries:</label>
                    <select id="sampleQuery" onchange="loadSampleQuery()">
                        <option value="">-- Select a query --</option>
                        ${sampleOptions}
                    </select>
                    <button onclick="loadSampleQuery()">Load</button>
                </div>

                <textarea id="queryInput" placeholder="Enter your SQL query here..."></textarea>

                <div style="margin-top: 10px; display: flex; gap: 10px;">
                    <button onclick="executeQuery()">Execute Query</button>
                    <button onclick="clearResults()">Clear Results</button>
                </div>
            </div>

            <div id="results" class="results"></div>

            <script>
                const vscode = acquireVsCodeApi();
                const sampleQueries = ${queriesJson};

                function loadSampleQuery() {
                    const select = document.getElementById('sampleQuery');
                    const idx = select.value;
                    if (idx !== '' && sampleQueries[idx]) {
                        document.getElementById('queryInput').value = sampleQueries[idx];

                        // Show warning for destructive queries
                        const query = sampleQueries[idx].toUpperCase();
                        if (query.includes('DELETE') || query.includes('DROP')) {
                            showWarning();
                        }
                    }
                }

                function showWarning() {
                    const resultsDiv = document.getElementById('results');
                    resultsDiv.innerHTML = '<div class="warning">⚠️ Warning: This is a destructive operation that cannot be undone!</div>';
                }

                function executeQuery() {
                    const query = document.getElementById('queryInput').value.trim();
                    if (!query) {
                        document.getElementById('results').innerHTML = '<div class="error">Please enter a query</div>';
                        return;
                    }

                    // Show loading
                    document.getElementById('results').innerHTML = '<div class="result-info">Executing query...</div>';

                    vscode.postMessage({
                        command: 'executeQuery',
                        query: query
                    });
                }

                function clearResults() {
                    document.getElementById('results').innerHTML = '';
                    document.getElementById('queryInput').value = '';
                    document.getElementById('sampleQuery').value = '';
                }

                window.addEventListener('message', event => {
                    const message = event.data;

                    if (message.command === 'queryResult') {
                        displayResults(message.data, message.rowCount);
                    } else if (message.command === 'queryError') {
                        displayError(message.error);
                    }
                });

                function displayResults(data, rowCount) {
                    const resultsDiv = document.getElementById('results');

                    if (!data || data.length === 0) {
                        resultsDiv.innerHTML = '<div class="result-info">Query executed successfully. No rows returned.</div>';
                        return;
                    }

                    const columns = Object.keys(data[0]);
                    let html = \`<div class="result-info">Returned \${rowCount} row(s)</div>\`;

                    html += '<table><thead><tr>';
                    columns.forEach(col => {
                        html += \`<th>\${col}</th>\`;
                    });
                    html += '</tr></thead><tbody>';

                    data.forEach(row => {
                        html += '<tr>';
                        columns.forEach(col => {
                            const value = row[col] === null ? 'NULL' : row[col];
                            html += \`<td>\${value}</td>\`;
                        });
                        html += '</tr>';
                    });

                    html += '</tbody></table>';
                    resultsDiv.innerHTML = html;
                }

                function displayError(error) {
                    document.getElementById('results').innerHTML = \`<div class="error">Error: \${error}</div>\`;
                }
            </script>
        </body>
        </html>`;
    }

    private getDataGridHtml(data: any[], tableName: string, totalRows: number, pageSize: number, dbType: 'sqlite' | 'mongodb'): string {
        const columns = data.length > 0 ? Object.keys(data[0]) : [];
        const dataJson = JSON.stringify(data);
        const columnsJson = JSON.stringify(columns);

        // Sample queries based on database type
        const sampleQueries = dbType === 'sqlite' ? [
            { label: 'Select All Records', query: `SELECT * FROM ${tableName} LIMIT 100` },
            { label: 'Count Records', query: `SELECT COUNT(*) as total FROM ${tableName}` },
            { label: 'First 10 Rows', query: `SELECT * FROM ${tableName} LIMIT 10` },
            { label: 'Random 10 Records', query: `SELECT * FROM ${tableName} ORDER BY RANDOM() LIMIT 10` }
        ] : [
            { label: 'Find All Documents', query: `db.${tableName}.find({})` },
            { label: 'Count Documents', query: `db.${tableName}.countDocuments({})` },
            { label: 'Find First 10', query: `db.${tableName}.find({}).limit(10)` }
        ];

        const sampleOptions = sampleQueries.map(sq =>
            `<option value="${sq.query}">${sq.label}</option>`
        ).join('');

        const queriesJson = JSON.stringify(sampleQueries.map(sq => sq.query));
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${tableName} - Data Browser</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class'
        }
    </script>
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet">
    <style>
        :root {
            --bg-main: #f9fafb;
            --bg-surface: #ffffff;
            --border-color: #e5e7eb;
            --text-main: #1f2937;
            --text-muted: #6b7280;
        }
        .dark {
            --bg-main: #000000;
            --bg-surface: #18181b;
            --border-color: #27272a;
            --text-main: #ffffff;
            --text-muted: #a1a1aa;
        }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
        .custom-scrollbar::-webkit-scrollbar { width: 10px; height: 10px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: var(--bg-main); }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #888; border-radius: 5px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #555; }
        .fade-in { animation: fadeIn 0.15s ease-in-out; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
        th.dragging { opacity: 0.4; background-color: #e5e7eb; border: 2px dashed #9ca3af; }
        th.drag-over-left { border-left: 3px solid #2563eb; }
        th.drag-over-right { border-right: 3px solid #2563eb; }
        .sort-badge { font-size: 0.65rem; height: 16px; width: 16px; line-height: 16px; text-align: center; border-radius: 50%; background-color: #dbeafe; color: #1e40af; font-weight: 700; display: inline-block; margin-left: 2px; }
        #loadingOverlay { background: rgba(255, 255, 255, 0.8); backdrop-filter: blur(2px); }
        .dark #loadingOverlay { background: rgba(0, 0, 0, 0.85); }
    </style>
</head>
<body class="bg-gray-50 text-gray-800 h-screen flex flex-col overflow-hidden transition-colors duration-300 dark:bg-black dark:text-zinc-100">

    <div id="loadingOverlay" class="fixed inset-0 z-50 flex items-center justify-center hidden">
        <div class="flex flex-col items-center">
            <span class="material-symbols-outlined text-4xl animate-spin text-blue-600 mb-2">progress_activity</span>
            <span class="text-sm font-medium text-gray-600 dark:text-gray-300" id="loadingText">Processing...</span>
        </div>
    </div>

    <header class="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between shadow-sm z-20 dark:bg-zinc-900 dark:border-zinc-800">
        <div class="flex items-center gap-4">
            <div class="flex flex-col">
                <h1 class="text-lg font-semibold text-gray-800 leading-tight dark:text-zinc-100">
                    <span class="material-symbols-outlined text-xl align-middle mr-2">table_view</span>
                    ${tableName}
                </h1>
                <p class="text-xs text-gray-500 dark:text-zinc-500">${totalRows} total records</p>
            </div>
        </div>

        <div class="flex items-center gap-3">
            <div class="relative hidden md:block group">
                <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-lg dark:text-zinc-500">search</span>
                <input id="globalSearch" type="text" placeholder="Search all columns..." class="pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100" />
            </div>
            <div class="h-6 w-px bg-gray-200 mx-1 dark:bg-zinc-800"></div>
            <button class="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800" onclick="toggleQueryPanel()">
                <span class="material-symbols-outlined text-lg">terminal</span> Query
            </button>
            <button class="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800" onclick="toggleColumnManager(event)">
                <span class="material-symbols-outlined text-lg">view_column</span> Columns
            </button>
            <button class="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800" onclick="exportData()">
                <span class="material-symbols-outlined text-lg">download</span> Export
            </button>
            <button class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800" onclick="toggleTheme()">
                <span class="material-symbols-outlined" id="themeIcon">dark_mode</span>
            </button>
        </div>
    </header>

    <div class="hidden bg-white border-b border-gray-200 shadow-inner flex-shrink-0 dark:bg-zinc-900 dark:border-zinc-800" id="queryPanel">
        <div class="p-4 max-w-7xl mx-auto">
            <div class="flex gap-4 mb-3">
                <select id="sampleQueries" onchange="loadSampleQuery(this.value)" class="px-3 py-2 text-sm border border-gray-300 rounded-lg dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100">
                    <option value="">-- Sample Queries --</option>
                    ${sampleOptions}
                </select>
            </div>
            <div class="relative">
                <textarea id="queryInput" placeholder="Enter ${dbType === 'sqlite' ? 'SQL' : 'MongoDB'} query here..." class="w-full min-h-32 p-3 font-mono text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100" spellcheck="false"></textarea>
                <div class="mt-2 flex gap-2">
                    <button onclick="executeCustomQuery()" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">Execute</button>
                    <button onclick="clearQuery()" class="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-600">Clear</button>
                </div>
            </div>
            <div class="mt-2 text-xs text-gray-500 hidden dark:text-zinc-400" id="queryStatus"></div>
        </div>
    </div>

    <div class="px-6 py-3 bg-white border-b border-gray-200 flex items-center justify-between flex-shrink-0 dark:bg-zinc-900 dark:border-zinc-800">
        <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-gray-600 dark:text-zinc-400" id="totalRecords">${totalRows} Records</span>
            <span id="filterBadge" class="hidden px-2 py-1 text-xs bg-blue-100 text-blue-600 rounded-full dark:bg-blue-900 dark:text-blue-200">Filtered</span>
            <span class="text-xs text-gray-400 ml-2 italic hidden md:inline dark:text-zinc-500">Shift+Click to multi-sort</span>
        </div>
        <div class="flex items-center gap-2">
            <button onclick="clearAllFilters()" class="px-3 py-1 text-xs text-gray-600 hover:text-gray-800 dark:text-zinc-400 dark:hover:text-zinc-200">
                <span class="material-symbols-outlined text-sm align-middle">filter_alt_off</span> Clear Filters
            </button>
            <button onclick="resetView()" class="px-3 py-1 text-xs text-gray-600 hover:text-gray-800 dark:text-zinc-400 dark:hover:text-zinc-200">
                <span class="material-symbols-outlined text-sm align-middle">refresh</span> Reset
            </button>
        </div>
    </div>

    <div class="flex-1 overflow-auto relative custom-scrollbar bg-white dark:bg-zinc-900">
        <table class="w-full text-left border-collapse">
            <thead class="bg-gray-50 sticky top-0 z-10 dark:bg-zinc-800" id="tableHeaderRow"></thead>
            <tbody class="divide-y divide-gray-200 text-sm text-gray-700 dark:divide-zinc-700 dark:text-zinc-200" id="tableBody"></tbody>
        </table>
        <div class="flex flex-col items-center justify-center h-64 text-gray-400 dark:text-zinc-500 hidden" id="emptyState">
            <span class="material-symbols-outlined text-6xl mb-2">inbox</span>
            <p class="text-lg font-medium text-gray-500 dark:text-zinc-400">No data to display</p>
        </div>
    </div>

    <footer class="bg-white border-t border-gray-200 px-6 py-3 flex items-center justify-between flex-shrink-0 text-sm dark:bg-zinc-900 dark:border-zinc-800">
        <div class="flex items-center gap-2 text-gray-600 dark:text-zinc-400">
            <span>Rows:</span>
            <select id="rowsPerPage" onchange="changeRowsPerPage(this.value)" class="px-2 py-1 border border-gray-300 rounded dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100">
                <option value="20" selected>20</option>
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="500">500</option>
            </select>
        </div>
        <div class="flex items-center gap-4">
            <span class="text-gray-600 dark:text-zinc-400" id="pageInfo">Page 1 of 1</span>
            <div class="flex gap-1">
                <button id="btnPrev" onclick="prevPage()" class="px-3 py-1 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800 dark:text-zinc-300">Previous</button>
                <button id="btnNext" onclick="nextPage()" class="px-3 py-1 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800 dark:text-zinc-300">Next</button>
            </div>
        </div>
    </footer>

    <div class="hidden absolute z-50 bg-white border border-gray-200 rounded-lg shadow-xl w-64 text-sm fade-in dark:bg-zinc-900 dark:border-zinc-800" id="columnManager" style="top: 130px; right: 24px;">
        <div class="p-3 border-b border-gray-200 bg-gray-50 rounded-t-lg flex justify-between items-center dark:bg-zinc-800 dark:border-zinc-700">
            <span class="font-semibold text-gray-700 dark:text-zinc-200">Manage Columns</span>
            <button class="text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200" onclick="toggleColumnManager(event)">×</button>
        </div>
        <div class="p-2 max-h-64 overflow-y-auto custom-scrollbar" id="columnList"></div>
    </div>

    <div class="hidden absolute z-50 bg-white border border-gray-200 rounded-lg shadow-xl w-80 text-sm fade-in dark:bg-zinc-900 dark:border-zinc-800" id="filterPopover">
        <div class="p-3 border-b border-gray-200 bg-gray-50 rounded-t-lg flex justify-between items-center dark:bg-zinc-800 dark:border-zinc-700">
            <span class="font-semibold text-gray-700 dark:text-zinc-200" id="filterTitle">Filter Column</span>
            <button class="text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200" onclick="closeFilterPopover()">×</button>
        </div>
        <div class="p-4 space-y-3" id="filterContent"></div>
        <div class="p-3 border-t border-gray-200 bg-gray-50 rounded-b-lg flex justify-end gap-2 dark:bg-zinc-800 dark:border-zinc-700">
            <button class="px-3 py-1 text-sm text-gray-600 hover:text-gray-800 dark:text-zinc-400" onclick="clearCurrentFilter()">Clear</button>
            <button class="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700" onclick="applyCurrentFilter()">Apply</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let allData = ${dataJson};
        let filteredData = [];
        let columns = ${columnsJson};
        let visibleColumns = [...columns];
        let sortConfig = [];
        let draggedColumn = null;
        let currentFilterCol = null;

        let state = {
            currentPage: 1,
            rowsPerPage: ${pageSize},
            columnFilters: {},
            globalSearch: '',
            darkMode: false
        };

        function initTheme() {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            setTheme(prefersDark);
        }

        function toggleTheme() {
            setTheme(!state.darkMode);
        }

        function setTheme(isDark) {
            state.darkMode = isDark;
            const html = document.documentElement;
            const themeIcon = document.getElementById('themeIcon');
            if (isDark) {
                html.classList.add('dark');
                themeIcon.textContent = 'light_mode';
            } else {
                html.classList.remove('dark');
                themeIcon.textContent = 'dark_mode';
            }
        }

        function initTable() {
            renderHeader();
            renderBody();
        }

        function renderHeader() {
            const tr = document.getElementById('tableHeaderRow');
            tr.innerHTML = '<tr>' + visibleColumns.map((col) => {
                const sortIndex = sortConfig.findIndex(s => s.col === col);
                const sortDir = sortIndex >= 0 ? sortConfig[sortIndex].dir : null;
                const sortBadge = sortIndex >= 0 ? \`<span class="sort-badge">\${sortIndex + 1}</span>\` : '';
                const sortIcon = sortDir === 'asc' ? '↑' : sortDir === 'desc' ? '↓' : '';
                const isFiltered = state.columnFilters[col];
                return \`<th draggable="true" ondragstart="handleDragStart(event, '\${col}')" ondragover="handleDragOver(event, '\${col}')" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event, '\${col}')" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer select-none dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-700 group" onclick="handleSort(event, '\${col}')">
                    <div class="flex items-center justify-between">
                        <span>\${formatColumnName(col)} \${sortIcon} \${sortBadge}</span>
                        <button onclick="openFilter(event, '\${col}')" class="ml-2 p-1 hover:bg-gray-200 rounded dark:hover:bg-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity \${isFiltered ? '!opacity-100 bg-blue-100 dark:bg-blue-900' : ''}">
                            <span class="material-symbols-outlined text-sm">filter_alt</span>
                        </button>
                    </div>
                </th>\`;
            }).join('') + '</tr>';
        }

        function renderBody() {
            const tbody = document.getElementById('tableBody');
            const emptyState = document.getElementById('emptyState');
            
            if (filteredData.length === 0) {
                tbody.innerHTML = '';
                emptyState.classList.remove('hidden');
                return;
            }
            emptyState.classList.add('hidden');

            const start = (state.currentPage - 1) * state.rowsPerPage;
            const end = start + state.rowsPerPage;
            const pageData = filteredData.slice(start, end);

            tbody.innerHTML = pageData.map((row) => \`<tr class="hover:bg-gray-50 dark:hover:bg-zinc-800">\${visibleColumns.map(col => {
                const value = row[col];
                let content = value === null || value === undefined ? '<span class="text-gray-400 dark:text-zinc-500 italic">NULL</span>' : String(value);
                let cls = '';
                if (value === null || value === undefined) cls = 'text-gray-400 dark:text-zinc-500';
                else if (typeof value === 'boolean') cls = value ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
                else if (typeof value === 'number') cls = 'text-blue-600 dark:text-blue-400 font-mono';
                return \`<td class="px-6 py-3 whitespace-nowrap \${cls}">\${content}</td>\`;
            }).join('')}</tr>\`).join('');
        }

        function handleSort(event, col) {
            const isShift = event.shiftKey;
            const existingIndex = sortConfig.findIndex(s => s.col === col);
            if (isShift) {
                if (existingIndex >= 0) {
                    if (sortConfig[existingIndex].dir === 'asc') sortConfig[existingIndex].dir = 'desc';
                    else sortConfig.splice(existingIndex, 1);
                } else sortConfig.push({ col, dir: 'asc' });
            } else {
                if (existingIndex >= 0) {
                    if (sortConfig[existingIndex].dir === 'asc') sortConfig = [{ col, dir: 'desc' }];
                    else sortConfig = [];
                } else sortConfig = [{ col, dir: 'asc' }];
            }
            processData();
        }

        function processData() {
            let temp = allData.filter(row => {
                for (let col in state.columnFilters) {
                    const filter = state.columnFilters[col];
                    const value = String(row[col] || '').toLowerCase();
                    const filterValue = filter.value.toLowerCase();
                    if (filter.op === 'contains' && !value.includes(filterValue)) return false;
                    if (filter.op === 'equals' && value !== filterValue) return false;
                    if (filter.op === 'starts' && !value.startsWith(filterValue)) return false;
                    if (filter.op === 'ends' && !value.endsWith(filterValue)) return false;
                }
                if (state.globalSearch) {
                    const searchLower = state.globalSearch.toLowerCase();
                    const match = visibleColumns.some(col => String(row[col] || '').toLowerCase().includes(searchLower));
                    if (!match) return false;
                }
                return true;
            });

            if (sortConfig.length > 0) {
                temp.sort((a, b) => {
                    for (let s of sortConfig) {
                        const aVal = a[s.col]; const bVal = b[s.col];
                        if (aVal < bVal) return s.dir === 'asc' ? -1 : 1;
                        if (aVal > bVal) return s.dir === 'asc' ? 1 : -1;
                    }
                    return 0;
                });
            }
            filteredData = temp;
            state.currentPage = 1;
            updateUI();
        }

        function updateUI() {
            renderHeader();
            renderBody();
            renderPagination();
            updateTotalCount();
            const badge = document.getElementById('filterBadge');
            if (Object.keys(state.columnFilters).length > 0 || state.globalSearch) {
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        }

        function updateTotalCount() {
            document.getElementById('totalRecords').textContent = \`\${filteredData.length} Records\`;
        }

        function renderPagination() {
            const totalPages = Math.ceil(filteredData.length / state.rowsPerPage) || 1;
            document.getElementById('pageInfo').textContent = \`Page \${state.currentPage} of \${totalPages}\`;
            document.getElementById('btnPrev').disabled = state.currentPage === 1;
            document.getElementById('btnNext').disabled = state.currentPage === totalPages;
        }

        function nextPage() {
            if (state.currentPage < Math.ceil(filteredData.length / state.rowsPerPage)) {
                state.currentPage++;
                updateUI();
            }
        }

        function prevPage() {
            if (state.currentPage > 1) {
                state.currentPage--;
                updateUI();
            }
        }

        function changeRowsPerPage(val) {
            state.rowsPerPage = parseInt(val);
            state.currentPage = 1;
            updateUI();
        }

        function formatColumnName(col) {
            return col.replace(/_/g, ' ').replace(/\\b\\w/g, l => l.toUpperCase());
        }

        function openFilter(event, col) {
            event.stopPropagation();
            currentFilterCol = col;
            const btn = event.currentTarget;
            const rect = btn.getBoundingClientRect();
            const popover = document.getElementById('filterPopover');
            let left = rect.left;
            if (left + 320 > window.innerWidth) left = window.innerWidth - 330;
            popover.style.top = (rect.bottom + 5) + 'px';
            popover.style.left = left + 'px';

            document.getElementById('filterTitle').textContent = \`Filter \${formatColumnName(col)}\`;
            const current = state.columnFilters[col] || { op: 'contains', value: '' };

            const html = \`
                <select id="filterOp" class="w-full border border-gray-300 rounded-lg p-2 text-sm dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100">
                    <option value="contains" \${current.op === 'contains' ? 'selected' : ''}>Contains</option>
                    <option value="equals" \${current.op === 'equals' ? 'selected' : ''}>Equals</option>
                    <option value="starts" \${current.op === 'starts' ? 'selected' : ''}>Starts With</option>
                    <option value="ends" \${current.op === 'ends' ? 'selected' : ''}>Ends With</option>
                </select>
                <input type="text" id="filterVal" value="\${current.value}" class="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100" placeholder="Value..." autofocus>
            \`;
            document.getElementById('filterContent').innerHTML = html;
            popover.classList.remove('hidden');
            setTimeout(() => document.getElementById('filterVal').focus(), 50);
        }

        function applyCurrentFilter() {
            const op = document.getElementById('filterOp').value;
            const val = document.getElementById('filterVal').value;
            if (val === '') delete state.columnFilters[currentFilterCol];
            else state.columnFilters[currentFilterCol] = { op, value: val };
            closeFilterPopover();
            processData();
        }

        function clearCurrentFilter() {
            delete state.columnFilters[currentFilterCol];
            closeFilterPopover();
            processData();
        }

        function closeFilterPopover() {
            document.getElementById('filterPopover').classList.add('hidden');
        }

        function clearAllFilters() {
            state.columnFilters = {};
            document.getElementById('globalSearch').value = '';
            state.globalSearch = '';
            processData();
        }

        function toggleColumnManager(e) {
            e.stopPropagation();
            const el = document.getElementById('columnManager');
            el.classList.toggle('hidden');
            if (!el.classList.contains('hidden')) {
                const list = document.getElementById('columnList');
                list.innerHTML = columns.map(col => \`
                    <label class="flex items-center gap-2 p-2 hover:bg-gray-100 rounded cursor-pointer dark:hover:bg-zinc-800">
                        <input type="checkbox" \${visibleColumns.includes(col) ? 'checked' : ''} onchange="toggleColumn('\${col}')" class="rounded">
                        <span class="text-sm dark:text-zinc-200">\${formatColumnName(col)}</span>
                    </label>
                \`).join('');
            }
        }

        function toggleColumn(col) {
            if (visibleColumns.includes(col)) {
                visibleColumns = visibleColumns.filter(c => c !== col);
            } else {
                visibleColumns.push(col);
                visibleColumns.sort((a, b) => columns.indexOf(a) - columns.indexOf(b));
            }
            initTable();
        }

        function resetView() {
            visibleColumns = [...columns];
            clearAllFilters();
            sortConfig = [];
            initTable();
        }

        function handleDragStart(e, col) {
            draggedColumn = col;
            e.target.closest('th').classList.add('dragging');
        }

        function handleDragOver(e, col) {
            e.preventDefault();
            if (draggedColumn === col) return;
            const th = e.currentTarget;
            const rect = th.getBoundingClientRect();
            th.classList.remove('drag-over-left', 'drag-over-right');
            if (e.clientX < rect.left + rect.width / 2) th.classList.add('drag-over-left');
            else th.classList.add('drag-over-right');
        }

        function handleDragLeave(e) {
            e.currentTarget.classList.remove('drag-over-left', 'drag-over-right');
        }

        function handleDrop(e, targetCol) {
            e.preventDefault();
            e.currentTarget.classList.remove('drag-over-left', 'drag-over-right');
            document.querySelectorAll('th').forEach(th => th.classList.remove('dragging'));
            if (draggedColumn && draggedColumn !== targetCol) {
                const fromIdx = visibleColumns.indexOf(draggedColumn);
                const toIdx = visibleColumns.indexOf(targetCol);
                visibleColumns.splice(fromIdx, 1);
                const newToIdx = visibleColumns.indexOf(targetCol);
                const rect = e.currentTarget.getBoundingClientRect();
                const insertIdx = e.clientX < rect.left + rect.width / 2 ? newToIdx : newToIdx + 1;
                visibleColumns.splice(insertIdx, 0, draggedColumn);
                initTable();
            }
        }

        function toggleQueryPanel() {
            document.getElementById('queryPanel').classList.toggle('hidden');
        }

        function loadSampleQuery(query) {
            if (!query) return;
            document.getElementById('queryInput').value = query;
        }

        function executeCustomQuery() {
            const query = document.getElementById('queryInput').value;
            if (!query.trim()) return;
            const status = document.getElementById('queryStatus');
            status.classList.remove('hidden');
            status.innerHTML = 'Executing...';
            
            vscode.postMessage({
                command: 'executeQuery',
                query: query
            });
        }

        function clearQuery() {
            document.getElementById('queryInput').value = '';
        }

        function exportData() {
            if (filteredData.length === 0) return alert('No data to export');
            const header = visibleColumns.join(',');
            const rows = filteredData.map(row => 
                visibleColumns.map(col => \`"\${String(row[col] || '').replace(/"/g, '""')}"\`).join(',')
            ).join('\\n');
            const csv = header + '\\n' + rows;
            
            vscode.postMessage({
                command: 'export',
                data: csv,
                filename: '${tableName}_export.csv'
            });
        }

        document.getElementById('globalSearch').addEventListener('input', (e) => {
            state.globalSearch = e.target.value;
            processData();
        });

        document.addEventListener('click', (e) => {
            if (!document.getElementById('filterPopover').classList.contains('hidden') && 
                !e.target.closest('#filterPopover') && !e.target.closest('button[onclick*="openFilter"]')) {
                closeFilterPopover();
            }
            if (!document.getElementById('columnManager').classList.contains('hidden') && 
                !e.target.closest('#columnManager') && !e.target.closest('button[onclick*="toggleColumnManager"]')) {
                document.getElementById('columnManager').classList.add('hidden');
            }
        });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'queryResult') {
                const status = document.getElementById('queryStatus');
                if (message.data && message.data.length > 0) {
                    allData = message.data;
                    columns = Object.keys(message.data[0]);
                    visibleColumns = [...columns];
                    processData();
                    status.innerHTML = \`✓ Query returned \${message.data.length} rows\`;
                    setTimeout(() => status.classList.add('hidden'), 3000);
                } else {
                    status.innerHTML = '✓ Query executed successfully (no results)';
                    setTimeout(() => status.classList.add('hidden'), 3000);
                }
            } else if (message.command === 'queryError') {
                const status = document.getElementById('queryStatus');
                status.innerHTML = '✗ Error: ' + message.error;
            }
        });

        // Initialize
        initTheme();
        processData();
    </script>
</body>
</html>`;
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
                    new DatabaseTreeItem(null, 'Add MongoDB Connection', vscode.TreeItemCollapsibleState.None, 'actionButton')
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
            
            // Fetch counts one by one to show progress faster
            for (const table of connection.tables) {
                try {
                    let count = 0;
                    if (connection.type === 'sqlite') {
                        count = await this.explorer.sqliteManager.getTableRowCount(connection.path, table);
                    } else {
                        count = await this.explorer.mongoManager.getCollectionCount(connection.path, table);
                    }
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
