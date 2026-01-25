import * as vscode from 'vscode';

export class SQLiteEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'simpleDB.sqliteEditor';

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly openSQLiteFileCallback: (uri: vscode.Uri) => Promise<void>
    ) {}

    public async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        // Open the SQLite file using the existing functionality
        await this.openSQLiteFileCallback(uri);

        // Focus the Simple DB sidebar
        await vscode.commands.executeCommand('databaseExplorer.focus');

        // Close the editor tab after opening in sidebar
        setTimeout(() => {
            vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }, 200);

        return {
            uri,
            dispose: () => {}
        };
    }

    public async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Show a simple message in the webview
        webviewPanel.webview.options = {
            enableScripts: true
        };

        webviewPanel.webview.html = this.getHtmlContent(document.uri);
    }

    private getHtmlContent(uri: vscode.Uri): string {
        const fileName = uri.fsPath.split(/[\\/]/).pop() || 'database';
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>SQLite Database</title>
                <style>
                    body {
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                        padding: 20px;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                    }
                    .message {
                        text-align: center;
                    }
                    .icon {
                        font-size: 48px;
                        margin-bottom: 16px;
                    }
                    h1 {
                        font-size: 18px;
                        font-weight: 600;
                        margin: 0 0 8px 0;
                    }
                    p {
                        font-size: 14px;
                        opacity: 0.8;
                        margin: 0;
                    }
                </style>
            </head>
            <body>
                <div class="message">
                    <div class="icon">🗄️</div>
                    <h1>${fileName}</h1>
                    <p>View database in the Simple DB sidebar</p>
                </div>
            </body>
            </html>
        `;
    }
}
