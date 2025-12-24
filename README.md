# Database Viewer VS Code Extension

A VS Code extension that allows you to easily connect to SQLite and MongoDB databases, view data, sort, and filter rows.

## Features

- **SQLite Support**: Connect to SQLite database files (.db, .sqlite, .sqlite3)
- **MongoDB Support**: Connect to MongoDB instances using connection strings
- **Data Grid View**: Interactive data grid with sorting and filtering capabilities
- **Tree View Explorer**: Browse databases and their tables/collections in the explorer
- **Persistent Connections**: Save database connections in VS Code settings

## Installation

1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build the extension
4. Open the directory in VS Code
5. Press F5 to launch the extension in a new Extension Development Host window

## Usage

### Adding Database Connections

1. Open the Database Explorer in the VS Code sidebar
2. Click the "Add SQLite Database" button to connect to SQLite files
3. Click the "Add MongoDB Connection" button to connect to MongoDB instances

### Viewing Data

1. Expand a database connection in the explorer
2. Click on a table/collection to view its data
3. Use the search box to filter data
4. Click column headers to sort data
5. Navigate through pages using the pagination controls

## Configuration

The extension stores database connections in VS Code settings under `databaseViewer.connections`.

## Dependencies

- **sqlite3**: SQLite database driver
- **mongoose**: MongoDB object modeling tool

## Development

- `npm run compile`: Compile TypeScript to JavaScript
- `npm run watch`: Watch for changes and recompile automatically
