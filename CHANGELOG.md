# Changelog

## [Unreleased]

### Bug Fixes (UX)

- Escape HTML in email list and detail rendering (subject, from, to, cc, folder)
- Reset active tab when switching emails
- Fix double file-picker invocation in Import modal
- Fix 'Move to folder' dropdown missing user-created folders (now loaded on page load)
- Fix selectAll checkbox de-sync after list re-render and added selected-count label
- Fix pagination offset corruption after auto-refresh
- Fix mixed-language string 'Neznámý' → 'Unknown'
- Add toast notification after moving an email to a folder

### Security

- XSS: escape folder names in renderFolders() onclick and display
- XSS: escape error.message in innerHTML error blocks
- XSS: escape folder names in folder filter `<option>` elements
- XSS: use JSON.stringify for values inside onclick JS string literals (single-quote escape bypass)
- HTTP Header Injection: sanitize attachment filename in Content-Disposition header
- Path Traversal: validate folder name in DELETE /api/folders/:name endpoint
