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
}

class DatabaseTreeItem extends vscode.TreeItem {
    public readonly tableName: string;

    constructor(
        public readonly connection: DatabaseItem,
        label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        public readonly recordCount?: number
    ) {
        super(label, collapsibleState);
        this.tableName = label;
        this.tooltip = `${this.connection.name} - ${label}`;
        this.contextValue = contextValue;

        // Show record count on the right side of the row
        if (recordCount !== undefined) {
            this.description = `${recordCount.toLocaleString()} rows`;
        }

        if (contextValue === 'connection') {
            this.iconPath = new vscode.ThemeIcon(this.connection.type === 'sqlite' ? 'database' : 'server');
        } else {
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
            tables: []
        };

        try {
            connection.tables = await this.sqliteManager.getTables(filePath);
            this.connections.push(connection);
            this.saveConnections();
            this._treeDataProvider.refresh();
            vscode.window.showInformationMessage(`SQLite database "${name}" added successfully`);
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
                    tables: []
                };

                try {
                    connection.tables = await this.mongoManager.getCollections(connectionString);
                    this.connections.push(connection);
                    this.saveConnections();
                    this._treeDataProvider.refresh();
                    vscode.window.showInformationMessage(`MongoDB connection "${name}" added successfully`);
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to connect to MongoDB: ${error}`);
                }
            }
        }
    }

    async refreshTables(connection: DatabaseItem) {
        try {
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
        const index = this.connections.findIndex(c => c.name === item.connection.name);
        if (index !== -1) {
            this.connections.splice(index, 1);
            this.saveConnections();
            this._treeDataProvider.refresh();
            vscode.window.showInformationMessage(`Connection "${item.connection.name}" removed`);
        }
    }

    async viewData(item: DatabaseTreeItem) {
        try {
            const pageSize = this.defaultPageSize;
            let data: any[] = [];
            let totalRows = 0;

            if (item.connection.type === 'sqlite') {
                [data, totalRows] = await Promise.all([
                    this.sqliteManager.getTableData(item.connection.path, item.tableName, pageSize, 0),
                    this.sqliteManager.getTableRowCount(item.connection.path, item.tableName)
                ]);
            } else {
                [data, totalRows] = await Promise.all([
                    this.mongoManager.getCollectionData(item.connection.path, item.tableName, pageSize, 0),
                    this.mongoManager.getCollectionCount(item.connection.path, item.tableName)
                ]);
            }

            const panel = this.showDataGrid(data, item.tableName, totalRows, pageSize, item.connection.type);

            panel.webview.onDidReceiveMessage(
                async message => {
                    if (message.command === 'loadPage') {
                        const requestedPageSize = this.normalizePageSize(message.pageSize, pageSize);
                        const totalPages = Math.max(1, Math.ceil(totalRows / requestedPageSize));
                        const requestedPage = this.normalizePageNumber(message.page, totalPages);
                        const offset = (requestedPage - 1) * requestedPageSize;

                        try {
                            let pageData: any[] = [];
                            if (item.connection.type === 'sqlite') {
                                pageData = await this.sqliteManager.getTableData(
                                    item.connection.path,
                                    item.tableName,
                                    requestedPageSize,
                                    offset
                                );
                            } else {
                                pageData = await this.mongoManager.getCollectionData(
                                    item.connection.path,
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
                            if (item.connection.type === 'sqlite') {
                                result = await this.executeQuery(item.connection.path, message.query);
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
                            if (item.connection.type !== 'sqlite') {
                                panel.webview.postMessage({
                                    command: 'aiQueryError',
                                    error: 'AI query generation is currently only supported for SQLite databases'
                                });
                                return;
                            }

                            const sqlQuery = await this.generateAIQuery(item, message.prompt);
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
        try {
            const pageSize = this.defaultPageSize;
            let data;
            if (item.connection.type === 'sqlite') {
                data = await this.sqliteManager.getTableData(item.connection.path, item.tableName, pageSize, 0);
            } else {
                data = await this.mongoManager.getCollectionData(item.connection.path, item.tableName, pageSize, 0);
            }

            this.showQueryConsole(data, item.tableName, item.connection.path);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open query console: ${error}`);
        }
    }

    async exportToJSON(item: DatabaseTreeItem) {
        try {
            if (item.connection.type !== 'sqlite') {
                vscode.window.showErrorMessage('JSON export is currently only supported for SQLite databases');
                return;
            }

            const tableName = item.label ? (typeof item.label === 'string' ? item.label : item.label.label) : 'unknown';
            const outputPath = await this.sqliteManager.exportToJSON(item.connection.path, tableName);
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
        try {
            if (item.connection.type !== 'sqlite') {
                vscode.window.showErrorMessage('CSV export is currently only supported for SQLite databases');
                return;
            }

            const tableName = item.label ? (typeof item.label === 'string' ? item.label : item.label.label) : 'unknown';
            const outputPath = await this.sqliteManager.exportToCSV(item.connection.path, tableName);
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

    async generateAIQuery(item: DatabaseTreeItem, prompt: string): Promise<string> {
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
            if (item.connection.type === 'sqlite') {
                const tableName = item.label ? (typeof item.label === 'string' ? item.label : item.label.label) : 'unknown';
                const tableData = await this.sqliteManager.getTableData(item.connection.path, tableName, 1, 0);
                if (tableData.length > 0) {
                    const columns = Object.keys(tableData[0]);
                    tableSchema = `Table: ${tableName}\nColumns: ${columns.join(', ')}\n`;
                }
            }

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
                            content: `You are a SQL expert. Convert natural language queries to SQL. Only respond with the SQL query, no explanations. Use the table schema provided for context.\n\n${tableSchema}\nRules:\n- Only return the SQL query\n- Use proper SQLite syntax\n- Do not include markdown formatting\n- Do not include explanations`
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    max_tokens: 500,
                    temperature: 0.3
                })
            });

            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json() as any;
            const sqlQuery = data.choices?.[0]?.message?.content?.trim();
            
            if (!sqlQuery) {
                throw new Error('No SQL query generated');
            }

            return sqlQuery;
        } catch (error) {
            throw new Error(`AI query generation failed: ${error}`);
        }
    }

    async queryTable(item: DatabaseTreeItem) {
        const panel = vscode.window.createWebviewPanel(
            'queryInterface',
            `Query: ${item.tableName}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        const sampleQueries = item.connection.type === 'sqlite' ? [
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
                    if (item.connection.type === 'sqlite') {
                        result = await this.executeQuery(item.connection.path, message.query);
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
            { enableScripts: true }
        );

        panel.webview.html = this.getDataGridHtml(data, tableName, totalRows, pageSize, dbType);
        return panel;
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

        // Sample queries based on database type
        const sampleQueries = dbType === 'sqlite' ? [
            { label: 'First 10 Rows', query: `SELECT * FROM ${tableName} LIMIT 10` },
            { label: 'Count All Records', query: `SELECT COUNT(*) as total FROM ${tableName}` },
            { label: 'Random 10 Records', query: `SELECT * FROM ${tableName} ORDER BY RANDOM() LIMIT 10` }
        ] : [
            { label: 'Find All Documents', query: `db.${tableName}.find({})` },
            { label: 'Count Documents', query: `db.${tableName}.countDocuments({})` },
            { label: 'Find First 10', query: `db.${tableName}.find({}).limit(10)` }
        ];

        const sampleOptions = sampleQueries.map((sq, idx) =>
            `<option value="${sq.query}">${sq.label}</option>`
        ).join('');

        const queriesJson = JSON.stringify(sampleQueries.map(sq => sq.query));
        
        return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="utf-8">
            <meta content="width=device-width, initial-scale=1.0" name="viewport">
            <title>${tableName} - Database Explorer</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet">
            <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
            
            <style>
                body { font-family: 'Roboto', sans-serif; }
                h1 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .custom-scrollbar::-webkit-scrollbar { width: 8px; height: 8px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, 0.2); border-radius: 4px; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.4); }
                .custom-scrollbar::-webkit-scrollbar-thumb:active { background: rgba(0, 0, 0, 0.5); }
                .fade-in { animation: fadeIn 0.15s ease-in-out; }
                @keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
                th.dragging { opacity: 0.4; background-color: #4b5563; border: 2px dashed #6b7280; }
                th.drag-over-left { border-left: 3px solid #6b7280; }
                th.drag-over-right { border-right: 3px solid #6b7280; }
                .sort-badge { font-size: 0.65rem; height: 16px; width: 16px; line-height: 16px; text-align: center; border-radius: 50%; background-color: #4b5563; color: #d1d5db; font-weight: 700; display: inline-block; margin-left: 2px; }
                
                /* Loading Overlay */
                #loadingOverlay {
                    background: rgba(31, 41, 55, 0.8);
                    backdrop-filter: blur(2px);
                }
            </style>
        </head>

        <body class="bg-gray-900 text-gray-100 h-screen flex flex-col overflow-hidden">

            <div id="loadingOverlay" class="fixed inset-0 z-50 flex items-center justify-center hidden">
                <div class="flex flex-col items-center">
                    <span class="material-symbols-outlined text-4xl animate-spin text-gray-400 mb-2">progress_activity</span>
                    <span class="text-sm font-medium text-gray-300" id="loadingText">Processing...</span>
                </div>
            </div>

            <header class="bg-gray-800 border-b border-gray-700 px-6 py-3 flex items-center justify-between shadow-sm z-20">
                <div class="flex items-center gap-3">
                    <div>
                        <h1 class="text-lg font-semibold text-gray-100 leading-tight">${tableName}</h1>
                        <p class="text-xs text-gray-400" id="dbMeta">${dbType === 'sqlite' ? 'SQLite Database' : 'MongoDB Collection'}</p>
                    </div>
                </div>

                <div class="flex items-center gap-3">
                    <div class="relative">
                        <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-lg">search</span>
                        <input class="pl-10 pr-4 py-2 border border-gray-600 rounded-full text-sm focus:outline-none focus:border-gray-500 focus:ring-1 focus:ring-gray-500 w-64 bg-gray-700 text-gray-100 transition-all"
                            id="globalSearch" placeholder="Search loaded data..." type="text">
                    </div>
                    <div class="h-6 w-px bg-gray-600 mx-1"></div>
                    <button class="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-300 bg-gray-700 border border-gray-600 rounded-md hover:bg-gray-600 transition-colors"
                        onclick="toggleQueryPanel()">
                        <span class="material-symbols-outlined text-lg">terminal</span> <span>Query</span>
                    </button>
                    <button class="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-300 bg-gray-700 border border-gray-600 rounded-md hover:bg-gray-600 transition-colors"
                        onclick="exportData()">
                        <span class="material-symbols-outlined text-lg">download</span> <span>Export</span>
                    </button>
                </div>
            </header>

            <div class="hidden bg-gray-800 border-b border-gray-700 shadow-inner flex-shrink-0 transition-all duration-300 ease-in-out" id="queryPanel">
                <div class="p-4 max-w-7xl mx-auto">
                    <div class="flex gap-4 mb-3">
                        <div class="flex bg-gray-700 p-1 rounded-lg">
                            <button class="px-4 py-1.5 text-sm font-medium rounded-md shadow-sm bg-gray-600 text-gray-100 transition-all" id="modeSql" onclick="setQueryMode('sql')">SQL</button>
                            <button class="px-4 py-1.5 text-sm font-medium rounded-md text-gray-400 hover:text-gray-100 transition-all flex items-center gap-1" id="modeAi" onclick="setQueryMode('ai')">
                                <span class="material-symbols-outlined text-base">radio_button_unchecked</span> AI
                            </button>
                        </div>
                        <div class="flex-1" id="sampleQueriesContainer">
                            <select class="w-full text-sm border-gray-600 border rounded-md px-3 py-2 focus:ring-gray-500 focus:border-gray-500 bg-gray-700 text-gray-100" id="sampleQueries" onchange="loadSampleQuery(this.value)">
                                <option value="">-- Load a Sample Query --</option>
                                ${sampleOptions}
                            </select>
                        </div>
                    </div>
                    <div class="relative">
                        <textarea class="w-full font-mono text-sm bg-gray-700 border border-gray-600 rounded-lg p-4 focus:ring-2 focus:ring-gray-500 focus:border-gray-500 outline-none transition-all resize-y text-gray-100"
                            id="queryInput" placeholder="SELECT * FROM..." rows="4"></textarea>
                        <div class="absolute bottom-3 right-3 flex gap-2">
                            <button class="px-3 py-1.5 text-xs font-medium text-gray-400 bg-gray-700 border border-gray-600 rounded hover:bg-gray-600" onclick="clearQuery()">Clear</button>
                            <button class="px-4 py-1.5 text-xs font-bold text-gray-100 bg-gray-600 rounded hover:bg-gray-500 shadow-sm flex items-center gap-1" onclick="executeCustomQuery()">
                                <span class="material-symbols-outlined text-sm">play_arrow</span> Run
                            </button>
                        </div>
                    </div>
                    <div class="mt-2 text-xs text-gray-400 hidden" id="queryStatus"></div>
                </div>
            </div>

            <div class="px-6 py-3 bg-gray-800 border-b border-gray-700 flex items-center justify-between flex-shrink-0">
                <div class="flex items-center gap-2">
                    <span class="text-sm font-medium text-gray-300 bg-gray-700 px-2 py-1 rounded" id="totalRecords">${data.length} Records</span>
                    <span class="hidden text-xs font-medium text-gray-400 bg-gray-700 px-2 py-1 rounded border border-gray-600 flex items-center gap-1 cursor-pointer hover:bg-gray-600"
                        id="filterBadge" onclick="clearAllFilters()">
                        Filters Active <span class="material-symbols-outlined text-xs">close</span>
                    </span>
                    <span class="text-xs text-gray-500 ml-2 italic hidden md:inline">Shift+Click to multi-sort. Drag headers to reorder.</span>
                </div>
                <div class="flex items-center gap-2">
                    <button class="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-gray-300 bg-gray-700 border border-gray-600 rounded hover:bg-gray-600 hover:text-slate-400 transition-colors"
                        onclick="toggleColumnManager(event)">
                        <span class="material-symbols-outlined text-lg">view_column</span> Columns
                    </button>
                    <button class="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-gray-300 bg-gray-700 border border-gray-600 rounded hover:bg-gray-600 transition-colors"
                        onclick="resetView()">
                        <span class="material-symbols-outlined text-lg">restart_alt</span> Reset
                    </button>
                </div>
            </div>

            <div class="flex-1 overflow-auto relative custom-scrollbar bg-gray-800">
                <table class="w-full text-left border-collapse">
                    <thead class="bg-gray-700 sticky top-0 z-10 shadow-sm text-xs uppercase text-gray-400 font-semibold tracking-wider">
                        <tr id="tableHeaderRow">
                            ${columns.map((col, index) => `
                                <th draggable="true"
                                    class="px-6 py-3 border-b border-gray-600 group hover:bg-gray-600 transition-colors select-none cursor-pointer relative" 
                                    onclick="handleSort(event, '${col}')"
                                    ondragstart="handleDragStart(event, '${col}')" ondragover="handleDragOver(event, '${col}')" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event, '${col}')">
                                    <div class="flex items-center justify-between">
                                        <span class="flex items-center gap-1">
                                            <span class="material-symbols-outlined text-gray-500 text-sm cursor-grab active:cursor-grabbing mr-1">drag_indicator</span>
                                            ${col.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                                        </span>
                                        <div class="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button onclick="openFilter(event, '${col}')" 
                                                class="p-1 rounded hover:bg-gray-500 text-gray-500">
                                                <span class="material-symbols-outlined text-base">filter_alt</span>
                                            </button>
                                        </div>
                                    </div>
                                </th>
                            `).join('')}
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-700 text-sm text-gray-300" id="tableBody">
                        ${data.map(row => `
                            <tr class="hover:bg-gray-700 transition-colors group border-b border-gray-700 last:border-0">
                                ${columns.map(col => {
                                    const val = row[col];
                                    let content = val;
                                    let cls = '';
                                    
                                    if (val === null || val === undefined) {
                                        content = '<span class="text-gray-500 italic">null</span>';
                                    } else if (typeof val === 'boolean') {
                                        content = val ?
                                            `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">TRUE</span>` :
                                            `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">FALSE</span>`;
                                    } else if (typeof val === 'number') {
                                        cls = 'font-mono text-gray-400';
                                    } else if (typeof val === 'string' && val.includes('@') && col.toLowerCase().includes('email')) {
                                        content = `<a href="mailto:${val}" class="text-gray-400 hover:text-gray-300">${val}</a>`;
                                    } else if (typeof val === 'string' && val.length > 50) {
                                        content = val.substring(0, 50) + '...';
                                        cls = 'text-xs text-gray-500';
                                    }

                                    return `<td class="px-6 py-3 whitespace-nowrap ${cls}">${content}</td>`;
                                }).join('')}
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>

            <footer class="bg-gray-800 border-t border-gray-700 px-6 py-3 flex items-center justify-between flex-shrink-0 text-sm">
                <div class="flex items-center gap-2 text-gray-400">
                    <span>Rows:</span>
                    <select class="border-gray-600 border rounded py-1 px-2 focus:ring-gray-500 focus:border-gray-500 bg-gray-700 text-gray-300 cursor-pointer"
                        id="rowsPerPage" onchange="changeRowsPerPage(this.value)">
                        <option value="10">10</option>
                        <option selected value="20">20</option>
                        <option value="50">50</option>
                        <option value="100">100</option>
                    </select>
                </div>
                <div class="flex items-center gap-4">
                    <span class="text-gray-400" id="pageInfo">Page 1 of 1</span>
                    <div class="flex gap-1">
                        <button class="p-1 rounded hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed text-gray-400"
                            id="btnPrev" onclick="prevPage()" disabled>
                            <span class="material-symbols-outlined">chevron_left</span>
                        </button>
                        <button class="p-1 rounded hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed text-gray-400"
                            id="btnNext" onclick="nextPage()" disabled>
                            <span class="material-symbols-outlined">chevron_right</span>
                        </button>
                    </div>
                </div>
            </footer>

            <div class="hidden absolute z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl w-64 text-sm fade-in"
                id="columnManager" style="top: 130px; right: 24px;">
                <div class="p-3 border-b border-gray-600 bg-gray-700 rounded-t-lg flex justify-between items-center">
                    <span class="font-semibold text-gray-200">Manage Columns</span>
                    <button class="text-gray-400 hover:text-gray-200" onclick="document.getElementById('columnManager').classList.add('hidden')"><span class="material-symbols-outlined text-lg">close</span></button>
                </div>
                <div class="p-2 max-h-64 overflow-y-auto custom-scrollbar" id="columnList"></div>
            </div>

            <div class="hidden absolute z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl w-80 text-sm fade-in" id="filterPopover">
                <div class="p-3 border-b border-gray-600 bg-gray-700 rounded-t-lg flex justify-between items-center">
                    <span class="font-semibold text-gray-200" id="filterTitle">Filter Column</span>
                    <button class="text-gray-400 hover:text-gray-200" onclick="closeFilterPopover()"><span class="material-symbols-outlined text-lg">close</span></button>
                </div>
                <div class="p-4 space-y-3" id="filterContent"></div>
                <div class="p-3 border-t border-gray-600 bg-gray-700 rounded-b-lg flex justify-end gap-2">
                    <button class="px-3 py-1.5 text-gray-400 hover:bg-gray-600 rounded border border-gray-600 bg-gray-700" onclick="clearCurrentFilter()">Clear</button>
                    <button class="px-3 py-1.5 text-gray-100 bg-gray-600 hover:bg-gray-500 rounded shadow-sm" onclick="applyCurrentFilter()">Apply</button>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                
                // --- 1. Global State & Variables ---
                let allData = ${JSON.stringify(data)};
                let filteredData = [...allData];
                let columns = ${JSON.stringify(columns)};
                let visibleColumns = [...columns];
                let columnStats = {};
                let sortConfig = [];
                let draggedColumn = null;

                let state = {
                    currentPage: 1,
                    rowsPerPage: ${pageSize},
                    columnFilters: {},
                    globalSearch: ''
                };

                let totalRows = ${totalRows};

                // --- 2. Utility Functions ---
                function formatColumnName(col) { 
                    return col.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()); 
                }

                function getCellClass(value) {
                    if (value === null || value === undefined) return 'null';
                    if (typeof value === 'boolean') return 'boolean';
                    if (typeof value === 'number') return 'number';
                    if (typeof value === 'string') return 'string';
                    return '';
                }

                function formatCellValue(value) {
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

                // --- 3. Smart Column Analysis (Enums) ---
                function analyzeColumns() {
                    columnStats = {};
                    const palette = [
                        { bg: 'bg-slate-100', text: 'text-slate-800' }, { bg: 'bg-green-100', text: 'text-green-800' },
                        { bg: 'bg-purple-100', text: 'text-purple-800' }, { bg: 'bg-yellow-100', text: 'text-yellow-800' },
                        { bg: 'bg-indigo-100', text: 'text-indigo-800' }, { bg: 'bg-pink-100', text: 'text-pink-800' },
                        { bg: 'bg-gray-100', text: 'text-gray-800' }, { bg: 'bg-red-100', text: 'text-red-800' },
                        { bg: 'bg-orange-100', text: 'text-orange-800' }
                    ];

                    if(allData.length === 0) return;

                    columns.forEach(col => {
                        const sampleVal = allData[0][col];
                        const type = typeof sampleVal;
                        
                        // Identify Enums: Low cardinality strings
                        if (type === 'string' && !col.toLowerCase().includes('email') && !col.toLowerCase().includes('id') && !col.toLowerCase().includes('name')) {
                            const uniqueValues = new Set(allData.map(d => d[col]));
                            if (uniqueValues.size < 20 && uniqueValues.size > 1 && allData.length > 20) {
                                const valueColorMap = {};
                                let colorIdx = 0;
                                Array.from(uniqueValues).sort().forEach(val => {
                                    valueColorMap[val] = palette[colorIdx % palette.length];
                                    colorIdx++;
                                });
                                columnStats[col] = { isEnum: true, options: Array.from(uniqueValues).sort(), colorMap: valueColorMap };
                                return;
                            }
                        }
                        columnStats[col] = { isEnum: false, options: [] };
                    });
                }

                // --- 4. Rendering Logic ---
                function initTable() {
                    renderHeader();
                    renderBody();
                }

                function renderHeader() {
                    const tr = document.getElementById('tableHeaderRow');
                    tr.innerHTML = visibleColumns.map((col, index) => {
                        const sortIndex = sortConfig.findIndex(s => s.col === col);
                        const isSorted = sortIndex !== -1;
                        const sortDir = isSorted ? sortConfig[sortIndex].dir : null;
                        const isFiltered = state.columnFilters[col];

                        return \`
                        <th draggable="true"
                            class="px-6 py-3 border-b border-gray-600 group hover:bg-gray-600 transition-colors select-none cursor-pointer relative" 
                            onclick="handleSort(event, '\${col}')"
                            ondragstart="handleDragStart(event, '\${col}')" ondragover="handleDragOver(event, '\${col}')" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event, '\${col}')">
                            <div class="flex items-center justify-between">
                                <span class="flex items-center gap-1 \${isSorted ? 'text-gray-100 font-bold' : ''}">
                                    <span class="material-symbols-outlined text-gray-500 text-sm cursor-grab active:cursor-grabbing mr-1">drag_indicator</span>
                                    \${col.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                                    \${isSorted ? \`<span class="material-symbols-outlined text-sm font-bold">\${sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward'}</span>\` : ''}
                                    \${(isSorted && sortConfig.length > 1) ? \`<span class="sort-badge">\${sortIndex + 1}</span>\` : ''}
                                </span>
                                <div class="flex items-center opacity-0 group-hover:opacity-100 \${isFiltered ? 'opacity-100' : ''} transition-opacity">
                                    <button onclick="openFilter(event, '\${col}')" 
                                        class="p-1 rounded hover:bg-gray-500 \${isFiltered ? 'text-gray-100 bg-gray-600' : 'text-gray-500'}">
                                        <span class="material-symbols-outlined text-base">filter_alt</span>
                                    </button>
                                </div>
                            </div>
                        </th>
                    \`;
                    }).join('');
                }

                function renderBody() {
                    const tbody = document.getElementById('tableBody');
                    
                    if (filteredData.length === 0) {
                        if(allData.length > 0) {
                             tbody.innerHTML = \`<tr><td colspan="\${visibleColumns.length}" class="px-6 py-8 text-center text-gray-400">No records found matching your filters.</td></tr>\`;
                        } else {
                             tbody.innerHTML = ''; // Show empty state
                        }
                        return;
                    }

                    const start = (state.currentPage - 1) * state.rowsPerPage;
                    const end = start + state.rowsPerPage;
                    const pageData = filteredData.slice(start, end);

                    tbody.innerHTML = pageData.map((row) => \`
                        <tr class="hover:bg-slate-50/50 transition-colors group border-b border-gray-100 last:border-0">
                            \${visibleColumns.map(col => {
                                const val = row[col];
                                let content = val;
                                let cls = '';
                                const stats = columnStats[col];

                                if (val === null || val === undefined) {
                                    content = '<span class="text-gray-300 italic">null</span>';
                                } else if (stats && stats.isEnum) {
                                    const color = stats.colorMap[val] || { bg: 'bg-gray-100', text: 'text-gray-800' };
                                    content = \`<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium \${color.bg} \${color.text}">\${val}</span>\`;
                                } else if (typeof val === 'boolean' || (typeof val === 'number' && (val === 0 || val === 1) && col.toLowerCase().includes('is_'))) {
                                    const boolVal = typeof val === 'boolean' ? val : val === 1;
                                    content = boolVal ?
                                        \`<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">TRUE</span>\` :
                                        \`<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">FALSE</span>\`;
                                } else if (typeof val === 'number') {
                                    cls = 'font-mono text-gray-600';
                                } else if (typeof val === 'string' && val.includes('@') && col.toLowerCase().includes('email')) {
                                    content = \`<a href="mailto:\${val}" class="text-slate-600 hover:underline">\${val}</a>\`;
                                } else if (typeof val === 'string' && val.length > 50) {
                                    content = val.substring(0, 50) + '...';
                                    cls = 'text-xs text-gray-500';
                                }

                                return \`<td class="px-6 py-3 whitespace-nowrap \${cls}">\${content}</td>\`;
                            }).join('')}
                        </tr>
                    \`).join('');
                }

                // --- 5. Filtering & Sorting (Client Side) ---
                function handleSort(event, col) {
                    const isShift = event.shiftKey;
                    const existingIndex = sortConfig.findIndex(s => s.col === col);

                    if (isShift) {
                        if (existingIndex !== -1) {
                            if (sortConfig[existingIndex].dir === 'asc') sortConfig[existingIndex].dir = 'desc';
                            else sortConfig.splice(existingIndex, 1);
                        } else {
                            sortConfig.push({ col: col, dir: 'asc' });
                        }
                    } else {
                        if (existingIndex !== -1 && sortConfig.length === 1) {
                            // Cycle through: asc -> desc -> remove
                            if (sortConfig[0].dir === 'asc') {
                                sortConfig[0].dir = 'desc';
                            } else {
                                sortConfig = []; // Remove sort on third click
                            }
                        } else {
                            sortConfig = [{ col: col, dir: 'asc' }];
                        }
                    }
                    processData();
                }

                function processData() {
                    // 1. Filter
                    let temp = allData.filter(row => {
                        // Global search
                        if (state.globalSearch) {
                            const term = state.globalSearch.toLowerCase();
                            const matches = Object.values(row).some(val => String(val).toLowerCase().includes(term));
                            if (!matches) return false;
                        }

                        // Column filters
                        for (const [col, filter] of Object.entries(state.columnFilters)) {
                            let val = row[col];
                            const fVal = filter.value;
                            const fVal2 = filter.value2;
                            const op = filter.op;

                            if (val === null || val === undefined) return false;

                            // Number logic
                            if (typeof val === 'number') {
                                const nVal = Number(val);
                                const nFVal = Number(fVal);
                                const nFVal2 = Number(fVal2);
                                if (op === '=') { if (nVal !== nFVal) return false; }
                                else if (op === '!=') { if (nVal === nFVal) return false; }
                                else if (op === '>') { if (nVal <= nFVal) return false; }
                                else if (op === '<') { if (nVal >= nFVal) return false; }
                                else if (op === '>=') { if (nVal < nFVal) return false; }
                                else if (op === '<=') { if (nVal > nFVal) return false; }
                                else if (op === 'range') { if (nVal < nFVal || nVal > nFVal2) return false; }
                            }
                            // Date logic (String based)
                            else if (!isNaN(Date.parse(val)) && typeof val === 'string' && val.includes('-')) {
                                if (op === '=') { if (val !== fVal) return false; }
                                else if (op === '!=') { if (val === fVal) return false; }
                                else if (op === '>') { if (val <= fVal) return false; }
                                else if (op === '<') { if (val >= fVal) return false; }
                                else if (op === '>=') { if (val < fVal) return false; }
                                else if (op === '<=') { if (val > fVal) return false; }
                                else if (op === 'range') { if (val < fVal || val > fVal2) return false; }
                            }
                            // String/Bool Logic
                            else {
                                const sVal = String(val).toLowerCase();
                                const sFVal = String(fVal).toLowerCase();

                                if (op === 'contains') { if (!sVal.includes(sFVal)) return false; }
                                else if (op === 'not_contains') { if (sVal.includes(sFVal)) return false; }
                                else if (op === '=') { if (sVal !== sFVal) return false; }
                                else if (op === '!=') { if (sVal === sFVal) return false; }
                                else if (op === 'starts_with') { if (!sVal.startsWith(sFVal)) return false; }
                                else if (op === 'ends_with') { if (!sVal.endsWith(sFVal)) return false; }
                                else if (op === 'regex') {
                                    try {
                                        const regex = new RegExp(filter.value, 'i');
                                        if (!regex.test(String(val))) return false;
                                    } catch (e) { return true; } // Ignore invalid regex
                                }
                            }
                        }
                        return true;
                    });

                    // 2. Sort
                    if (sortConfig.length > 0) {
                        temp.sort((a, b) => {
                            for (const sort of sortConfig) {
                                const valA = a[sort.col];
                                const valB = b[sort.col];
                                if (valA < valB) return sort.dir === 'asc' ? -1 : 1;
                                if (valA > valB) return sort.dir === 'asc' ? 1 : -1;
                            }
                            return 0;
                        });
                    }

                    filteredData = temp;
                    state.currentPage = 1;
                    updateUI();
                }

                // --- 6. UI Helpers ---
                let currentFilterCol = null;

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

                    renderFilterUI(col);
                    popover.classList.remove('hidden');

                    const input = document.getElementById('filterVal');
                    if (input) setTimeout(() => input.focus(), 50);
                }

                function renderFilterUI(col) {
                    const sampleVal = allData.length > 0 ? allData[0][col] : null;
                    const type = typeof sampleVal;
                    const container = document.getElementById('filterContent');
                    const current = state.columnFilters[col] || { op: '', value: '', value2: '' };
                    const isEnum = columnStats[col] && columnStats[col].isEnum;

                    document.getElementById('filterTitle').textContent = \`Filter \${col.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}\`;

                    let html = '';
                    let datalist = '';

                    // Autocomplete Datalist
                    const uniqueVals = Array.from(new Set(allData.map(d => d[col]))).slice(0, 50);
                    datalist = \`<datalist id="autoComplete_\${col}">\${uniqueVals.map(v => \`<option value="\${v}">\`).join('')}</datalist>\`;

                    if (type === 'number') {
                        html = \`
                            <select id="filterOp" class="w-full mb-2 border rounded p-2 text-sm bg-gray-700 border-gray-600 text-gray-100 focus:ring-gray-500 focus:border-gray-500" onchange="toggleRangeInput(this.value)">
                                <option value="=" \${current.op === '=' ? 'selected' : ''}>Equals (=)</option>
                                <option value="!=" \${current.op === '!=' ? 'selected' : ''}>Not Equals (!=)</option>
                                <option value=">" \${current.op === '>' ? 'selected' : ''}>Greater Than (>)</option>
                                <option value="<" \${current.op === '<' ? 'selected' : ''}>Less Than (<)</option>
                                <option value=">=" \${current.op === '>=' ? 'selected' : ''}>Greater or Equal (>=)</option>
                                <option value="<=" \${current.op === '<=' ? 'selected' : ''}>Less or Equal (<=)</option>
                                <option value="range" \${current.op === 'range' ? 'selected' : ''}>Range (Between)</option>
                            </select>
                            <input type="number" id="filterVal" value="\${current.value}" class="w-full border rounded p-2 text-sm mb-2 bg-gray-700 border-gray-600 text-gray-100" placeholder="Value...">
                            <input type="number" id="filterVal2" value="\${current.value2}" class="w-full border rounded p-2 text-sm bg-gray-700 border-gray-600 text-gray-100 \${current.op === 'range' ? '' : 'hidden'}" placeholder="To Value...">
                        \`;
                    } else if (type === 'boolean') {
                        html = \`
                            <select id="filterOp" class="hidden"><option value="=">Equals</option></select>
                            <select id="filterVal" class="w-full border rounded p-2 text-sm bg-gray-700 border-gray-600 text-gray-100">
                                <option value="true" \${String(current.value) === 'true' ? 'selected' : ''}>TRUE</option>
                                <option value="false" \${String(current.value) === 'false' ? 'selected' : ''}>FALSE</option>
                            </select>
                        \`;
                    } else {
                        // String / Date logic
                        const isDate = !isNaN(Date.parse(sampleVal)) && String(sampleVal).includes('-');

                        if (isDate) {
                            html = \`
                                <select id="filterOp" class="w-full mb-2 border rounded p-2 text-sm bg-gray-700 border-gray-600 text-gray-100" onchange="toggleRangeInput(this.value)">
                                    <option value="=" \${current.op === '=' ? 'selected' : ''}>Equals Date</option>
                                    <option value="!=" \${current.op === '!=' ? 'selected' : ''}>Not Date</option>
                                    <option value=">" \${current.op === '>' ? 'selected' : ''}>After</option>
                                    <option value="<" \${current.op === '<' ? 'selected' : ''}>Before</option>
                                    <option value=">=" \${current.op === '>=' ? 'selected' : ''}>On or After</option>
                                    <option value="<=" \${current.op === '<=' ? 'selected' : ''}>On or Before</option>
                                    <option value="range" \${current.op === 'range' ? 'selected' : ''}>Between Dates</option>
                                </select>
                                <input type="date" id="filterVal" value="\${current.value}" class="w-full border rounded p-2 text-sm bg-gray-700 border-gray-600 text-gray-100 mb-2">
                                <input type="date" id="filterVal2" value="\${current.value2}" class="w-full border rounded p-2 text-sm bg-gray-700 border-gray-600 text-gray-100 \${current.op === 'range' ? '' : 'hidden'}">
                            \`;
                        } else {
                            html = \`
                                <select id="filterOp" class="w-full mb-2 border rounded p-2 text-sm bg-gray-700 border-gray-600 text-gray-100">
                                    <option value="contains" \${current.op === 'contains' ? 'selected' : ''}>Contains</option>
                                    <option value="not_contains" \${current.op === 'not_contains' ? 'selected' : ''}>Does Not Contain</option>
                                    <option value="=" \${current.op === '=' ? 'selected' : ''}>Equals</option>
                                    <option value="!=" \${current.op === '!=' ? 'selected' : ''}>Not Equals</option>
                                    <option value="starts_with" \${current.op === 'starts_with' ? 'selected' : ''}>Starts With</option>
                                    <option value="ends_with" \${current.op === 'ends_with' ? 'selected' : ''}>Ends With</option>
                                    <option value="regex" \${current.op === 'regex' ? 'selected' : ''}>Regex Match</option>
                                </select>
                                \${datalist}
                                <input type="text" id="filterVal" list="autoComplete_\${col}" value="\${current.value}" class="w-full border rounded p-2 text-sm bg-gray-700 border-gray-600 text-gray-100" placeholder="Value..." autofocus>
                                <div class="text-xs text-gray-400 mt-1 italic \${current.op === 'regex' ? '' : 'hidden'}" id="regexHint">Example: ^[A-Z].*</div>
                            \`;
                        }
                    }
                    container.innerHTML = html;
                }

                function toggleRangeInput(op) {
                    const v2 = document.getElementById('filterVal2');
                    if (v2) {
                        if (op === 'range') v2.classList.remove('hidden');
                        else v2.classList.add('hidden');
                    }
                    const hint = document.getElementById('regexHint');
                    if (hint) {
                        const opSelect = document.getElementById('filterOp');
                        if (opSelect && opSelect.value === 'regex') hint.classList.remove('hidden');
                        else hint.classList.add('hidden');
                    }
                }

                function applyCurrentFilter() {
                    const op = document.getElementById('filterOp').value;
                    const val = document.getElementById('filterVal').value;
                    const val2Element = document.getElementById('filterVal2');
                    const val2 = val2Element ? val2Element.value : '';

                    if (val === '') {
                        delete state.columnFilters[currentFilterCol];
                    } else {
                        state.columnFilters[currentFilterCol] = { op, value: val, value2: val2 };
                    }
                    closeFilterPopover();
                    processData();
                }

                function clearCurrentFilter() {
                    delete state.columnFilters[currentFilterCol];
                    closeFilterPopover();
                    processData();
                }
                
                function closeFilterPopover() { document.getElementById('filterPopover').classList.add('hidden'); }
                function clearAllFilters() { state.columnFilters = {}; document.getElementById('globalSearch').value = ''; state.globalSearch = ''; processData(); }

                // Drag & Drop Cols
                function handleDragStart(e, col) { draggedColumn = col; e.target.classList.add('dragging'); }
                function handleDragOver(e, col) {
                    e.preventDefault();
                    if (draggedColumn === col) return;
                    const th = e.currentTarget;
                    const rect = th.getBoundingClientRect();
                    th.classList.remove('drag-over-left', 'drag-over-right');
                    if (e.clientX < rect.left + rect.width / 2) th.classList.add('drag-over-left'); else th.classList.add('drag-over-right');
                }
                function handleDragLeave(e) { e.currentTarget.classList.remove('drag-over-left', 'drag-over-right'); }
                function handleDrop(e, targetCol) {
                    e.preventDefault();
                    e.currentTarget.classList.remove('drag-over-left', 'drag-over-right');
                    document.querySelectorAll('th').forEach(th => th.classList.remove('dragging'));
                    if (draggedColumn && draggedColumn !== targetCol) {
                        const oldIdx = visibleColumns.indexOf(draggedColumn);
                        visibleColumns.splice(oldIdx, 1);
                        const rect = e.currentTarget.getBoundingClientRect();
                        const newIdx = (e.clientX < rect.left + rect.width / 2) ? visibleColumns.indexOf(targetCol) : visibleColumns.indexOf(targetCol) + 1;
                        visibleColumns.splice(newIdx, 0, draggedColumn);
                        initTable();
                    }
                }

                // Standard UI Utils
                function updateUI() { renderHeader(); renderBody(); renderPagination(); updateTotalCount(); 
                     const badge = document.getElementById('filterBadge');
                     Object.keys(state.columnFilters).length > 0 ? badge.classList.remove('hidden') : badge.classList.add('hidden');
                }
                function updateTotalCount() { document.getElementById('totalRecords').textContent = \`\${filteredData.length} Records\`; }
                function renderPagination() {
                    const totalPages = Math.ceil(filteredData.length / state.rowsPerPage) || 1;
                    document.getElementById('pageInfo').textContent = \`Page \${state.currentPage} of \${totalPages}\`;
                    document.getElementById('btnPrev').disabled = state.currentPage === 1;
                    document.getElementById('btnNext').disabled = state.currentPage === totalPages;
                }
                function nextPage() { if (state.currentPage < Math.ceil(filteredData.length / state.rowsPerPage)) { state.currentPage++; updateUI(); } }
                function prevPage() { if (state.currentPage > 1) { state.currentPage--; updateUI(); } }
                function changeRowsPerPage(val) { state.rowsPerPage = parseInt(val); state.currentPage = 1; updateUI(); }
                
                function toggleQueryPanel() { document.getElementById('queryPanel').classList.toggle('hidden'); }
                function toggleColumnManager() { 
                    const el = document.getElementById('columnManager');
                    el.classList.toggle('hidden');
                    if(!el.classList.contains('hidden')) {
                         document.getElementById('columnList').innerHTML = columns.map(col => \`
                            <label class="flex items-center space-x-2 p-1.5 hover:bg-gray-700 rounded cursor-pointer">
                                <input type="checkbox" onchange="toggleColumn('\${col}')" \${visibleColumns.includes(col) ? 'checked' : ''} class="rounded text-slate-600 bg-gray-700 border-gray-600">
                                <span class="text-gray-300">\${col.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</span>
                            </label>
                        \`).join('');
                    }
                }
                function resetView() { visibleColumns = [...columns]; clearAllFilters(); sortConfig = []; initTable(); }
                function exportData() {
                    if(filteredData.length === 0) { alert("No data to export"); return; }
                    const header = visibleColumns.join(",");
                    const rows = filteredData.map(row => visibleColumns.map(col => \`"\${String(row[col]||'').replace(/"/g, '""')}"\`).join(",")).join("\\n");
                    const blob = new Blob([header + "\\n" + rows], { type: "text/csv" });
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.setAttribute("href", url);
                    a.setAttribute("download", "export.csv");
                    a.click();
                }

                // Global Search
                document.getElementById('globalSearch').addEventListener('input', (e) => { state.globalSearch = e.target.value; processData(); });

                // Query Panel Functions
                function setQueryMode(mode) {
                    const sqlBtn = document.getElementById('modeSql');
                    const aiBtn = document.getElementById('modeAi');
                    const input = document.getElementById('queryInput');

                    if (mode === 'sql') {
                        sqlBtn.classList.add('bg-white', 'text-gray-900', 'shadow-sm');
                        sqlBtn.classList.remove('text-gray-500');
                        aiBtn.classList.remove('bg-white', 'text-gray-900', 'shadow-sm');
                        aiBtn.classList.add('text-gray-500');
                        input.placeholder = "SELECT * FROM...";
                        document.getElementById('sampleQueriesContainer').classList.remove('hidden');
                    } else {
                        aiBtn.classList.add('bg-white', 'text-gray-900', 'shadow-sm');
                        aiBtn.classList.remove('text-gray-500');
                        sqlBtn.classList.remove('bg-white', 'text-gray-900', 'shadow-sm');
                        sqlBtn.classList.add('text-gray-500');
                        input.placeholder = "Ask in plain English (e.g. 'Show me all active records')...";
                        document.getElementById('sampleQueriesContainer').classList.add('hidden');
                    }
                }

                function loadSampleQuery(val) {
                    if (val) {
                        document.getElementById('queryInput').value = val;
                    }
                }

                function clearQuery() {
                    document.getElementById('queryInput').value = '';
                    document.getElementById('queryStatus').classList.add('hidden');
                }

                function executeCustomQuery() {
                    const sql = document.getElementById('queryInput').value;
                    if(!sql.trim()) return;
                    
                    const status = document.getElementById('queryStatus');
                    status.innerHTML = \`<span class="inline-flex items-center gap-1 text-gray-500"><span class="material-symbols-outlined text-sm animate-spin">refresh</span> Executing...</span>\`;
                    status.classList.remove('hidden');

                    vscode.postMessage({
                        command: 'executeQuery',
                        query: sql
                    });
                }

                // Close popovers on click outside
                document.addEventListener('click', (e) => {
                    if (!document.getElementById('filterPopover').classList.contains('hidden') && !e.target.closest('#filterPopover') && !e.target.closest('th button')) {
                        document.getElementById('filterPopover').classList.add('hidden');
                    }
                    if (!document.getElementById('columnManager').classList.contains('hidden') && !e.target.closest('#columnManager') && !e.target.closest('button[onclick*="toggleColumnManager"]')) {
                        document.getElementById('columnManager').classList.add('hidden');
                    }
                });

                // Message handling from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'pageData') {
                        allData = Array.isArray(message.data) ? message.data : [];
                        filteredData = [...allData];
                        if (typeof message.totalRows === 'number') {
                            totalRows = message.totalRows;
                        }
                        const nextPage = Number(message.page);
                        if (Number.isFinite(nextPage) && nextPage > 0) {
                            state.currentPage = Math.floor(nextPage);
                        }
                        const nextPageSize = Number(message.pageSize);
                        if (Number.isFinite(nextPageSize) && nextPageSize > 0) {
                            state.rowsPerPage = Math.floor(nextPageSize);
                        }
                        analyzeColumns();
                        processData();
                    } else if (message.command === 'pageError') {
                        console.error(message.error || 'Failed to load page');
                    } else if (message.command === 'queryResult') {
                        const status = document.getElementById('queryStatus');
                        status.innerHTML = \`<span class="inline-flex items-center gap-1 text-green-600"><span class="material-symbols-outlined text-sm">check_circle</span> Query returned \${message.rowCount} rows.</span>\`;
                        
                        // Update table with query results
                        allData = Array.isArray(message.data) ? message.data : [];
                        filteredData = [...allData];
                        totalRows = message.rowCount || allData.length;
                        columns = allData.length > 0 ? Object.keys(allData[0]) : [];
                        visibleColumns = [...columns];
                        
                        analyzeColumns();
                        initTable();
                        updateTotalCount();
                        renderPagination();
                    } else if (message.command === 'queryError') {
                        const status = document.getElementById('queryStatus');
                        status.innerHTML = \`<span class="text-red-600 font-medium">Error: \${message.error}</span>\`;
                    } else if (message.command === 'aiQueryResult') {
                        document.getElementById('queryInput').value = message.sqlQuery;
                        setQueryMode('sql');
                        const status = document.getElementById('queryStatus');
                        status.innerHTML = \`<span class="inline-flex items-center gap-1 text-green-600"><span class="material-symbols-outlined text-sm">check_circle</span> SQL query generated.</span>\`;
                    } else if (message.command === 'aiQueryError') {
                        const status = document.getElementById('queryStatus');
                        status.innerHTML = \`<span class="text-red-600 font-medium">AI Error: \${message.error}</span>\`;
                    }
                });

                // Initialize
                analyzeColumns();
                initTable();
                updateTotalCount();
                renderPagination();
            </script>
        </body>
        </html>\`;
        </html>
`;
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

    constructor(private explorer: DatabaseExplorer) {}

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: DatabaseTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
        if (!element) {
            return this.explorer.connections.map(connection => 
                new DatabaseTreeItem(connection, connection.name, vscode.TreeItemCollapsibleState.Expanded, 'connection')
            );
        } else if (element.contextValue === 'connection') {
            // Fetch record counts for all tables
            const tableCountPromises = element.connection.tables.map(async (table: string) => {
                let count = 0;
                try {
                    if (element.connection.type === 'sqlite') {
                        count = await this.explorer.sqliteManager.getTableRowCount(element.connection.path, table);
                    } else {
                        count = await this.explorer.mongoManager.getCollectionCount(element.connection.path, table);
                    }
                } catch (error) {
                    // If count fails, use 0
                    count = 0;
                }
                return { table, count };
            });

            const tableCounts = await Promise.all(tableCountPromises);
            
            const items = tableCounts.map(({ table, count }) =>
                new DatabaseTreeItem(element.connection, table, vscode.TreeItemCollapsibleState.None, 'table', count)
            );

            return items;
        }
        return [];
    }
}
