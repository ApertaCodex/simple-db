import * as vscode from 'vscode';
import * as path from 'path';
import { DatabaseItem, DatabaseTreeItem } from './types';
import { SQLiteManager } from './SQLiteManager';
import { MongoDBManager } from './MongoDBManager';

export class DatabaseExplorer {
    connections: DatabaseItem[] = [];
    private _disposables: vscode.Disposable[] = [];
    private _treeDataProvider: DatabaseTreeDataProvider;

    constructor(private sqliteManager: SQLiteManager, private mongoManager: MongoDBManager) {
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
            let data;
            if (item.connection.type === 'sqlite') {
                data = await this.sqliteManager.getTableData(item.connection.path, item.label);
            } else {
                data = await this.mongoManager.getCollectionData(item.connection.path, item.label);
            }

            this.showDataGrid(data, item.label);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load data: ${error}`);
        }
    }

    async openQueryConsole(item: DatabaseTreeItem) {
        try {
            let data;
            if (item.connection.type === 'sqlite') {
                data = await this.sqliteManager.getTableData(item.connection.path, item.label);
            } else {
                data = await this.mongoManager.getCollectionData(item.connection.path, item.label);
            }

            this.showQueryConsole(data, item.label, item.connection.path);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open query console: ${error}`);
        }
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

    private showDataGrid(data: any[], tableName: string) {
        const panel = vscode.window.createWebviewPanel(
            'dataGrid',
            `Data: ${tableName}`,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = this.getDataGridHtml(data, tableName);
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

    private getQueryConsoleHtml(data: any[], tableName: string, dbPath: string): string {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>SQL Query Console - ${tableName}</title>
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
                    <div class="console-title">SQL Query Console</div>
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

    private getDataGridHtml(data: any[], tableName: string): string {
        const columns = data.length > 0 ? Object.keys(data[0]) : [];
        
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
                    gap: 4px;
                    padding: 4px;
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
            </style>
        </head>
        <body>
            <h2>${tableName}</h2>
            <div class="stats">Showing ${data.length} rows</div>
            <div class="search">
                <svg class="search-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m21 21-4.34-4.34"/>
                    <circle cx="11" cy="11" r="8"/>
                </svg>
                <input type="text" id="searchInput" placeholder="Search..." onkeyup="filterTable()">
            </div>
            
            <div class="toolbar">
                <button class="toolbar-btn" onclick="toggleQueryConsole()" title="SQL Query Console">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="m15 7-3 3-3-3"/>
                        <path d="M12 10v10"/>
                        <path d="M17 12h10"/>
                    </svg>
                    Console
                </button>
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
                    <span id="recordCount">Showing ${data.length} rows</span>
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
                                        <input type="text" id="filter-input-${idx}"
                                               placeholder="2024-01-01 to 2024-12-31"
                                               onkeypress="if(event.key==='Enter') submitColumnFilter(${idx})"
                                               onclick="event.stopPropagation()">
                                        <button class="filter-btn" onclick="submitColumnFilter(${idx})"></button>
                                    </div>`;
                                    helpText = '<div class="filter-help">&gt;, &lt;, from to, YYYY-MM-DD</div>';
                                } else if (isNumber) {
                                    filterInput = `<div class="filter-input-container">
                                        <input type="text" id="filter-input-${idx}"
                                               placeholder=">100, <50, 10-20..."
                                               onkeypress="if(event.key==='Enter') submitColumnFilter(${idx})"
                                               onclick="event.stopPropagation()">
                                        <button class="filter-btn" onclick="submitColumnFilter(${idx})"></button>
                                    </div>`;
                                    helpText = '<div class="filter-help">&gt;, &lt;, &gt;=, &lt;=, =, 10-20</div>';
                                } else {
                                    filterInput = `<div class="filter-input-container">
                                        <input type="text" id="filter-input-${idx}"
                                               placeholder="Filter ${col}..."
                                               onkeypress="if(event.key==='Enter') submitColumnFilter(${idx})"
                                               onclick="event.stopPropagation()">
                                        <button class="filter-btn" onclick="submitColumnFilter(${idx})"></button>
                                    </div>`;
                                    helpText = '<div class="filter-help">Type and press Enter or click 🔍</div>';
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
                const data = ${JSON.stringify(data)};
                const columns = ${JSON.stringify(columns)};
                let currentPage = 1;
                const rowsPerPage = 50;
                let sortColumns = []; // Array of {columnIndex, direction} for multi-sort
                let columnFilters = {};
                let allColumns = [...columns]; // Store all columns for column manager
                let visibleColumns = [...columns]; // Track visible columns
                let columnOrder = [...columns]; // Track column order

                function getColumnType(columnIndex) {
                    const colName = columns[columnIndex];
                    const firstValue = data.find(row => row[colName] != null)?.[colName];
                    if (typeof firstValue === 'number') return 'number';
                    if (typeof firstValue === 'string' && /^\\d{4}-\\d{2}-\\d{2}/.test(firstValue)) return 'date';
                    return 'string';
                }

                function matchesNumberFilter(value, filterExpr) {
                    if (value === null || value === undefined) return false;
                    const numValue = typeof value === 'number' ? value : parseFloat(value);
                    if (isNaN(numValue)) return false;

                    filterExpr = filterExpr.trim();

                    // Range: 10-20 or 10..20
                    if (/^\\d+\\.?\\d*\\s*[-~]\\s*\\d+\\.?\\d*$/.test(filterExpr)) {
                        const [min, max] = filterExpr.split(/[-~]/).map(s => parseFloat(s.trim()));
                        return numValue >= min && numValue <= max;
                    }

                    // Greater than or equal: >=10
                    if (filterExpr.startsWith('>=')) {
                        return numValue >= parseFloat(filterExpr.substring(2));
                    }

                    // Less than or equal: <=10
                    if (filterExpr.startsWith('<=')) {
                        return numValue <= parseFloat(filterExpr.substring(2));
                    }

                    // Not equal: !=10 or <>10
                    if (filterExpr.startsWith('!=') || filterExpr.startsWith('<>')) {
                        return numValue !== parseFloat(filterExpr.substring(2));
                    }

                    // Greater than: >10
                    if (filterExpr.startsWith('>')) {
                        return numValue > parseFloat(filterExpr.substring(1));
                    }

                    // Less than: <10
                    if (filterExpr.startsWith('<')) {
                        return numValue < parseFloat(filterExpr.substring(1));
                    }

                    // Equal: =10 or just 10
                    if (filterExpr.startsWith('=')) {
                        return numValue === parseFloat(filterExpr.substring(1));
                    }

                    // Just a number
                    const filterNum = parseFloat(filterExpr);
                    if (!isNaN(filterNum)) {
                        return numValue === filterNum;
                    }

                    return false;
                }

                function matchesDateFilter(value, filterExpr) {
                    if (!value || !filterExpr) return false;
                    const dateStr = String(value).substring(0, 10);
                    filterExpr = filterExpr.trim();

                    // Range: 2024-01-01 to 2024-12-31 or 2024-01-01..2024-12-31
                    if (/\d{4}-\d{2}-\d{2}\s+(to|-|\.\.)\s+\d{4}-\d{2}-\d{2}/.test(filterExpr)) {
                        const parts = filterExpr.split(/\s+(to|-|\.\.)\s+/);
                        const fromDate = parts[0];
                        const toDate = parts[2] || parts[1];
                        return dateStr >= fromDate && dateStr <= toDate;
                    }

                    // Greater than or equal: >=2024-01-01
                    if (filterExpr.startsWith('>=')) {
                        return dateStr >= filterExpr.substring(2).trim();
                    }

                    // Less than or equal: <=2024-01-01
                    if (filterExpr.startsWith('<=')) {
                        return dateStr <= filterExpr.substring(2).trim();
                    }

                    // Greater than: >2024-01-01
                    if (filterExpr.startsWith('>')) {
                        return dateStr > filterExpr.substring(1).trim();
                    }

                    // Less than: <2024-01-01
                    if (filterExpr.startsWith('<')) {
                        return dateStr < filterExpr.substring(1).trim();
                    }

                    // Exact match
                    return dateStr === filterExpr || dateStr.includes(filterExpr);
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
                        for (const [colIndex, filterValue] of Object.entries(columnFilters)) {
                            if (filterValue && filterValue.trim() !== '') {
                                const colName = columns[parseInt(colIndex)];
                                const cellValue = row[colName];
                                const columnType = getColumnType(parseInt(colIndex));

                                let matches = false;
                                if (columnType === 'number') {
                                    matches = matchesNumberFilter(cellValue, filterValue);
                                } else if (columnType === 'date') {
                                    matches = matchesDateFilter(cellValue, filterValue);
                                } else {
                                    // String matching
                                    const cellStr = JSON.stringify(cellValue).toLowerCase();
                                    matches = cellStr.includes(filterValue.toLowerCase());
                                }

                                if (!matches) {
                                    return false;
                                }
                            }
                        }

                        return true;
                    });
                    currentPage = 1;
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
                        const input = document.getElementById('filter-input-' + columnIndex);
                        if (input) {
                            input.focus();
                            // Restore previous filter value if it exists
                            if (columnFilters[columnIndex]) {
                                input.value = columnFilters[columnIndex];
                            }
                        }
                    }
                }

                function hideColumnFilter(columnIndex) {
                    const filterDiv = document.getElementById('filter-' + columnIndex);
                    const th = filterDiv.parentElement;
                    filterDiv.style.display = 'none';
                    th.classList.remove('filter-active');
                }

                function submitColumnFilter(columnIndex) {
                    const input = document.getElementById('filter-input-' + columnIndex);
                    const filterValue = input.value;

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
                    const thead = document.querySelector('#dataTable thead tr');
                    const start = (currentPage - 1) * rowsPerPage;
                    const end = start + rowsPerPage;
                    const pageData = filteredData.slice(start, end);

                    // Update table headers to show only visible columns
                    if (thead) {
                        const headerCells = Array.from(thead.querySelectorAll('th'));
                        headerCells.forEach((th, idx) => {
                            const colName = columns[idx];
                            th.style.display = visibleColumns.includes(colName) ? '' : 'none';
                        });
                    }

                    tbody.innerHTML = pageData.map(row => {
                        return \`<tr>\${columns.map(col => {
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

                    updatePagination();
                }

                function updatePagination() {
                    const totalPages = Math.ceil(filteredData.length / rowsPerPage);
                    document.getElementById('pageInfo').textContent = \`Page \${currentPage} of \${totalPages}\`;
                    document.getElementById('prevBtn').disabled = currentPage === 1;
                    document.getElementById('nextBtn').disabled = currentPage === totalPages;
                    document.getElementById('recordCount').textContent = \`Showing \${filteredData.length} rows\`;
                }

                function changeRowsPerPage(value) {
                    rowsPerPage = parseInt(value);
                    currentPage = 1;
                    renderTable();
                }

                function toggleQueryConsole() {
                    // This would open query console in a new panel
                    console.log('Query console toggle requested');
                }

                function openColumnManager(event) {
                    event.stopPropagation();
                    // This would open column manager popup
                    console.log('Column manager requested');
                }

                function clearAllFilters() {
                    columnFilters = {};
                    sortColumns = [];
                    document.getElementById('searchInput').value = '';
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
                    container.innerHTML = allColumns.map((col, idx) => \`
                        <div class="column-item" draggable="true" ondragstart="dragCol(event, \${idx})" ondragover="allowDrop(event)" ondrop="dropCol(event, \${idx})">
                            <span class="drag-handle">⋮⋮</span>
                            <input type="checkbox" \${visibleColumns.includes(col) ? 'checked' : ''} onchange="toggleColVisibility('\${col}')">
                            <span>\${col}</span>
                            <div class="column-controls">
                                <button onclick="moveColIdx(\${idx}, -1)">↑</button>
                                <button onclick="moveColIdx(\${idx}, 1)">↓</button>
                            </div>
                        </div>
                    \`).join('');
                }

                function toggleColVisibility(col) {
                    if (visibleColumns.includes(col)) {
                        if (visibleColumns.length > 1) visibleColumns = visibleColumns.filter(c => c !== col);
                    } else {
                        visibleColumns.push(col);
                    }
                    renderTable();
                    renderColumnList();
                }

                function moveColIdx(idx, direction) {
                    const target = idx + direction;
                    if (target < 0 || target >= allColumns.length) return;
                    const temp = allColumns[idx];
                    allColumns[idx] = allColumns[target];
                    allColumns[target] = temp;
                    renderTable();
                    renderColumnList();
                }

                function resetColumnOrder() {
                    allColumns = [...columns];
                    visibleColumns = [...columns];
                    renderTable();
                    renderColumnList();
                }

                // Drag and drop for columns
                let draggedIdx = null;
                function dragCol(e, idx) { draggedIdx = idx; e.dataTransfer.effectAllowed = 'move'; }
                function allowDrop(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
                function dropCol(e, idx) {
                    e.preventDefault();
                    const moving = allColumns.splice(draggedIdx, 1)[0];
                    allColumns.splice(idx, 0, moving);
                    renderTable();
                    renderColumnList();
                }

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
                        currentPage--;
                        renderTable();
                    }
                }

                function nextPage() {
                    const totalPages = Math.ceil(filteredData.length / rowsPerPage);
                    if (currentPage < totalPages) {
                        currentPage++;
                        renderTable();
                    }
                }

                renderTable();
            </script>
        </body>
        </html>`;
    }

    getConnections(): DatabaseItem[] {
        return this.connections;
    }

    private loadConnections() {
        const config = vscode.workspace.getConfiguration('databaseViewer');
        const connections = config.get<any[]>('connections') || [];
        this.connections = connections;
    }

    private saveConnections() {
        const config = vscode.workspace.getConfiguration('databaseViewer');
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

    getChildren(element?: DatabaseTreeItem): Thenable<DatabaseTreeItem[]> {
        if (!element) {
            return Promise.resolve(this.explorer.connections.map(connection => 
                new DatabaseTreeItem(connection, connection.name, vscode.TreeItemCollapsibleState.Expanded, 'connection')
            ));
        } else if (element.contextValue === 'connection') {
            const items = element.connection.tables.map((table: string) => 
                new DatabaseTreeItem(element.connection, table, vscode.TreeItemCollapsibleState.None, 'table')
            );
            
            // Add query console option for tables
            items.push(new DatabaseTreeItem(element.connection, 'Query Console', vscode.TreeItemCollapsibleState.None, 'query-console'));
            
            return Promise.resolve(items);
        }
        return Promise.resolve([]);
    }
}
