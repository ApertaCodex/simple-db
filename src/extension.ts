import * as vscode from 'vscode';

// All other imports are dynamic to prevent activation failures
let loggerModule: typeof import('./logger') | null = null;
let DatabaseExplorerModule: typeof import('./DatabaseExplorer') | null = null;
let SQLiteManagerModule: typeof import('./SQLiteManager') | null = null;
let MongoDBManagerModule: typeof import('./MongoDBManager') | null = null;
let SQLiteEditorProviderModule: typeof import('./SQLiteEditorProvider') | null = null;

let sqliteManager: InstanceType<typeof import('./SQLiteManager').SQLiteManager> | undefined;
let mongoManager: InstanceType<typeof import('./MongoDBManager').MongoDBManager> | undefined;
let databaseExplorer: InstanceType<typeof import('./DatabaseExplorer').DatabaseExplorer> | undefined;
let treeDataProvider: ReturnType<InstanceType<typeof import('./DatabaseExplorer').DatabaseExplorer>['getProvider']> | undefined;
let extensionContext: vscode.ExtensionContext;

function getLogger() {
    if (!loggerModule) {
        loggerModule = require('./logger');
    }
    return loggerModule!.logger;
}

async function getManagers() {

    if (!SQLiteManagerModule) {
        SQLiteManagerModule = await import('./SQLiteManager');
    }
    if (!MongoDBManagerModule) {
        MongoDBManagerModule = await import('./MongoDBManager');
    }
    if (!DatabaseExplorerModule) {
        DatabaseExplorerModule = await import('./DatabaseExplorer');
    }

    if (!sqliteManager) {
        sqliteManager = new SQLiteManagerModule.SQLiteManager();
    }
    if (!mongoManager) {
        mongoManager = new MongoDBManagerModule.MongoDBManager();
    }
    if (!databaseExplorer) {
        databaseExplorer = new DatabaseExplorerModule.DatabaseExplorer(sqliteManager, mongoManager, extensionContext);
        treeDataProvider = databaseExplorer.getProvider();
        vscode.window.registerTreeDataProvider('databaseExplorer', treeDataProvider);
        // Refresh the tree view after registration to show any loaded connections
        treeDataProvider.refresh();
    }
    return { sqliteManager, mongoManager, databaseExplorer, treeDataProvider: treeDataProvider! };
}

export function activate(context: vscode.ExtensionContext) {
    // Store context for later use
    extensionContext = context;

    // Create a simple output channel for logging even if logger module fails
    const outputChannel = vscode.window.createOutputChannel('Simple DB');
    outputChannel.appendLine(`[${new Date().toISOString()}] Simple DB extension activating...`);

    try {
        const logger = getLogger();
        logger.info('Activating Simple DB extension...');
    } catch (e) {
        outputChannel.appendLine(`[${new Date().toISOString()}] Logger init failed: ${e}`);
    }

    // Handle opening SQLite files directly
    const openSQLiteFile = async (uri?: vscode.Uri | vscode.Uri[]) => {
        try {
            const { databaseExplorer } = await getManagers();
            let fileUri: vscode.Uri | undefined;

            if (Array.isArray(uri)) {
                fileUri = uri[0];
            } else if (uri) {
                fileUri = uri;
            }

            if (!fileUri) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor.document.uri.scheme === 'file') {
                    const fileName = activeEditor.document.fileName.toLowerCase();
                    if (fileName.endsWith('.db') || fileName.endsWith('.sqlite') || fileName.endsWith('.sqlite3') || fileName.endsWith('.db3')) {
                        fileUri = activeEditor.document.uri;
                    }
                }

                if (!fileUri) {
                    const selected = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        filters: { 'SQLite Database': ['db', 'sqlite', 'sqlite3', 'db3'] }
                    });
                    if (selected && selected[0]) {
                        fileUri = selected[0];
                    }
                }
            }

            if (fileUri) {
                await databaseExplorer.openSQLiteFile(fileUri.fsPath);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error opening SQLite file: ${error}`);
            outputChannel.appendLine(`[${new Date().toISOString()}] Error: ${error}`);
        }
    };

    // Register all commands - this MUST succeed for the extension to work
    const commands = [
        vscode.commands.registerCommand('simpleDB.addSQLite', async () => {
            try {
                const { databaseExplorer } = await getManagers();
                await databaseExplorer.addSQLite();
            } catch (error) {
                vscode.window.showErrorMessage(`Error adding SQLite database: ${error}`);
                outputChannel.appendLine(`[${new Date().toISOString()}] addSQLite error: ${error}`);
            }
        }),
        vscode.commands.registerCommand('simpleDB.addMongoDB', async () => {
            try {
                const { databaseExplorer } = await getManagers();
                await databaseExplorer.addMongoDB();
            } catch (error) {
                vscode.window.showErrorMessage(`Error adding MongoDB connection: ${error}`);
                outputChannel.appendLine(`[${new Date().toISOString()}] addMongoDB error: ${error}`);
            }
        }),
        vscode.commands.registerCommand('simpleDB.refresh', async () => {
            try {
                const { databaseExplorer, treeDataProvider } = await getManagers();
                const connections = databaseExplorer.getConnections();
                for (const connection of connections) {
                    await databaseExplorer.refreshTables(connection);
                }
                treeDataProvider.refresh();
            } catch (error) {
                vscode.window.showErrorMessage(`Error refreshing: ${error}`);
                outputChannel.appendLine(`[${new Date().toISOString()}] refresh error: ${error}`);
            }
        }),
        vscode.commands.registerCommand('simpleDB.removeConnection', async (item) => {
            try {
                const { databaseExplorer } = await getManagers();
                databaseExplorer.removeConnection(item);
            } catch (error) {
                vscode.window.showErrorMessage(`Error removing connection: ${error}`);
            }
        }),
        vscode.commands.registerCommand('simpleDB.viewData', async (item) => {
            try {
                const { databaseExplorer } = await getManagers();
                databaseExplorer.viewData(item);
            } catch (error) {
                vscode.window.showErrorMessage(`Error viewing data: ${error}`);
            }
        }),
        vscode.commands.registerCommand('simpleDB.openSQLiteFile', (uri) => {
            openSQLiteFile(uri);
        }),
        vscode.commands.registerCommand('simpleDB.openQueryConsole', async (item) => {
            try {
                const { databaseExplorer } = await getManagers();
                databaseExplorer.openQueryConsole(item);
            } catch (error) {
                vscode.window.showErrorMessage(`Error opening query console: ${error}`);
            }
        }),
        vscode.commands.registerCommand('simpleDB.exportToJSON', async (item) => {
            try {
                const { databaseExplorer } = await getManagers();
                databaseExplorer.exportToJSON(item);
            } catch (error) {
                vscode.window.showErrorMessage(`Error exporting to JSON: ${error}`);
            }
        }),
        vscode.commands.registerCommand('simpleDB.exportToCSV', async (item) => {
            try {
                const { databaseExplorer } = await getManagers();
                databaseExplorer.exportToCSV(item);
            } catch (error) {
                vscode.window.showErrorMessage(`Error exporting to CSV: ${error}`);
            }
        }),
        vscode.commands.registerCommand('simpleDB.importFromJSON', async (item) => {
            try {
                const { databaseExplorer } = await getManagers();
                databaseExplorer.importFromJSON(item);
            } catch (error) {
                vscode.window.showErrorMessage(`Error importing from JSON: ${error}`);
            }
        }),
        vscode.commands.registerCommand('simpleDB.importFromCSV', async (item) => {
            try {
                const { databaseExplorer } = await getManagers();
                databaseExplorer.importFromCSV(item);
            } catch (error) {
                vscode.window.showErrorMessage(`Error importing from CSV: ${error}`);
            }
        }),
        vscode.commands.registerCommand('simpleDB.showLogs', () => {
            outputChannel.show();
        })
    ];

    commands.forEach(command => context.subscriptions.push(command));
    context.subscriptions.push(outputChannel);

    // Register file handler
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(async (document) => {
            if (document.uri.scheme === 'file') {
                const fileName = document.fileName.toLowerCase();
                if (fileName.endsWith('.db') || fileName.endsWith('.sqlite') || fileName.endsWith('.sqlite3') || fileName.endsWith('.db3')) {
                    try {
                        const { databaseExplorer } = await getManagers();
                        const existingConnection = databaseExplorer.getConnections().find(
                            (conn: any) => conn.type === 'sqlite' && conn.path === document.uri.fsPath
                        );

                        if (!existingConnection) {
                            const config = vscode.workspace.getConfiguration('simpleDB');
                            if (config.get<boolean>('autoOpenSQLiteFiles', true)) {
                                await openSQLiteFile(document.uri);
                            }
                        }
                    } catch (error) {
                        outputChannel.appendLine(`[${new Date().toISOString()}] Auto-open error: ${error}`);
                    }
                }
            }
        })
    );

    // Register custom editor provider
    const registerEditor = async () => {
        try {
            if (!SQLiteEditorProviderModule) {
                SQLiteEditorProviderModule = await import('./SQLiteEditorProvider');
            }
            const editorProvider = new SQLiteEditorProviderModule.SQLiteEditorProvider(
                context,
                async (uri: vscode.Uri) => {
                    try {
                        const { databaseExplorer } = await getManagers();
                        await databaseExplorer.openSQLiteFile(uri.fsPath);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Error opening SQLite file: ${error}`);
                    }
                }
            );
            context.subscriptions.push(
                vscode.window.registerCustomEditorProvider(
                    SQLiteEditorProviderModule.SQLiteEditorProvider.viewType,
                    editorProvider,
                    { webviewOptions: { retainContextWhenHidden: true } }
                )
            );
        } catch (error) {
            outputChannel.appendLine(`[${new Date().toISOString()}] Editor provider error: ${error}`);
        }
    };
    registerEditor();

    // Initialize the tree view on activation to show any saved connections
    getManagers().catch(error => {
        outputChannel.appendLine(`[${new Date().toISOString()}] Tree view init error: ${error}`);
    });

    outputChannel.appendLine(`[${new Date().toISOString()}] Simple DB extension activated successfully`);
}

export function deactivate() {
    try {
        const logger = getLogger();
        logger.info('Simple DB extension deactivated');
        logger.dispose();
    } catch (e) {
        // Ignore
    }
}
