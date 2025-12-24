import * as vscode from 'vscode';

export interface DatabaseItem {
    name: string;
    type: 'sqlite' | 'mongodb';
    path: string;
    tables: string[];
}

export class DatabaseTreeItem extends vscode.TreeItem {
    constructor(
        public readonly connection: DatabaseItem,
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string
    ) {
        super(label, collapsibleState);
        this.tooltip = `${this.connection.name} - ${this.label}`;
        this.contextValue = contextValue;
        
        if (contextValue === 'connection') {
            this.iconPath = new vscode.ThemeIcon(this.connection.type === 'sqlite' ? 'database' : 'server');
        } else {
            this.iconPath = new vscode.ThemeIcon('table');
        }
    }
}
