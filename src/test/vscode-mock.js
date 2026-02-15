/**
 * Preload script that registers a minimal vscode mock into the module system.
 * Loaded via: node --require ./out/test/vscode-mock.js --test ...
 */

const Module = require('module');
const originalResolveFilename = Module._resolveFilename;

const vscodeShim = {
	window: {
		createOutputChannel: () => ({
			appendLine: () => {},
			show: () => {},
			dispose: () => {},
		}),
		showInformationMessage: () => {},
		showErrorMessage: () => {},
		showWarningMessage: () => {},
		showInputBox: () => Promise.resolve(undefined),
		showOpenDialog: () => Promise.resolve(undefined),
		showSaveDialog: () => Promise.resolve(undefined),
	},
	workspace: {
		getConfiguration: () => ({
			get: () => undefined,
			update: () => Promise.resolve(),
		}),
		fs: { writeFile: () => Promise.resolve() },
	},
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	TreeItem: class {},
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ThemeIcon: class { constructor(id) { this.id = id; } },
	EventEmitter: class {
		event = () => {};
		fire() {}
	},
	ConfigurationTarget: { Global: 1, Workspace: 2 },
	ViewColumn: { One: 1 },
	commands: { registerCommand: () => ({ dispose: () => {} }) },
};

// Intercept require('vscode') to return our shim
Module._resolveFilename = function (request, parent, isMain, options) {
	if (request === 'vscode') {
		// Return a fake path that we'll handle
		return 'vscode';
	}
	return originalResolveFilename.call(this, request, parent, isMain, options);
};

// Pre-populate the require cache with our shim
require.cache['vscode'] = {
	id: 'vscode',
	filename: 'vscode',
	loaded: true,
	exports: vscodeShim,
	parent: null,
	children: [],
	paths: [],
	path: '',
};
