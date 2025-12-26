import * as vscode from 'vscode';
import * as path from 'path';
import { DatabaseItem, DatabaseTreeItem } from './types';
import { SQLiteManager } from './SQLiteManager';
import { MongoDBManager } from './MongoDBManager';

export class DatabaseExplorer {
    private connections: DatabaseItem[] = [];
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

    private showDataGrid(data: any[], tableName: string) {
        const panel = vscode.window.createWebviewPanel(
            'dataGrid',
            `Data: ${tableName}`,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = this.getDataGridHtml(data, tableName);
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
            <script>
                const data = ${JSON.stringify(data)};
                const columns = ${JSON.stringify(columns)};
                let currentPage = 1;
                const rowsPerPage = 50;
                let sortColumns = []; // Array of {columnIndex, direction} for multi-sort
                let filteredData = [...data];
                let columnFilters = {};

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
                    const start = (currentPage - 1) * rowsPerPage;
                    const end = start + rowsPerPage;
                    const pageData = filteredData.slice(start, end);
                    
                    tbody.innerHTML = pageData.map(row => {
                        return \`<tr>\${columns.map(col => {
                            const value = row[col];
                            let cellClass = '';
                            let formattedValue = '';
                            
                            if (value === null || value === undefined) {
                                cellClass = 'null';
                                formattedValue = 'null';
                            } else if (typeof value === 'boolean') {
                                cellClass = 'boolean';
                                formattedValue = value.toString();
                            } else if (typeof value === 'number') {
                                cellClass = 'number';
                                formattedValue = value.toLocaleString();
                            } else if (typeof value === 'string') {
                                cellClass = 'string';
                                formattedValue = value;
                            } else if (typeof value === 'object') {
                                try {
                                    formattedValue = JSON.stringify(value, null, 2);
                                } catch {
                                    formattedValue = '[Object]';
                                }
                            } else {
                                formattedValue = String(value);
                            }
                            
                            return \`<td class="\${cellClass}">\${formattedValue}</td>\`;
                        }).join('')}</tr>\`;
                    }).join('');
                    
                    const totalPages = Math.ceil(filteredData.length / rowsPerPage);
                    document.getElementById('pageInfo').textContent = \`Page \${currentPage} of \${totalPages}\`;
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
            return Promise.resolve(this.explorer.getConnections().map(connection => 
                new DatabaseTreeItem(connection, connection.name, vscode.TreeItemCollapsibleState.Expanded, 'connection')
            ));
        } else if (element.contextValue === 'connection') {
            return Promise.resolve(element.connection.tables.map((table: string) => 
                new DatabaseTreeItem(element.connection, table, vscode.TreeItemCollapsibleState.None, 'table')
            ));
        }
        return Promise.resolve([]);
    }
}
