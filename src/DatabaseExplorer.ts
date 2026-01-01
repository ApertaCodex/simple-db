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
            { label: 'Select All Records', query: `SELECT * FROM ${tableName} LIMIT 100` },
            { label: 'Count Records', query: `SELECT COUNT(*) as total FROM ${tableName}` },
            { label: 'Select First 10', query: `SELECT * FROM ${tableName} LIMIT 10` },
            { label: 'Select Distinct Values', query: `SELECT DISTINCT * FROM ${tableName}` },
            { label: 'Delete All Records', query: `DELETE FROM ${tableName}` },
            { label: 'Drop Table', query: `DROP TABLE ${tableName}` }
        ] : [
            { label: 'Find All Documents', query: `db.${tableName}.find({})` },
            { label: 'Count Documents', query: `db.${tableName}.countDocuments({})` },
            { label: 'Find First 10', query: `db.${tableName}.find({}).limit(10)` },
            { label: 'Delete All Documents', query: `db.${tableName}.deleteMany({})` },
            { label: 'Drop Collection', query: `db.${tableName}.drop()` }
        ];

        const sampleOptions = sampleQueries.map((sq, idx) =>
            `<option value="${idx}">${sq.label}</option>`
        ).join('');

        const queriesJson = JSON.stringify(sampleQueries.map(sq => sq.query));
        
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>${tableName}</title>
            <script>
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
            </script>
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
                }

                * {
                    box-sizing: border-box;
                }

                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    margin: 0;
                    padding: 20px;
                    background-color: var(--bg-primary);
                    color: var(--text-primary);
                    font-size: 13px;
                    line-height: 1.4;
                }

                h2 {
                    color: var(--text-primary);
                    font-weight: 400;
                    margin-bottom: 20px;
                    font-size: 18px;
                }

                .search {
                    margin-bottom: 20px;
                    position: relative;
                }

                .search input {
                    width: 100%;
                    max-width: 400px;
                    padding: 8px 12px 8px 36px;
                    background-color: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: 4px;
                    color: var(--text-primary);
                    font-size: 13px;
                    outline: none;
                    transition: border-color 0.2s;
                }

                .search-icon {
                    position: absolute;
                    left: 12px;
                    top: 50%;
                    transform: translateY(-50%);
                    color: var(--text-secondary);
                    pointer-events: none;
                    z-index: 1;
                }

                .search input:focus {
                    border-color: var(--accent);
                }

                .search input::placeholder {
                    color: var(--text-secondary);
                }

                .toolbar {
                    display: flex;
                    gap: 8px;
                    margin-bottom: 16px;
                    flex-wrap: wrap;
                }

                .toolbar-btn {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 8px 12px;
                    background-color: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: 4px;
                    color: var(--text-primary);
                    font-size: 12px;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .toolbar-btn:hover {
                    background-color: var(--bg-tertiary);
                    border-color: var(--accent);
                }

                .toolbar-btn svg {
                    width: 16px;
                    height: 16px;
                }

                .pagination-controls {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 16px;
                    padding: 12px 0;
                    border-top: 1px solid var(--border-color);
                    border-bottom: 1px solid var(--border-color);
                }

                .pagination-info {
                    color: var(--text-secondary);
                    font-size: 12px;
                }

                .pagination-buttons {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .pagination-buttons select {
                    background-color: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    color: var(--text-primary);
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 12px;
                }

                .pagination-buttons button {
                    background-color: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    color: var(--text-primary);
                    padding: 6px 12px;
                    border-radius: 4px;
                    font-size: 12px;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .pagination-buttons button:hover:not(:disabled) {
                    background-color: var(--bg-tertiary);
                    border-color: var(--accent);
                }

                .pagination-buttons button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                /* Popover Styles */
                .popover {
                    position: fixed;
                    background-color: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: 6px;
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
                    z-index: 1000;
                    min-width: 240px;
                    max-width: 320px;
                }

                .popover-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 12px 16px;
                    border-bottom: 1px solid var(--border-color);
                    background-color: var(--bg-tertiary);
                    border-radius: 6px 6px 0 0;
                }

                .popover-title {
                    font-size: 11px;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    color: var(--accent);
                }

                .popover-close {
                    background: none;
                    border: none;
                    color: var(--text-secondary);
                    font-size: 18px;
                    cursor: pointer;
                    padding: 0;
                    width: 24px;
                    height: 24px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 4px;
                    transition: all 0.2s;
                }

                .popover-close:hover {
                    background-color: var(--bg-tertiary);
                    color: var(--text-primary);
                }

                .popover-content {
                    padding: 16px;
                    max-height: 300px;
                    overflow-y: auto;
                }

                .popover-footer {
                    padding: 12px 16px;
                    border-top: 1px solid var(--border-color);
                    background-color: var(--bg-tertiary);
                    border-radius: 0 0 6px 6px;
                    display: flex;
                    gap: 8px;
                    justify-content: flex-end;
                }

                .popover-btn {
                    padding: 6px 12px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s;
                    border: 1px solid transparent;
                }

                .popover-btn.primary {
                    background-color: var(--accent);
                    color: white;
                    border-color: var(--accent);
                }

                .popover-btn.primary:hover {
                    background-color: var(--accent-hover);
                    border-color: var(--accent-hover);
                }

                .popover-btn.secondary {
                    background-color: var(--bg-tertiary);
                    color: var(--text-primary);
                    border-color: var(--border-color);
                }

                .popover-btn.secondary:hover {
                    background-color: var(--row-hover);
                    border-color: var(--accent);
                }

                .column-list {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }

                .column-item {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 8px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                    transition: background-color 0.2s;
                }

                .column-item:hover {
                    background-color: var(--row-hover);
                }

                .column-item.dragging {
                    opacity: 0.5;
                    background-color: var(--accent);
                }

                .drag-handle {
                    cursor: grab;
                    color: var(--text-secondary);
                    font-size: 14px;
                }

                .drag-handle:active {
                    cursor: grabbing;
                }

                /* Filter Controls */
                .filter-label {
                    display: block;
                    font-size: 10px;
                    color: var(--text-secondary);
                    margin-bottom: 4px;
                    text-transform: uppercase;
                    font-weight: 600;
                    letter-spacing: 0.5px;
                }

                .filter-input {
                    width: 100%;
                    background-color: var(--input-bg);
                    border: 1px solid var(--border-color);
                    color: var(--text-primary);
                    padding: 6px 8px;
                    border-radius: 4px;
                    font-size: 12px;
                    outline: none;
                    transition: border-color 0.2s;
                }

                .filter-input:focus {
                    border-color: var(--accent);
                }

                .filter-select {
                    width: 100%;
                    background-color: var(--input-bg);
                    border: 1px solid var(--border-color);
                    color: var(--text-primary);
                    padding: 6px 8px;
                    border-radius: 4px;
                    font-size: 12px;
                    outline: none;
                    transition: border-color 0.2s;
                    margin-bottom: 8px;
                }

                .filter-select:focus {
                    border-color: var(--accent);
                }

                .column-controls {
                    display: flex;
                    gap: 2px;
                    margin-left: auto;
                }

                .column-controls button {
                    padding: 2px 4px;
                    background-color: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    color: var(--text-secondary);
                    border-radius: 2px;
                    font-size: 10px;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .column-controls button:hover {
                    background-color: var(--row-hover);
                    color: var(--text-primary);
                }

                .table-container {
                    background-color: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: 4px;
                    overflow: auto;
                    max-height: 70vh;
                    min-height: 500px;
                }

                table {
                    border-collapse: collapse;
                    min-width: 100%;
                    font-size: 12px;
                }

                th, td {
                    padding: 12px 16px;
                    text-align: left;
                    border-bottom: 1px solid var(--border-color);
                    vertical-align: top;
                }

                th {
                    background-color: var(--header-bg);
                    color: var(--text-primary);
                    font-weight: 600;
                    font-size: 14px;
                    cursor: pointer;
                    user-select: none;
                    position: sticky;
                    top: 0;
                    z-index: 10;
                    transition: background-color 0.2s;
                    position: relative;
                    padding-bottom: 0;
                    white-space: nowrap;
                    height: 44px;
                }

                td {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 300px;
                }

                .column-filter {
                    position: absolute;
                    top: 100%;
                    left: 0;
                    right: 0;
                    background-color: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-top: none;
                    z-index: 20;
                    display: none;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
                    min-width: 200px;
                }

                .filter-input-container {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    padding: 8px;
                }

                .filter-operator-select {
                    width: 100%;
                    background-color: var(--bg-primary);
                    border: 1px solid var(--border-color);
                    color: var(--text-primary);
                    padding: 4px 6px;
                    border-radius: 3px;
                    font-size: 11px;
                    outline: none;
                    margin-bottom: 4px;
                }

                .filter-operator-select:focus {
                    border-color: var(--accent);
                }

                .filter-value-container {
                    display: flex;
                    gap: 4px;
                    align-items: center;
                }

                .filter-text-input,
                .filter-number-input,
                .filter-date-input {
                    flex: 1;
                    padding: 4px 6px;
                    background-color: var(--bg-primary);
                    border: 1px solid var(--border-color);
                    border-radius: 3px;
                    color: var(--text-primary);
                    font-size: 11px;
                    outline: none;
                }

                .filter-text-input:focus,
                .filter-number-input:focus,
                .filter-date-input:focus {
                    background-color: var(--bg-tertiary);
                    border-color: var(--accent);
                }

                .filter-number-second,
                .filter-date-second {
                    display: none;
                }

                .filter-date-input[type="date"]::-webkit-calendar-picker-indicator {
                    filter: invert(1);
                    cursor: pointer;
                }

                .filter-date-input[type="date"]::-webkit-calendar-picker-indicator:hover {
                    filter: invert(0.8);
                }

                .column-filter input {
                    flex: 1;
                    padding: 6px 8px;
                    background-color: var(--bg-primary);
                    border: 1px solid var(--border-color);
                    border-radius: 3px;
                    color: var(--text-primary);
                    font-size: 11px;
                    outline: none;
                }

                .column-filter input[type="date"] {
                    padding: 4px 8px;
                }

                .column-filter input:focus {
                    background-color: var(--bg-tertiary);
                    border-color: var(--accent);
                }

                .filter-btn {
                    padding: 6px 10px;
                    background-color: var(--accent);
                    border: none;
                    border-radius: 3px;
                    color: white;
                    cursor: pointer;
                    font-size: 14px;
                    transition: background-color 0.2s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    min-width: 32px;
                }

                .filter-btn:hover {
                    background-color: var(--accent-hover);
                }

                .filter-btn:active {
                    transform: scale(0.98);
                }

                .filter-btn::before {
                    content: '🔍';
                }

                .filter-help {
                    padding: 4px 8px;
                    font-size: 10px;
                    color: var(--text-secondary);
                    background-color: var(--bg-tertiary);
                    border-top: 1px solid var(--border-color);
                }

                th.filter-active {
                    background-color: var(--accent);
                }

                .filter-icon {
                    margin-left: 8px;
                    opacity: 0.5;
                    font-size: 14px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                    cursor: pointer;
                    color: var(--text-secondary);
                    vertical-align: middle;
                    line-height: 1;
                    width: 16px;
                    height: 16px;
                    position: relative;
                }

                .filter-icon::before {
                    content: '';
                    position: absolute;
                    width: 10px;
                    height: 10px;
                    border: 1.5px solid currentColor;
                    border-radius: 50%;
                    top: 0;
                    left: 0;
                }

                .filter-icon::after {
                    content: '';
                    position: absolute;
                    width: 4px;
                    height: 4px;
                    border-right: 1.5px solid currentColor;
                    border-bottom: 1.5px solid currentColor;
                    transform: rotate(45deg);
                    bottom: 1px;
                    right: 1px;
                }

                th:hover .filter-icon {
                    opacity: 0.8;
                    color: var(--accent);
                }

                th.filter-active .filter-icon {
                    opacity: 1;
                    color: var(--accent);
                }

                .filter-icon:hover {
                    opacity: 1 !important;
                    transform: scale(1.15);
                    color: var(--accent);
                }

                .header-search-icon {
                    margin-left: 4px;
                    color: var(--text-secondary);
                    opacity: 0.5;
                    transition: all 0.2s;
                    cursor: pointer;
                }

                .header-search-icon:hover {
                    opacity: 0.8;
                    color: var(--accent);
                }

                th:hover .header-search-icon {
                    opacity: 0.8;
                    color: var(--accent);
                }

                th:hover {
                    background-color: var(--bg-tertiary);
                }

                th.sort-asc {
                    background-color: var(--accent);
                    color: white;
                }

                th.sort-desc {
                    background-color: var(--accent);
                    color: white;
                }

                .sort-indicator {
                    margin-left: 8px;
                    display: inline-flex;
                    align-items: center;
                    gap: 2px;
                }

                .sort-indicator svg {
                    width: 16px;
                    height: 16px;
                    color: var(--accent);
                    opacity: 0.8;
                }

                .sort-priority {
                    font-size: 10px;
                    font-weight: bold;
                    color: var(--accent);
                    background-color: rgba(0, 122, 204, 0.1);
                    border-radius: 50%;
                    width: 14px;
                    height: 14px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    line-height: 1;
                }

                th.sort-asc .sort-indicator svg,
                th.sort-desc .sort-indicator svg {
                    color: white;
                    opacity: 1;
                }

                th.sort-asc .sort-priority,
                th.sort-desc .sort-priority {
                    background-color: rgba(255, 255, 255, 0.2);
                    color: white;
                }

                th:first-child,
                td:first-child {
                    padding-left: 16px;
                }

                th:last-child,
                td:last-child {
                    padding-right: 16px;
                }

                tr:hover td {
                    background-color: var(--row-hover);
                }

                td {
                    color: var(--text-primary);
                    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                    font-size: 11px;
                }

                td.number {
                    text-align: right;
                    font-weight: 500;
                }

                td.string {
                    color: #ce9178;
                }

                td.boolean {
                    color: #569cd6;
                    font-weight: 600;
                }

                td.null {
                    color: var(--text-secondary);
                    font-style: italic;
                }

                .pagination {
                    margin-top: 20px;
                    display: flex;
                    align-items: center;
                    gap: 16px;
                    padding: 12px 0;
                }

                .pagination button {
                    background-color: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    color: var(--text-primary);
                    padding: 6px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    transition: all 0.2s;
                }

                .pagination button:hover:not(:disabled) {
                    background-color: var(--accent);
                    border-color: var(--accent);
                }

                .pagination button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                #pageInfo {
                    color: var(--text-secondary);
                    font-size: 12px;
                }

                .stats {
                    margin-bottom: 16px;
                    color: var(--text-secondary);
                    font-size: 12px;
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

                .hidden {
                    display: none !important;
                }

                .empty-state {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 60px 20px;
                    text-align: center;
                    color: var(--text-secondary);
                    min-height: 400px;
                }

                .empty-state-icon {
                    font-size: 48px;
                    margin-bottom: 16px;
                    opacity: 0.5;
                }

                .empty-state-title {
                    font-size: 16px;
                    font-weight: 600;
                    margin-bottom: 8px;
                    color: var(--text-primary);
                }

                .empty-state-message {
                    font-size: 13px;
                    line-height: 1.4;
                    max-width: 400px;
                }

                .records-found {
                    background-color: rgba(76, 175, 80, 0.1);
                    color: #4caf50;
                    padding: 8px 12px;
                    border-radius: 4px;
                    font-size: 12px;
                    margin-bottom: 8px;
                    border-left: 3px solid #4caf50;
                }

                .query-section {
                    margin-bottom: 20px;
                    border: 1px solid var(--border-color);
                    border-radius: 4px;
                    overflow: hidden;
                }

                .query-header {
                    background-color: var(--bg-secondary);
                    padding: 10px 16px;
                    cursor: pointer;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    user-select: none;
                }

                .query-header:hover {
                    background-color: var(--accent-dim);
                }

                .query-content {
                    padding: 16px;
                    display: none;
                }

                .query-content.expanded {
                    display: block;
                }

                .query-row {
                    display: flex;
                    gap: 10px;
                    margin-bottom: 10px;
                    align-items: center;
                }

                .query-row label {
                    min-width: 120px;
                    color: var(--text-secondary);
                }

                .query-row select {
                    flex: 1;
                    padding: 6px 12px;
                    background-color: var(--bg-primary);
                    border: 1px solid var(--border-color);
                    color: var(--text-primary);
                    border-radius: 3px;
                }

                .query-textarea {
                    width: 100%;
                    min-height: 100px;
                    padding: 10px;
                    font-family: 'Courier New', monospace;
                    font-size: 13px;
                    background-color: var(--bg-primary);
                    color: var(--text-primary);
                    border: 1px solid var(--border-color);
                    border-radius: 3px;
                    resize: vertical;
                }

                .query-actions {
                    display: flex;
                    gap: 10px;
                    margin-top: 10px;
                }

                .query-btn {
                    padding: 8px 16px;
                    background-color: var(--accent);
                    color: var(--text-primary);
                    border: none;
                    border-radius: 3px;
                    cursor: pointer;
                }

                .query-btn:hover {
                    opacity: 0.8;
                }

                .query-results {
                    margin-top: 16px;
                    padding: 10px;
                    background-color: var(--bg-secondary);
                    border-radius: 3px;
                    max-height: 400px;
                    overflow: auto;
                }

                .query-results table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 12px;
                }

                .query-results th,
                .query-results td {
                    padding: 6px 8px;
                    border: 1px solid var(--border-color);
                    text-align: left;
                }

                .query-results th {
                    background-color: var(--accent-dim);
                    font-weight: 600;
                }

                .query-error {
                    color: #f48771;
                    background-color: rgba(244, 135, 113, 0.1);
                    padding: 10px;
                    border-radius: 3px;
                }

                .query-warning {
                    background-color: #856404;
                    color: #fff3cd;
                    padding: 10px;
                    border-radius: 3px;
                    margin-bottom: 10px;
                }

                .query-mode-toggle {
                    display: flex;
                    background-color: var(--bg-primary);
                    border: 1px solid var(--border-color);
                    border-radius: 4px;
                    overflow: hidden;
                }

                .mode-btn {
                    padding: 6px 12px;
                    background-color: transparent;
                    border: none;
                    color: var(--text-secondary);
                    cursor: pointer;
                    transition: all 0.2s;
                    font-size: 12px;
                }

                .mode-btn.active {
                    background-color: var(--accent);
                    color: var(--text-primary);
                }

                .mode-btn:hover:not(.active) {
                    background-color: var(--row-hover);
                    color: var(--text-primary);
                }

                .ai-prompt-examples {
                    flex: 1;
                    color: var(--text-secondary);
                    font-style: italic;
                    font-size: 11px;
                }
            </style>
        </head>
        <body>
            <h2>${tableName}</h2>

            <div class="query-section">
                <div class="query-header" onclick="toggleQuerySection()">
                    <span>📝 SQL Query Interface</span>
                    <span id="queryToggle">▶</span>
                </div>
                <div class="query-content" id="queryContent">
                    <div class="query-row">
                        <label>Mode:</label>
                        <div class="query-mode-toggle">
                            <button type="button" id="sqlModeBtn" class="mode-btn active" onclick="setQueryMode('sql')">SQL</button>
                            <button type="button" id="aiModeBtn" class="mode-btn" onclick="setQueryMode('ai')">🤖 AI</button>
                        </div>
                    </div>
                    <div class="query-row" id="sampleQueryRow">
                        <label>Sample Queries:</label>
                        <select id="sampleQuerySelect" onchange="loadDataGridSampleQuery()">
                            <option value="">-- Select a query --</option>
                            ${sampleOptions}
                        </select>
                    </div>
                    <div class="query-row" id="aiPromptRow" style="display: none;">
                        <label>AI Prompt:</label>
                        <div class="ai-prompt-examples">
                            <small>Examples: "Show me all users who registered last month", "Find the top 10 most expensive products", "Count orders by status"</small>
                        </div>
                    </div>
                    <textarea class="query-textarea" id="queryTextarea" placeholder="Enter your SQL query here..."></textarea>
                    <div class="query-actions">
                        <button class="query-btn" id="executeBtn" onclick="executeDataGridQuery()">Execute Query</button>
                        <button class="query-btn" id="generateBtn" onclick="generateAIQuery()" style="display: none;">Generate SQL</button>
                        <button class="query-btn" onclick="clearQueryResults()">Clear</button>
                    </div>
                    <div id="queryResults"></div>
                </div>
            </div>

            <div class="stats" id="stats">Showing ${data.length} of ${totalRows} rows</div>
            <div class="search">
                <svg class="search-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m21 21-4.34-4.34"/>
                    <circle cx="11" cy="11" r="8"/>
                </svg>
                <input type="text" id="searchInput" placeholder="Search..." onkeyup="filterTable()">
            </div>
            
            <div class="toolbar">
                <button class="toolbar-btn" onclick="openColumnManager(event)" title="Manage Columns">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 3h18v18H3zM9 9h6"/>
                        <path d="M9 15h6"/>
                    </svg>
                    Columns
                </button>
                <button class="toolbar-btn" onclick="clearAllFilters()" title="Clear All Filters">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M22 3H2l8 9.46V19l4 2 4-2V12.46L22 3z"/>
                        <path d="M6 12h12"/>
                    </svg>
                    Reset
                </button>
            </div>
            
            <div class="pagination-controls">
                <div class="pagination-info">
                    <span id="recordCount">Showing ${data.length} of ${totalRows} rows</span>
                </div>
                <div class="pagination-buttons">
                    <select id="rowsPerPage" onchange="changeRowsPerPage(this.value)">
                        <option value="10">10</option>
                        <option value="20" selected>20</option>
                        <option value="50">50</option>
                        <option value="100">100</option>
                    </select>
                    <button onclick="prevPage()" id="prevBtn" disabled>Previous</button>
                    <span id="pageInfo">1 / 1</span>
                    <button onclick="nextPage()" id="nextBtn" disabled>Next</button>
                </div>
            </div>
            <div class="table-container">
                <table id="dataTable">
                    <thead>
                        <tr>
                            ${columns.map((col, idx) => {
                                const firstValue = data.find(row => row[col] != null)?.[col];
                                const isNumber = typeof firstValue === 'number';
                                const isDate = typeof firstValue === 'string' && /^\d{4}-\d{2}-\d{2}/.test(firstValue);

                                let filterInput = '';
                                let helpText = '';

                                if (isDate) {
                                    filterInput = `<div class="filter-input-container">
                                        <select class="filter-operator-select" id="filter-operator-${idx}" onchange="updateFilterInput(${idx})">
                                            <option value="contains">Contains</option>
                                            <option value="=">=</option>
                                            <option value=">">After</option>
                                            <option value="<">Before</option>
                                            <option value=">=">On or After</option>
                                            <option value="<=">On or Before</option>
                                            <option value="range">Between</option>
                                        </select>
                                        <div class="filter-value-container">
                                            <input type="date" class="filter-date-input" id="filter-value-${idx}" 
                                                   onchange="submitColumnFilter(${idx})">
                                            <input type="date" class="filter-date-input filter-date-second" id="filter-value2-${idx}" 
                                                   style="display: none;" onchange="submitColumnFilter(${idx})">
                                        </div>
                                        <button class="filter-btn" onclick="submitColumnFilter(${idx})"></button>
                                    </div>`;
                                    helpText = '<div class="filter-help">Select operator and choose date(s)</div>';
                                } else if (isNumber) {
                                    filterInput = `<div class="filter-input-container">
                                        <select class="filter-operator-select" id="filter-operator-${idx}" onchange="updateFilterInput(${idx})">
                                            <option value="=">=</option>
                                            <option value=">">></option>
                                            <option value="<"><</option>
                                            <option value=">=">>=</option>
                                            <option value="<="><=</option>
                                            <option value="!=">!=</option>
                                            <option value="range">Range</option>
                                        </select>
                                        <div class="filter-value-container">
                                            <input type="number" class="filter-number-input" id="filter-value-${idx}" 
                                                   placeholder="Value" onkeypress="if(event.key==='Enter') submitColumnFilter(${idx})">
                                            <input type="number" class="filter-number-input filter-number-second" id="filter-value2-${idx}" 
                                                   placeholder="Max" style="display: none;" onkeypress="if(event.key==='Enter') submitColumnFilter(${idx})">
                                        </div>
                                        <button class="filter-btn" onclick="submitColumnFilter(${idx})"></button>
                                    </div>`;
                                    helpText = '<div class="filter-help">Select operator and enter value(s)</div>';
                                } else {
                                    filterInput = `<div class="filter-input-container">
                                        <select class="filter-operator-select" id="filter-operator-${idx}" onchange="updateFilterInput(${idx})">
                                            <option value="contains">Contains</option>
                                            <option value="=">=</option>
                                            <option value="!=">!=</option>
                                            <option value="starts">Starts with</option>
                                            <option value="ends">Ends with</option>
                                        </select>
                                        <div class="filter-value-container">
                                            <input type="text" class="filter-text-input" id="filter-value-${idx}" 
                                                   placeholder="Filter ${col}..." onkeypress="if(event.key==='Enter') submitColumnFilter(${idx})">
                                        </div>
                                        <button class="filter-btn" onclick="submitColumnFilter(${idx})"></button>
                                    </div>`;
                                    helpText = '<div class="filter-help">Select operator and enter text</div>';
                                }

                                return `
                                <th onclick="sortTable(${idx}, event)" oncontextmenu="event.preventDefault(); toggleColumnFilter(${idx})">
                                    <span style="display: flex; align-items: center; justify-content: space-between;">
                                        <span>${col}</span>
                                        <svg class="header-search-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" title="Click to filter this column" onclick="event.stopPropagation(); toggleColumnFilter(${idx})">
                                            <path d="m21 21-4.34-4.34"/>
                                            <circle cx="11" cy="11" r="8"/>
                                        </svg>
                                    </span>
                                    <div class="column-filter" id="filter-${idx}">
                                        ${filterInput}
                                        ${helpText}
                                    </div>
                                </th>
                            `;
                            }).join('')}
                        </tr>
                    </thead>
                    <tbody id="tableBody">
                        ${data.map(row => `
                            <tr>
                                ${columns.map(col => `<td class="${this.getCellClass(row[col])}">${this.formatCellValue(row[col])}</td>`).join('')}
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            <div class="pagination">
                <button onclick="previousPage()">Previous</button>
                <span id="pageInfo">Page 1 of 1</span>
                <button onclick="nextPage()">Next</button>
            </div>

            <!-- Column Manager Popup -->
            <div class="popover hidden" id="column-manager">
                <div class="popover-header">
                    <span class="popover-title">Manage Columns</span>
                    <button class="popover-close" onclick="closeColumnManager()">×</button>
                </div>
                <div class="popover-content">
                    <div class="column-list" id="column-list-content">
                        <!-- Column list will be populated by JavaScript -->
                    </div>
                </div>
                <div class="popover-footer">
                    <button class="popover-btn" onclick="resetColumnOrder()">Reset Order & Visibility</button>
                </div>
            </div>

            <!-- Advanced Filter Popup -->
            <div class="popover hidden" id="advanced-filter-popup">
                <div class="popover-header">
                    <span class="popover-title" id="filter-title">Column Filter</span>
                    <button class="popover-close" onclick="closeFilterPopup()">×</button>
                </div>
                <div class="popover-content">
                    <div id="filter-controls">
                        <!-- Filter controls will be populated by JavaScript -->
                    </div>
                </div>
                <div class="popover-footer">
                    <button class="popover-btn secondary" onclick="clearCurrentFilter()">Clear</button>
                    <button class="popover-btn primary" onclick="applyFilter()">Apply</button>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                let data = ${JSON.stringify(data)};
                const columns = ${JSON.stringify(columns)};
                let totalRows = ${totalRows};
                let currentPage = 1;
                let rowsPerPage = ${pageSize};
                let sortColumns = []; // Array of {columnIndex, direction} for multi-sort
                let columnFilters = {};
                let allColumns = [...columns]; // Store all columns for column manager
                let visibleColumns = [...columns]; // Track visible columns
                let columnOrder = [...columns]; // Track column order
                let filteredData = data.slice();

                // Query interface variables
                const sampleQueries = ${queriesJson};

                const rowsPerPageSelect = document.getElementById('rowsPerPage');
                if (rowsPerPageSelect) {
                    rowsPerPageSelect.value = String(rowsPerPage);
                }

                // Query interface functions
                function toggleQuerySection() {
                    const content = document.getElementById('queryContent');
                    const toggle = document.getElementById('queryToggle');
                    if (content && toggle) {
                        content.classList.toggle('expanded');
                        toggle.textContent = content.classList.contains('expanded') ? '▼' : '▶';
                    }
                }

                function loadDataGridSampleQuery() {
                    const select = document.getElementById('sampleQuerySelect');
                    const textarea = document.getElementById('queryTextarea');
                    if (!select || !textarea) return;

                    const idx = parseInt(select.value);
                    if (!isNaN(idx) && sampleQueries[idx]) {
                        textarea.value = sampleQueries[idx];

                        // Show warning for destructive queries
                        const query = sampleQueries[idx].toUpperCase();
                        if (query.includes('DELETE') || query.includes('DROP')) {
                            const results = document.getElementById('queryResults');
                            if (results) {
                                results.innerHTML = '<div class="query-warning">⚠️ Warning: This is a destructive operation that cannot be undone!</div>';
                            }
                        }
                    }
                }

                function executeDataGridQuery() {
                    const textarea = document.getElementById('queryTextarea');
                    const results = document.getElementById('queryResults');
                    if (!textarea || !results) return;

                    const query = textarea.value.trim();
                    if (!query) {
                        results.innerHTML = '<div class="query-error">Please enter a query</div>';
                        return;
                    }

                    results.innerHTML = '<div>Executing query...</div>';

                    vscode.postMessage({
                        command: 'executeQuery',
                        query: query
                    });
                }

                function clearQueryResults() {
                    const results = document.getElementById('queryResults');
                    const textarea = document.getElementById('queryTextarea');
                    const select = document.getElementById('sampleQuerySelect');

                    if (results) results.innerHTML = '';
                    if (textarea) textarea.value = '';
                    if (select) select.value = '';
                }

                function displayQueryResults(queryData, rowCount) {
                    const resultsDiv = document.getElementById('queryResults');
                    if (!resultsDiv) return;

                    if (!queryData) {
                        resultsDiv.innerHTML = '<div style="padding: 10px; color: var(--text-secondary);">✓ Query executed successfully. No results returned.</div>';
                        return;
                    }

                    // Check if result is a single value (not an array)
                    if (!Array.isArray(queryData)) {
                        // Handle single value results (SUM, COUNT, AVG, etc.)
                        let resultHtml = '';
                        if (typeof queryData === 'object' && queryData !== null) {
                            // Handle single row result
                            const entries = Object.entries(queryData);
                            resultHtml = '<div style="padding: 15px; background-color: var(--bg-secondary); border-radius: 6px; border-left: 4px solid #4caf50;">';
                            resultHtml += '<div style="font-weight: 600; color: var(--text-primary); margin-bottom: 10px;">Query Result:</div>';
                            entries.forEach(([key, value]) => {
                                resultHtml += \`
                                    <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border-color);">
                                        <span style="color: var(--text-secondary); font-weight: 500;">\${key}:</span>
                                        <span style="color: var(--text-primary); font-family: 'Consolas', 'Monaco', 'Courier New', monospace;">\${value}</span>
                                    </div>
                                \`;
                            });
                            resultHtml += '</div>';
                        } else {
                            // Handle single scalar value
                            resultHtml = \`
                                <div style="padding: 15px; background-color: var(--bg-secondary); border-radius: 6px; border-left: 4px solid #4caf50;">
                                    <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 10px;">Query Result:</div>
                                    <div style="font-size: 18px; color: var(--accent); font-family: 'Consolas', 'Monaco', 'Courier New', monospace; font-weight: 600;">
                                        \${queryData}
                                    </div>
                                </div>
                            \`;
                        }
                        resultsDiv.innerHTML = resultHtml;
                        return;
                    }

                    // Handle empty array results
                    if (queryData.length === 0) {
                        resultsDiv.innerHTML = '<div style="padding: 10px; color: var(--text-secondary);">✓ Query executed successfully. No rows returned.</div>';
                        return;
                    }

                    // Update main table with query results (tabular data)
                    data = queryData;
                    filteredData = queryData;
                    totalRows = rowCount;
                    currentPage = 1;

                    // Update stats
                    const statsDiv = document.getElementById('stats');
                    if (statsDiv) {
                        statsDiv.textContent = \`Query returned \${rowCount} row(s)\`;
                    }

                    // Show success message in query results area
                    resultsDiv.innerHTML = \`<div style="padding: 10px; color: #4caf50;">✓ Query executed successfully. \${rowCount} row(s) displayed in table below.</div>\`;

                    // Re-render the main table with query results
                    renderTable();
                }

                function displayQueryError(error) {
                    const resultsDiv = document.getElementById('queryResults');
                    if (resultsDiv) {
                        resultsDiv.innerHTML = \`<div class="query-error">Error: \${error}</div>\`;
                    }
                }

                // AI Mode functions
                let currentQueryMode = 'sql';

                function setQueryMode(mode) {
                    currentQueryMode = mode;
                    const sqlBtn = document.getElementById('sqlModeBtn');
                    const aiBtn = document.getElementById('aiModeBtn');
                    const sampleRow = document.getElementById('sampleQueryRow');
                    const aiRow = document.getElementById('aiPromptRow');
                    const textarea = document.getElementById('queryTextarea');
                    const executeBtn = document.getElementById('executeBtn');
                    const generateBtn = document.getElementById('generateBtn');

                    if (mode === 'sql') {
                        sqlBtn.classList.add('active');
                        aiBtn.classList.remove('active');
                        sampleRow.style.display = 'flex';
                        aiRow.style.display = 'none';
                        executeBtn.style.display = 'inline-block';
                        generateBtn.style.display = 'none';
                        textarea.placeholder = 'Enter your SQL query here...';
                    } else {
                        sqlBtn.classList.remove('active');
                        aiBtn.classList.add('active');
                        sampleRow.style.display = 'none';
                        aiRow.style.display = 'flex';
                        executeBtn.style.display = 'none';
                        generateBtn.style.display = 'inline-block';
                        textarea.placeholder = 'Describe what you want to find in plain English...';
                    }
                }

                function generateAIQuery() {
                    const textarea = document.getElementById('queryTextarea');
                    const results = document.getElementById('queryResults');
                    if (!textarea || !results) return;

                    const prompt = textarea.value.trim();
                    if (!prompt) {
                        results.innerHTML = '<div class="query-error">Please enter a description of what you want to find</div>';
                        return;
                    }

                    results.innerHTML = '<div>🤖 Generating SQL query...</div>';

                    vscode.postMessage({
                        command: 'generateAIQuery',
                        prompt: prompt
                    });
                }

                function displayAIQuery(sqlQuery) {
                    const textarea = document.getElementById('queryTextarea');
                    const results = document.getElementById('queryResults');
                    const executeBtn = document.getElementById('executeBtn');
                    const generateBtn = document.getElementById('generateBtn');

                    if (textarea) {
                        textarea.value = sqlQuery;
                    }

                    if (results) {
                        results.innerHTML = \`<div style="padding: 10px; color: #4caf50;">✓ SQL query generated successfully. You can now execute it.</div>\`;
                    }

                    // Switch to SQL mode and show execute button
                    setQueryMode('sql');
                    if (executeBtn) executeBtn.style.display = 'inline-block';
                    if (generateBtn) generateBtn.style.display = 'none';
                }

                function displayAIError(error) {
                    const resultsDiv = document.getElementById('queryResults');
                    if (resultsDiv) {
                        resultsDiv.innerHTML = \`<div class="query-error">AI Error: \${error}</div>\`;
                    }
                }

                function getColumnType(columnIndex) {
                    const colName = columns[columnIndex];
                    const firstValue = data.find(row => row[colName] != null)?.[colName];
                    if (typeof firstValue === 'number') return 'number';
                    if (typeof firstValue === 'string' && /^\\d{4}-\\d{2}-\\d{2}/.test(firstValue)) return 'date';
                    return 'string';
                }

                function requestPage(page, pageSize) {
                    vscode.postMessage({
                        command: 'loadPage',
                        page: page,
                        pageSize: pageSize
                    });
                }

                function matchesNumberFilter(value, filterData) {
                    if (value === null || value === undefined) return false;
                    const numValue = typeof value === 'number' ? value : parseFloat(value);
                    if (isNaN(numValue)) return false;

                    const operator = filterData.operator || '=';
                    const filterValue = parseFloat(filterData.value);

                    if (isNaN(filterValue)) return false;

                    switch (operator) {
                        case 'range':
                            const filterValue2 = parseFloat(filterData.value2);
                            if (!isNaN(filterValue2)) {
                                return numValue >= filterValue && numValue <= filterValue2;
                            }
                            return false;
                        case '>=':
                            return numValue >= filterValue;
                        case '<=':
                            return numValue <= filterValue;
                        case '!=':
                            return numValue !== filterValue;
                        case '>':
                            return numValue > filterValue;
                        case '<':
                            return numValue < filterValue;
                        case '=':
                        default:
                            return numValue === filterValue;
                    }
                }

                function matchesDateFilter(value, filterData) {
                    if (!value || !filterData.value) return false;
                    const dateStr = String(value).substring(0, 10);
                    const operator = filterData.operator || '=';
                    const filterDate = filterData.value.substring(0, 10);

                    switch (operator) {
                        case 'range':
                            const filterDate2 = filterData.value2 ? filterData.value2.substring(0, 10) : null;
                            if (filterDate2) {
                                return dateStr >= filterDate && dateStr <= filterDate2;
                            }
                            return false;
                        case '>=':
                            return dateStr >= filterDate;
                        case '<=':
                            return dateStr <= filterDate;
                        case '>':
                            return dateStr > filterDate;
                        case '<':
                            return dateStr < filterDate;
                        case '=':
                            return dateStr === filterDate;
                        case 'contains':
                        default:
                            return dateStr.includes(filterDate) || String(value).toLowerCase().includes(filterData.value.toLowerCase());
                    }
                }

                function matchesStringFilter(value, filterData) {
                    if (value === null || value === undefined) return false;
                    const cellStr = String(value).toLowerCase();
                    const operator = filterData.operator || 'contains';
                    const filterValue = String(filterData.value).toLowerCase();

                    switch (operator) {
                        case 'starts':
                            return cellStr.startsWith(filterValue);
                        case 'ends':
                            return cellStr.endsWith(filterValue);
                        case '!=':
                            return cellStr !== filterValue;
                        case '=':
                            return cellStr === filterValue;
                        case 'contains':
                        default:
                            return cellStr.includes(filterValue);
                    }
                }

                function filterTable() {
                    const input = document.getElementById('searchInput').value.toLowerCase();
                    applyFilters(input);
                }

                function applyFilters(globalSearch = '') {
                    filteredData = data.filter(row => {
                        // Apply global search filter
                        if (globalSearch) {
                            const matchesGlobal = columns.some(col =>
                                JSON.stringify(row[col]).toLowerCase().includes(globalSearch)
                            );
                            if (!matchesGlobal) return false;
                        }

                        // Apply column-specific filters
                        for (const [colIndex, filterData] of Object.entries(columnFilters)) {
                            if (filterData && filterData.value && filterData.value.trim() !== '') {
                                const colName = columns[parseInt(colIndex)];
                                const cellValue = row[colName];
                                const columnType = getColumnType(parseInt(colIndex));

                                let matches = false;
                                if (columnType === 'number') {
                                    matches = matchesNumberFilter(cellValue, filterData);
                                } else if (columnType === 'date') {
                                    matches = matchesDateFilter(cellValue, filterData);
                                } else {
                                    matches = matchesStringFilter(cellValue, filterData);
                                }

                                if (!matches) {
                                    return false;
                                }
                            }
                        }

                        return true;
                    });
                    applySorting();
                    renderTable();
                }

                function toggleColumnFilter(columnIndex) {
                    const filterDiv = document.getElementById('filter-' + columnIndex);
                    const th = filterDiv.parentElement;

                    if (filterDiv.style.display === 'block') {
                        hideColumnFilter(columnIndex);
                    } else {
                        // Hide all other filters
                        columns.forEach((_, idx) => {
                            if (idx !== columnIndex) {
                                hideColumnFilter(idx);
                            }
                        });

                        filterDiv.style.display = 'block';
                        
                        // Initialize filter inputs if they exist
                        const operatorSelect = document.getElementById('filter-operator-' + columnIndex);
                        const valueInput = document.getElementById('filter-value-' + columnIndex);
                        const valueInput2 = document.getElementById('filter-value2-' + columnIndex);
                        
                        if (operatorSelect && valueInput) {
                            // Restore previous filter values if they exist
                            const existingFilter = columnFilters[columnIndex];
                            if (existingFilter && typeof existingFilter === 'object') {
                                operatorSelect.value = existingFilter.operator || 'contains';
                                valueInput.value = existingFilter.value || '';
                                if (valueInput2 && existingFilter.value2) {
                                    valueInput2.value = existingFilter.value2;
                                }
                                updateFilterInput(columnIndex);
                            }
                            valueInput.focus();
                        }
                    }
                }

                function hideColumnFilter(columnIndex) {
                    const filterDiv = document.getElementById('filter-' + columnIndex);
                    const th = filterDiv.parentElement;
                    filterDiv.style.display = 'none';
                    th.classList.remove('filter-active');
                }

                function updateFilterInput(columnIndex) {
                    const operatorSelect = document.getElementById('filter-operator-' + columnIndex);
                    const valueInput = document.getElementById('filter-value-' + columnIndex);
                    const valueInput2 = document.getElementById('filter-value2-' + columnIndex);
                    
                    if (!operatorSelect || !valueInput) return;
                    
                    const operator = operatorSelect.value;
                    
                    // Show/hide second input for range operations
                    if (valueInput2) {
                        valueInput2.style.display = operator === 'range' ? 'block' : 'none';
                    }
                    
                    // Update placeholders based on operator
                    if (operator === 'range') {
                        valueInput.placeholder = 'Min';
                    } else if (operator === '>') {
                        valueInput.placeholder = 'Minimum';
                    } else if (operator === '<') {
                        valueInput.placeholder = 'Maximum';
                    } else {
                        valueInput.placeholder = 'Value';
                    }
                }

                function submitColumnFilter(columnIndex) {
                    const operatorSelect = document.getElementById('filter-operator-' + columnIndex);
                    const valueInput = document.getElementById('filter-value-' + columnIndex);
                    const valueInput2 = document.getElementById('filter-value2-' + columnIndex);
                    
                    if (!operatorSelect || !valueInput) return;
                    
                    const operator = operatorSelect.value;
                    const value = valueInput.value;
                    const value2 = valueInput2 ? valueInput2.value : '';
                    
                    if (value && value.trim() !== '') {
                        // Store filter as object with operator and value(s)
                        columnFilters[columnIndex] = {
                            operator: operator,
                            value: value,
                            value2: value2
                        };
                        const th = document.getElementById('filter-' + columnIndex).parentElement;
                        th.classList.add('filter-active');
                    } else {
                        delete columnFilters[columnIndex];
                        const th = document.getElementById('filter-' + columnIndex).parentElement;
                        th.classList.remove('filter-active');
                    }
                    
                    const globalSearch = document.getElementById('searchInput').value.toLowerCase();
                    applyFilters(globalSearch);
                }

                function applyColumnFilter(columnIndex, filterValue) {
                    if (filterValue && filterValue.trim() !== '') {
                        columnFilters[columnIndex] = filterValue;
                        const th = document.getElementById('filter-' + columnIndex).parentElement;
                        th.classList.add('filter-active');
                    } else {
                        delete columnFilters[columnIndex];
                        const th = document.getElementById('filter-' + columnIndex).parentElement;
                        th.classList.remove('filter-active');
                    }

                    const globalSearch = document.getElementById('searchInput').value.toLowerCase();
                    applyFilters(globalSearch);
                }

                function sortTable(columnIndex, event) {
                    const isShiftPressed = event && event.shiftKey;
                    
                    if (isShiftPressed) {
                        // Multi-column sorting with Shift
                        const existingSortIndex = sortColumns.findIndex(s => s.columnIndex === columnIndex);
                        
                        if (existingSortIndex !== -1) {
                            const currentDirection = sortColumns[existingSortIndex].direction;
                            if (currentDirection === 1) {
                                // asc -> desc
                                sortColumns[existingSortIndex].direction = -1;
                            } else {
                                // desc -> remove
                                sortColumns.splice(existingSortIndex, 1);
                            }
                        } else {
                            // Add new column to sort
                            sortColumns.push({ columnIndex, direction: 1 });
                        }
                    } else {
                        // Single column sorting (normal click)
                        if (sortColumns.length === 1 && sortColumns[0].columnIndex === columnIndex) {
                            const currentDirection = sortColumns[0].direction;
                            if (currentDirection === 1) {
                                // asc -> desc
                                sortColumns[0].direction = -1;
                            } else {
                                // desc -> unsort
                                sortColumns = [];
                            }
                        } else {
                            // New single column sort
                            sortColumns = [{ columnIndex, direction: 1 }];
                        }
                    }
                    
                    applySorting();
                    updateSortIndicators();
                    renderTable();
                }
                
                function applySorting() {
                    if (sortColumns.length === 0) return;
                    
                    filteredData.sort((a, b) => {
                        for (const sort of sortColumns) {
                            const { columnIndex, direction } = sort;
                            const colName = columns[columnIndex];
                            const aVal = a[colName];
                            const bVal = b[colName];
                            
                            let comparison = 0;
                            if (aVal === null || aVal === undefined) {
                                comparison = (bVal === null || bVal === undefined) ? 0 : -1;
                            } else if (bVal === null || bVal === undefined) {
                                comparison = 1;
                            } else {
                                comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
                            }
                            
                            if (comparison !== 0) {
                                return comparison * direction;
                            }
                        }
                        return 0;
                    });
                }
                
                function updateSortIndicators() {
                    // Clear all sort indicators
                    document.querySelectorAll('th').forEach((th, index) => {
                        th.classList.remove('sort-asc', 'sort-desc');
                        const existingIndicator = th.querySelector('.sort-indicator');
                        if (existingIndicator) {
                            existingIndicator.remove();
                        }
                    });
                    
                    // Add sort indicators for sorted columns
                    sortColumns.forEach((sort, index) => {
                        const { columnIndex, direction } = sort;
                        const th = document.querySelectorAll('th')[columnIndex];
                        if (th) {
                            th.classList.add(direction === 1 ? 'sort-asc' : 'sort-desc');
                            
                            // Add sort indicator icon
                            const indicator = document.createElement('span');
                            indicator.className = 'sort-indicator';
                            
                            // Create SVG icon
                            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                            svg.setAttribute('width', '16');
                            svg.setAttribute('height', '16');
                            svg.setAttribute('viewBox', '0 0 24 24');
                            svg.setAttribute('fill', 'none');
                            svg.setAttribute('stroke', 'currentColor');
                            svg.setAttribute('stroke-width', '2');
                            svg.setAttribute('stroke-linecap', 'round');
                            svg.setAttribute('stroke-linejoin', 'round');
                            
                            if (direction === 1) {
                                // Arrow up for ascending
                                const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                                path1.setAttribute('d', 'm5 12 7-7 7 7');
                                const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                                path2.setAttribute('d', 'M12 19V5');
                                svg.appendChild(path1);
                                svg.appendChild(path2);
                            } else {
                                // Arrow down for descending
                                const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                                path1.setAttribute('d', 'M12 5v14');
                                const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                                path2.setAttribute('d', 'm19 12-7 7-7-7');
                                svg.appendChild(path1);
                                svg.appendChild(path2);
                            }
                            
                            indicator.appendChild(svg);
                            
                            if (index > 0) {
                                const priority = document.createElement('span');
                                priority.className = 'sort-priority';
                                priority.textContent = index + 1;
                                priority.title = 'Sort priority ' + (index + 1);
                                indicator.appendChild(priority);
                            }
                            
                            th.querySelector('span').appendChild(indicator);
                        }
                    });
                }

                function renderTable() {
                    const tbody = document.getElementById('tableBody');
                    const tableContainer = document.querySelector('.table-container');
                    const pageData = filteredData;

                    // DO NOT rebuild headers - they contain stateful filter UI
                    // Headers are built once in the HTML template and should never be destroyed

                    // Handle empty state
                    if (pageData.length === 0) {
                        if (tbody) {
                            tbody.innerHTML = '';
                        }
                        
                        // Keep the table header with filters visible, just empty the tbody
                        // Don't replace the entire table, just show empty state in tbody
                        const emptyStateHtml = \`
                            <tr>
                                <td colspan="\${allColumns.length}" style="text-align: center; padding: 60px 20px; vertical-align: middle;">
                                    <div class="empty-state" style="display: block; min-height: auto; padding: 40px;">
                                        <div class="empty-state-icon">📭</div>
                                        <div class="empty-state-title">No records found</div>
                                        <div class="empty-state-message">
                                            \${data.length === 0 ? 
                                                'No data available in this table.' : 
                                                'No records match your current filters. Try adjusting your search criteria or clear all filters.'
                                            }
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        \`;
                        
                        if (tbody) {
                            tbody.innerHTML = emptyStateHtml;
                        }
                        
                        updateSortIndicators();
                        updatePagination();
                        return;
                    }

                    // Render table body respecting column visibility
                    if (tbody) {
                        tbody.innerHTML = pageData.map(row => {
                            return \`<tr>\${allColumns.map(col => {
                                const value = row[col];
                                let cellClass = '';
                                let formattedValue = '';

                                if (value === null || value === undefined) {
                                    cellClass = 'null';
                                    formattedValue = '<i>NULL</i>';
                                } else if (typeof value === 'object') {
                                    cellClass = 'object';
                                    formattedValue = JSON.stringify(value);
                                } else {
                                    cellClass = typeof value;
                                    formattedValue = String(value);
                                }

                                const displayStyle = visibleColumns.includes(col) ? '' : 'display: none;';
                                return \`<td class="\${cellClass}" style="\${displayStyle}">\${formattedValue}</td>\`;
                            }).join('')}</tr>\`;
                        }).join('');
                    }

                    // Show records found message if filtered
                    if (filteredData.length < data.length) {
                        const statsDiv = document.getElementById('stats');
                        if (statsDiv && !statsDiv.querySelector('.records-found')) {
                            const recordsFoundMsg = document.createElement('div');
                            recordsFoundMsg.className = 'records-found';
                            recordsFoundMsg.textContent = \`\${filteredData.length} of \${data.length} records found\`;
                            statsDiv.insertBefore(recordsFoundMsg, statsDiv.firstChild);
                        } else if (statsDiv) {
                            const existingMsg = statsDiv.querySelector('.records-found');
                            if (existingMsg) {
                                existingMsg.textContent = \`\${filteredData.length} of \${data.length} records found\`;
                            }
                        }
                    } else {
                        // Remove records found message if not filtered
                        const statsDiv = document.getElementById('stats');
                        if (statsDiv) {
                            const existingMsg = statsDiv.querySelector('.records-found');
                            if (existingMsg) {
                                existingMsg.remove();
                            }
                        }
                    }

                    updateSortIndicators();
                    updatePagination();
                }

                function updatePagination() {
                    const totalPages = Math.max(1, Math.ceil(totalRows / rowsPerPage));
                    if (currentPage > totalPages) {
                        currentPage = totalPages;
                    }
                    document.getElementById('pageInfo').textContent = \`Page \${currentPage} of \${totalPages}\`;
                    document.getElementById('prevBtn').disabled = currentPage === 1;
                    document.getElementById('nextBtn').disabled = currentPage === totalPages;
                    document.getElementById('recordCount').textContent = \`Showing \${filteredData.length} of \${totalRows} rows\`;
                    const stats = document.getElementById('stats');
                    if (stats) {
                        stats.textContent = \`Showing \${filteredData.length} of \${totalRows} rows\`;
                    }
                }

                function changeRowsPerPage(value) {
                    const nextSize = parseInt(value, 10);
                    if (!Number.isFinite(nextSize) || nextSize <= 0) {
                        return;
                    }
                    rowsPerPage = nextSize;
                    currentPage = 1;
                    requestPage(currentPage, rowsPerPage);
                }

                function toggleQueryConsole() {
                    // This would open query console in a new panel
                    console.log('Query console toggle requested');
                }

                function clearAllFilters() {
                    columnFilters = {};
                    sortColumns = [];
                    document.getElementById('searchInput').value = '';
                    
                    // Clear all filter UI elements
                    columns.forEach((_, idx) => {
                        const operatorSelect = document.getElementById('filter-operator-' + idx);
                        const valueInput = document.getElementById('filter-value-' + idx);
                        const valueInput2 = document.getElementById('filter-value2-' + idx);

                        if (operatorSelect) operatorSelect.value = 'contains';
                        if (valueInput) valueInput.value = '';
                        if (valueInput2) valueInput2.value = '';

                        const filterElement = document.getElementById('filter-' + idx);
                        if (filterElement && filterElement.parentElement) {
                            filterElement.parentElement.classList.remove('filter-active');
                        }
                    });
                    
                    // Remove records found message
                    const statsDiv = document.getElementById('stats');
                    if (statsDiv) {
                        const existingMsg = statsDiv.querySelector('.records-found');
                        if (existingMsg) {
                            existingMsg.remove();
                        }
                    }
                    
                    applySorting();
                    updateSortIndicators();
                    renderTable();
                }

                // Column Manager Functions
                function openColumnManager(event) {
                    event.stopPropagation();
                    const mgr = document.getElementById('column-manager');
                    const trigger = event.currentTarget;
                    const rect = trigger.getBoundingClientRect();
                    
                    renderColumnList();
                    mgr.classList.remove('hidden');
                    
                    let left = rect.left;
                    if (left + 240 > window.innerWidth) left = window.innerWidth - 250;
                    mgr.style.left = left + 'px';
                    mgr.style.top = (rect.bottom + 8) + 'px';
                }

                function closeColumnManager() { 
                    document.getElementById('column-manager').classList.add('hidden'); 
                }

                function renderColumnList() {
                    const container = document.getElementById('column-list-content');
                    // TODO: Column reordering is disabled because the filter/sort system uses
                    // hardcoded column indices. To re-enable, refactor all filter/sort code
                    // to use column names instead of indices.
                    container.innerHTML = allColumns.map((col, idx) => \`
                        <div class="column-item">
                            <input type="checkbox" \${visibleColumns.includes(col) ? 'checked' : ''} onchange="toggleColVisibility('\${col}')">
                            <span>\${col}</span>
                        </div>
                    \`).join('');
                }

                function toggleColVisibility(col) {
                    const colIndex = allColumns.indexOf(col);

                    if (visibleColumns.includes(col)) {
                        if (visibleColumns.length > 1) {
                            visibleColumns = visibleColumns.filter(c => c !== col);
                            // Hide header
                            const th = document.querySelectorAll('#dataTable thead th')[colIndex];
                            if (th) th.style.display = 'none';
                            // Hide all cells in this column
                            document.querySelectorAll('#dataTable tbody tr').forEach(tr => {
                                if (tr.children[colIndex]) {
                                    tr.children[colIndex].style.display = 'none';
                                }
                            });
                        }
                    } else {
                        visibleColumns.push(col);
                        // Show header
                        const th = document.querySelectorAll('#dataTable thead th')[colIndex];
                        if (th) th.style.display = '';
                        // Show all cells in this column
                        document.querySelectorAll('#dataTable tbody tr').forEach(tr => {
                            if (tr.children[colIndex]) {
                                tr.children[colIndex].style.display = '';
                            }
                        });
                    }
                    renderColumnList();
                }

                // Column reordering disabled - see renderColumnList() comment
                // function moveColIdx(idx, direction) {
                //     const target = idx + direction;
                //     if (target < 0 || target >= allColumns.length) return;
                //     const temp = allColumns[idx];
                //     allColumns[idx] = allColumns[target];
                //     allColumns[target] = temp;
                //     renderTable();
                //     renderColumnList();
                // }

                function resetColumnOrder() {
                    visibleColumns = [...columns];
                    // Show all headers
                    document.querySelectorAll('#dataTable thead th').forEach(th => {
                        th.style.display = '';
                    });
                    renderTable(); // Safe now - only updates tbody
                    renderColumnList();
                }

                // Drag and drop for columns - DISABLED
                // let draggedIdx = null;
                // function dragCol(e, idx) { draggedIdx = idx; e.dataTransfer.effectAllowed = 'move'; }
                // function allowDrop(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
                // function dropCol(e, idx) {
                //     e.preventDefault();
                //     const moving = allColumns.splice(draggedIdx, 1)[0];
                //     allColumns.splice(idx, 0, moving);
                //     renderTable();
                //     renderColumnList();
                // }

                // Advanced Filter Functions
                let activeFilterCol = null;
                
                function openFilterPopup(event, col) {
                    event.stopPropagation();
                    const popup = document.getElementById('advanced-filter-popup');
                    const trigger = event.currentTarget;
                    const rect = trigger.getBoundingClientRect();
                    
                    activeFilterCol = col;
                    document.getElementById('filter-title').innerText = 'Filter: ' + col;
                    renderFilterControls(getColumnType(col), columnFilters[col] || {}, document.getElementById('filter-controls'));

                    popup.classList.remove('hidden');
                    let left = rect.left - 240;
                    if (left < 10) left = 10;
                    let top = rect.bottom + 10;
                    if (top + 400 > window.innerHeight) top = rect.top - 400;
                    popup.style.left = left + 'px';
                    popup.style.top = top + 'px';
                }

                function closeFilterPopup() { 
                    document.getElementById('advanced-filter-popup').classList.add('hidden'); 
                }

                function renderFilterControls(type, current, container) {
                    let html = '';
                    if (type === 'string') {
                        html = \`<div>
                            <label class="filter-label">Contains</label>
                            <input type="text" class="filter-input" value="\${current.value || ''}" placeholder="Enter keyword...">
                        </div>\`;
                    } else if (type === 'number') {
                        html = \`<div>
                            <label class="filter-label">Operator</label>
                            <select class="filter-select" onchange="document.getElementById('filter-value2-box').classList.toggle('hidden', this.value !== 'range')">
                                <option value="=" \${current.op === '=' ? 'selected' : ''}>=</option>
                                <option value=">" \${current.op === '>' ? 'selected' : ''}>></option>
                                <option value="<" \${current.op === '<' ? 'selected' : ''}><</option>
                                <option value="range" \${current.op === 'range' ? 'selected' : ''}>Range</option>
                            </select>
                            <input type="number" class="filter-input" value="\${current.value || ''}" placeholder="Value">
                            <div id="filter-value2-box" class="\${current.op === 'range' ? '' : 'hidden'}">
                                <input type="number" class="filter-input" value="\${current.value2 || ''}" placeholder="Max">
                            </div>
                        </div>\`;
                    } else if (type === 'date') {
                        html = \`<div>
                            <label class="filter-label">Condition</label>
                            <select class="filter-select" onchange="document.getElementById('filter-date2-box').classList.toggle('hidden', this.value !== 'range')">
                                <option value="=" \${current.op === "=" ? 'selected' : ''}>=</option>
                                <option value=">" \${current.op === '>' ? 'selected' : ''}>After</option>
                                <option value="<" \${current.op === '<' ? 'selected' : ''}>Before</option>
                                <option value="range" \${current.op === 'range' ? 'selected' : ''}>Between</option>
                            </select>
                            <input type="date" class="filter-input" value="\${current.value || ''}">
                            <div id="filter-date2-box" class="\${current.op === 'range' ? '' : 'hidden'}">
                                <input type="date" class="filter-input" value="\${current.value2 || ''}">
                            </div>
                        </div>\`;
                    } else if (type === 'boolean') {
                        html = \`<select class="filter-select">
                            <option value="true" \${current.value === 'true' ? 'selected' : ''}>TRUE</option>
                            <option value="false" \${current.value === 'false' ? 'selected' : ''}>FALSE</option>
                        </select>\`;
                    }
                    container.innerHTML = html;
                }

                function applyFilter() {
                    const inputs = document.querySelectorAll('#filter-controls input');
                    const selects = document.querySelectorAll('#filter-controls select');
                    
                    let filterValue = null;
                    let filterValue2 = null;
                    let filterOp = null;
                    
                    inputs.forEach(input => {
                        if (input.value) {
                            if (!filterValue) filterValue = input.value;
                            else filterValue2 = input.value;
                        }
                    });
                    
                    selects.forEach(select => {
                        if (select.value) filterOp = select.value;
                    });
                    
                    if (filterValue === '' && getColumnType(activeFilterCol) !== 'boolean') {
                        delete columnFilters[activeFilterCol];
                    } else {
                        columnFilters[activeFilterCol] = { 
                            type: getColumnType(activeFilterCol), 
                            value: filterValue, 
                            value2: filterValue2, 
                            op: filterOp || '=' 
                        };
                    }
                    
                    applyFiltering();
                    renderTable();
                    closeFilterPopup();
                }

                function clearCurrentFilter() { 
                    delete columnFilters[activeFilterCol]; 
                    applyFiltering();
                    renderTable(); 
                    closeFilterPopup(); 
                }

                function previousPage() {
                    if (currentPage > 1) {
                        requestPage(currentPage - 1, rowsPerPage);
                    }
                }

                function nextPage() {
                    const totalPages = Math.max(1, Math.ceil(totalRows / rowsPerPage));
                    if (currentPage < totalPages) {
                        requestPage(currentPage + 1, rowsPerPage);
                    }
                }

                function prevPage() {
                    previousPage();
                }

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'pageData') {
                        data = Array.isArray(message.data) ? message.data : [];
                        if (typeof message.totalRows === 'number') {
                            totalRows = message.totalRows;
                        }
                        const nextPage = Number(message.page);
                        if (Number.isFinite(nextPage) && nextPage > 0) {
                            currentPage = Math.floor(nextPage);
                        }
                        const nextPageSize = Number(message.pageSize);
                        if (Number.isFinite(nextPageSize) && nextPageSize > 0) {
                            rowsPerPage = Math.floor(nextPageSize);
                            if (rowsPerPageSelect) {
                                rowsPerPageSelect.value = String(rowsPerPage);
                            }
                        }
                        const globalSearchInput = document.getElementById('searchInput');
                        const globalSearch = globalSearchInput ? globalSearchInput.value.toLowerCase() : '';
                        applyFilters(globalSearch);
                    } else if (message.command === 'pageError') {
                        console.error(message.error || 'Failed to load page');
                    } else if (message.command === 'queryResult') {
                        displayQueryResults(message.data, message.rowCount);
                    } else if (message.command === 'queryError') {
                        displayQueryError(message.error);
                    } else if (message.command === 'aiQueryResult') {
                        displayAIQuery(message.sqlQuery);
                    } else if (message.command === 'aiQueryError') {
                        displayAIError(message.error);
                    }
                });

                // Add click outside filter handler
                document.addEventListener('click', function(event) {
                    const target = event.target;
                    
                    // Check if click is outside any filter container
                    const isClickInsideFilter = target.closest('.column-filter') || 
                                           target.closest('.filter-operator-select') || 
                                           target.closest('.filter-value-container') ||
                                           target.closest('th');
                    
                    if (!isClickInsideFilter) {
                        // Hide all visible filters
                        columns.forEach((_, idx) => {
                            const filterDiv = document.getElementById('filter-' + idx);
                            if (filterDiv && filterDiv.style.display === 'block') {
                                hideColumnFilter(idx);
                            }
                        });
                    }
                });

                renderTable();
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
