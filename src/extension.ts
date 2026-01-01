import * as vscode from 'vscode';
import { DatabaseExplorer } from './DatabaseExplorer';
import { SQLiteManager } from './SQLiteManager';
import { MongoDBManager } from './MongoDBManager';

export function activate(context: vscode.ExtensionContext) {
    try {
        const sqliteManager = new SQLiteManager();
        const mongoManager = new MongoDBManager();
        const databaseExplorer = new DatabaseExplorer(sqliteManager, mongoManager);

        const treeDataProvider = databaseExplorer.getProvider();
        vscode.window.registerTreeDataProvider('databaseExplorer', treeDataProvider);

        // Handle opening SQLite files directly
        const openSQLiteFile = async (uri?: vscode.Uri | vscode.Uri[]) => {
            let fileUri: vscode.Uri | undefined;
            
            // Handle array of URIs (from context menu with multiple files)
            if (Array.isArray(uri)) {
                fileUri = uri[0];
            } else if (uri) {
                fileUri = uri;
            }
            
            // If no URI provided, get from active editor or show file picker
            if (!fileUri) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor.document.uri.scheme === 'file') {
                    const fileName = activeEditor.document.fileName.toLowerCase();
                    if (fileName.endsWith('.db') || fileName.endsWith('.sqlite') || fileName.endsWith('.sqlite3')) {
                        fileUri = activeEditor.document.uri;
                    }
                }
                
                if (!fileUri) {
                    const selected = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        filters: { 'SQLite Database': ['db', 'sqlite', 'sqlite3'] }
                    });
                    if (selected && selected[0]) {
                        fileUri = selected[0];
                    }
                }
            }
            
            if (fileUri) {
                await databaseExplorer.openSQLiteFile(fileUri.fsPath);
            }
        };

        const commands = [
            vscode.commands.registerCommand('simpleDB.addSQLite', async () => {
                try {
                    await databaseExplorer.addSQLite();
                } catch (error) {
                    vscode.window.showErrorMessage(`Error adding SQLite database: ${error}`);
                }
            }),
            vscode.commands.registerCommand('simpleDB.addMongoDB', async () => {
                try {
                    await databaseExplorer.addMongoDB();
                } catch (error) {
                    vscode.window.showErrorMessage(`Error adding MongoDB connection: ${error}`);
                }
            }),
            vscode.commands.registerCommand('simpleDB.refresh', async () => {
                try {
                    // Auto-refresh tables/collections for all connections
                    const connections = databaseExplorer.getConnections();
                    for (const connection of connections) {
                        await databaseExplorer.refreshTables(connection);
                    }
                    treeDataProvider.refresh();
                } catch (error) {
                    vscode.window.showErrorMessage(`Error refreshing: ${error}`);
                }
            }),
            vscode.commands.registerCommand('simpleDB.removeConnection', (item) => {
                try {
                    databaseExplorer.removeConnection(item);
                } catch (error) {
                    vscode.window.showErrorMessage(`Error removing connection: ${error}`);
                }
            }),
            vscode.commands.registerCommand('simpleDB.viewData', (item) => {
                try {
                    databaseExplorer.viewData(item);
                } catch (error) {
                    vscode.window.showErrorMessage(`Error viewing data: ${error}`);
                }
            }),
            vscode.commands.registerCommand('simpleDB.openSQLiteFile', (uri) => {
                try {
                    openSQLiteFile(uri);
                } catch (error) {
                    vscode.window.showErrorMessage(`Error opening SQLite file: ${error}`);
                }
            }),
            vscode.commands.registerCommand('simpleDB.openQueryConsole', (item) => {
                try {
                    databaseExplorer.openQueryConsole(item);
                } catch (error) {
                    vscode.window.showErrorMessage(`Error opening query console: ${error}`);
                }
            })
        ];

        commands.forEach(command => context.subscriptions.push(command));

        // Register file handler for .db, .sqlite, .sqlite3 files
        // Note: Binary files may not trigger onDidOpenTextDocument, but this handles text-like opens
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(async (document) => {
                if (document.uri.scheme === 'file') {
                    const fileName = document.fileName.toLowerCase();
                    if (fileName.endsWith('.db') || fileName.endsWith('.sqlite') || fileName.endsWith('.sqlite3')) {
                        // Check if this file is already in connections
                        const existingConnection = databaseExplorer.getConnections().find(
                            (conn: any) => conn.type === 'sqlite' && conn.path === document.uri.fsPath
                        );
                        
                        if (!existingConnection) {
                            // Auto-open SQLite files when they're opened in the editor
                            const config = vscode.workspace.getConfiguration('simpleDB');
                            if (config.get<boolean>('autoOpenSQLiteFiles', true)) {
                                // Silently add the database
                                await openSQLiteFile(document.uri);
                            }
                        }
                    }
                }
            })
        );
        
        console.log('Simple DB extension activated successfully');
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to activate Simple DB extension: ${error}`);
        console.error('Extension activation error:', error);
    }
}

export function deactivate() {}
