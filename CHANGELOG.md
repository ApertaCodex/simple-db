# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.3] - 2026-03-06

### Fixed
- fix pagination not advancing past page 1 in webview mode ([#1](https://github.com/ApertaCodex/simple-db/issues/1))

## [3.0.2]

### Changed
- update version to 3.0.2 (0a734b9)

### Added
- add edit mode styles and functionality (285222b)
- track total database rows (52bc9ef)

## [0.0.164] - 2024-12-24

### Added
- Database icon for marketplace listing
- 3 professional screenshots showcasing features
- Enhanced README with badges and better documentation
- Categories and keywords for improved discoverability

### Improved
- Smart filter UI with search button icon
- Date filters now support ranges and comparison operators
- Number filters support multiple operator types
- Filter help text shows supported operators

## [0.0.163] - 2024-12-24

### Added
- Smart filtering system with operator support
- Number filters: `>`, `<`, `>=`, `<=`, `=`, `!=`, ranges
- Date filters: comparison operators and date ranges
- Filter submission via Enter key or button click
- Per-column filter inputs with type detection

### Improved
- Filter UI with dedicated input fields per column
- Better filter user experience with visual feedback

## [0.0.1] - Initial Release

### Added
- SQLite database support (.db, .sqlite, .sqlite3)
- MongoDB connection support
- Interactive data grid with pagination
- Column sorting (ascending/descending)
- Global search across all columns
- Tree view explorer for databases and tables
- Persistent connection storage
- Auto-open SQLite files on click
- Syntax highlighting for different data types

