# Simple DB

[![Version](https://img.shields.io/visual-studio-marketplace/v/apertacodex.simple-db?style=flat-square&label=Version)](https://marketplace.visualstudio.com/items?itemName=apertacodex.simple-db)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/apertacodex.simple-db?style=flat-square&label=Installs)](https://marketplace.visualstudio.com/items?itemName=apertacodex.simple-db)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/apertacodex.simple-db?style=flat-square&label=Rating)](https://marketplace.visualstudio.com/items?itemName=apertacodex.simple-db)
[![License](https://img.shields.io/github/license/ApertaCodex/simple-db?style=flat-square&label=License)](https://github.com/ApertaCodex/simple-db/blob/master/LICENSE)

A powerful VS Code extension for viewing, filtering, and exploring SQLite and MongoDB databases with an intuitive interface and smart filtering capabilities.

## ✨ Features

- **SQLite Support**: Connect to SQLite database files (.db, .sqlite, .sqlite3)
- **MongoDB Support**: Connect to MongoDB instances using connection strings
- **Smart Filters**:
  - **Numbers**: Use operators like `>100`, `<50`, `>=10`, `<=20`, `10-20` (range)
  - **Dates**: Filter with `>2024-01-01`, `<2024-12-31`, `2024-01-01 to 2024-12-31` (range)
  - **Text**: Simple substring matching
- **Interactive Data Grid**:
  - Click column headers to sort
  - Per-column filtering with search icon
  - Pagination for large datasets
  - Syntax-highlighted values (numbers, strings, booleans, null)
- **Tree View Explorer**: Browse databases and their tables/collections in the sidebar
- **Persistent Connections**: Automatically save and restore database connections
- **Auto-Open SQLite Files**: Automatically detect and open .db files when clicked

## 📸 Screenshots

### Database Explorer
![Database Explorer](screenshots/explorer.png)
*Database Explorer sidebar with connections and table tree view*

### Data Grid and Filtering
![Data Grid View](screenshots/data-grid.png)
*Interactive data grid with sorting and filtering*

![Number Filter](screenshots/number-filter.png)
*Smart filtering for number columns with operators*

![Date Filter](screenshots/date-filter.png)
*Date filtering with ranges and comparison operators*

### Query Features
![Sample Queries](screenshots/sample-queries-dropdown.png)
*Predefined sample queries for quick database exploration*

![AI Query Dialog](screenshots/ai-query-dialog.png)
*AI-powered natural language query interface*

![SQL Query Execution](screenshots/sql-query-execution.png)
*SQL query editor with execution interface*

![SQL Query Results](screenshots/sql-query-results.png)
*Query results displaying aggregated data*

### Advanced Filtering
![Column Filter Menu](screenshots/column-filter-menu.png)
*Column-specific filter menu*

![Column Filter Options](screenshots/column-filter-options.png)
*Available filter types and options*

![Column Sorting](screenshots/column-sorting.png)
*Multi-column sorting capabilities*

## 🚀 Installation

Install from the VS Code Marketplace:
```
ext install apertacodex.simple-db
```

Or search for "Simple DB" in the Extensions view (Ctrl+Shift+X).

## 📖 Usage

### Adding Database Connections

1. Open the **Database Explorer** in the VS Code sidebar (database icon)
2. Click the **database icon** (➕) to add a SQLite database
3. Click the **server icon** to add a MongoDB connection
4. Or simply **open any .db file** - it will be added automatically!

### Viewing and Filtering Data

1. **Expand** a database connection in the explorer
2. **Click** on a table/collection to view its data
3. **Click the filter icon** (🔍) on any column header to filter:
   - **For numbers**: Type `>100`, `<50`, `>=10`, `10-20`, etc.
   - **For dates**: Type `>2024-01-01`, `2024-01-01 to 2024-12-31`, etc.
   - **For text**: Type any substring to search
4. **Press Enter** or click the **🔍 button** to apply the filter
5. **Click column headers** to sort ascending/descending
6. Use **pagination controls** at the bottom to navigate large datasets

### Filter Examples

**Number Filters:**
- `>100` - Greater than 100
- `<50` - Less than 50
- `>=10` - Greater than or equal to 10
- `10-20` - Between 10 and 20 (range)
- `!=5` - Not equal to 5

**Date Filters:**
- `>2024-01-01` - After January 1, 2024
- `<2024-12-31` - Before December 31, 2024
- `2024-01-01 to 2024-12-31` - Date range
- `2024-06` - Contains "2024-06" (partial match)

## Configuration

The extension stores database connections in VS Code settings under `simpleDB.connections`.

## Dependencies

- **sqlite3**: SQLite database driver
- **mongoose**: MongoDB object modeling tool

## Development

- `npm run compile`: Compile TypeScript to JavaScript
- `npm run watch`: Watch for changes and recompile automatically

## 📝 Changelog

See [CHANGELOG.md](CHANGELOG.md) for all notable changes.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Feel free to submit issues and pull requests on [GitHub](https://github.com/ApertaCodex/simple-db).

## 💬 Support

If you encounter any issues or have suggestions, please [open an issue](https://github.com/ApertaCodex/simple-db/issues) on GitHub.
