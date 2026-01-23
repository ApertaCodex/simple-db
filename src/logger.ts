import * as vscode from 'vscode';

class Logger {
    private static instance: Logger;
    private outputChannel: vscode.OutputChannel;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Simple DB');
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    public info(message: string, ...args: any[]): void {
        const formattedMessage = this.formatMessage('INFO', message, args);
        this.outputChannel.appendLine(formattedMessage);
        console.log(formattedMessage);
    }

    public warn(message: string, ...args: any[]): void {
        const formattedMessage = this.formatMessage('WARN', message, args);
        this.outputChannel.appendLine(formattedMessage);
        console.warn(formattedMessage);
    }

    public error(message: string, error?: any, ...args: any[]): void {
        const formattedMessage = this.formatMessage('ERROR', message, args);
        this.outputChannel.appendLine(formattedMessage);
        if (error) {
            const errorDetails = error instanceof Error 
                ? `${error.message}\n${error.stack}` 
                : JSON.stringify(error);
            this.outputChannel.appendLine(`  Details: ${errorDetails}`);
            console.error(formattedMessage, error);
        } else {
            console.error(formattedMessage);
        }
    }

    public debug(message: string, ...args: any[]): void {
        const formattedMessage = this.formatMessage('DEBUG', message, args);
        this.outputChannel.appendLine(formattedMessage);
        console.debug(formattedMessage);
    }

    public show(): void {
        this.outputChannel.show();
    }

    public dispose(): void {
        this.outputChannel.dispose();
    }

    private formatMessage(level: string, message: string, args: any[]): string {
        const timestamp = new Date().toISOString();
        const argsStr = args.length > 0 ? ` ${JSON.stringify(args)}` : '';
        return `[${timestamp}] [${level}] ${message}${argsStr}`;
    }
}

export const logger = Logger.getInstance();
