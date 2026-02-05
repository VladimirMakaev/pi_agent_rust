# Changelog

## [0.2.0] - 2025-01-07

### Changed
- **Breaking:** Complete rewrite to use native pi TUI instead of tmux
- No longer requires tmux or Bun runtime
- Canvases now render inline using `ctx.ui.custom()`

### Added
- `canvas_calendar` tool - Interactive calendar with week view and time slot selection
- `canvas_document` tool - Document viewer with navigation and text selection
- `canvas_flights` tool - Flight search results with comparison and selection
- `/calendar` command - Quick access to calendar view

### Removed
- tmux split pane spawning
- IPC via Unix sockets
- React/Ink canvas components
- CLI entry point

## [0.1.0] - 2025-01-07

### Added
- Initial port from claude-canvas
- tmux-based canvas spawning
- Calendar, document, and flight canvases
- IPC communication via Unix sockets
- Tools: canvas_spawn, canvas_update, canvas_query, canvas_close, canvas_list
- Command: /canvas
