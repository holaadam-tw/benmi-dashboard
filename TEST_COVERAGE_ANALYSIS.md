# Test Coverage Analysis — Benmi Dashboard

## Current State

The project is a **single-file vanilla JS dashboard** (`index.html`, ~1,300 lines) with embedded CSS, HTML, and JavaScript. Prior to this analysis, it had **zero test coverage** — no test framework, no test files, no `package.json`.

## What We've Added

- **Test framework**: Vitest + jsdom
- **Extracted module**: `src/logic.js` — pure functions mirrored from `index.html`
- **Initial test suite**: `tests/logic.test.js` — 41 tests covering core logic

### Functions Now Tested

| Function | Category | Tests |
|---|---|---|
| `fmt()` | Formatting | 3 |
| `pct()` | Formatting | 2 |
| `parseCSV()` | Data parsing | 4 |
| `getFileId()` | URL helpers | 3 |
| `rowUniqueKey()` | Data identity | 2 |
| `clampMonth()` | Navigation | 3 |
| `calcProfit()` | Financial calc | 4 |
| `calcMargin()` | Financial calc | 2 |
| `calcRevenueChange()` | Financial calc | 3 |
| `t()` | i18n | 3 |
| `catLabel()` | i18n | 3 |
| `invoiceSortComparator()` | Sorting | 6 |
| `isDeletedExpired()` | TTL logic | 3 |

---

## Coverage Gaps & Recommended Improvements

### 1. **CSV Parser Edge Cases** (High Priority)
The `parseCSV()` function is the primary data ingestion point from Google Sheets. It should be tested against:
- Fields with embedded newlines inside quotes
- Fields with escaped quotes (`""`)
- Trailing commas / extra columns
- Unicode content (CJK characters in headers/values)
- Malformed CSV (mismatched quotes)
- Very large inputs (performance)

### 2. **Invoice Upload Flow** (High Priority)
`uploadFiles()` is the most complex async function — file reading, hashing, base64 encoding, API calls, and DOM updates. Currently untested because it mixes I/O with business logic. Recommended:
- Extract hash computation into a testable wrapper
- Mock `fetch()` to test upload success, duplicate, and error paths
- Test `insertPendingRow()` DOM output with jsdom

### 3. **Session/Local Storage Layer** (High Priority)
`getEdits()`, `saveEdit()`, `getDeletedKeys()`, `markDeleted()` manage critical state:
- Test version migration (v1 → v2 format)
- Test TTL expiration for deleted keys (the 10-minute window)
- Test corrupt/invalid JSON in storage
- Test concurrent edits overwriting each other

### 4. **Invoice Table Rendering** (Medium Priority)
`renderInvoiceTable()` is ~80 lines of DOM construction with inline event handlers. It combines filtering, sorting, edit overlays, and HTML generation. Recommended:
- Test that deleted rows are filtered out
- Test that cached edits override original values
- Test sort order is applied correctly
- Test XSS vectors in user-supplied data (sender names, notes)

### 5. **Lightbox / Image Viewer** (Medium Priority)
`openLightbox()`, `lbZoom()`, `lbFitImage()`, `lbReset()` have zoom math that could regress:
- Test zoom scale clamping (0.1–10x range)
- Test fit-to-viewport calculation
- Test Drive URL → embed URL conversion
- Test drag boundary clamping (window stays on-screen)

### 6. **Financial Calculations — Donut Chart** (Medium Priority)
The donut chart SVG logic computes `strokeDashoffset` and `strokeDasharray` from food/salary percentages. These are easy to get wrong:
- Test circle math: `circ = 2π × 42`, dash values for various data
- Test edge case when food or salary is null/zero

### 7. **`saveField()` — Backend Sync** (Medium Priority)
This function builds URL params and calls the Google Apps Script endpoint. Risks:
- SQL/command injection via field values (currently uses `no-cors`, but still)
- Race conditions if multiple saves fire rapidly
- Test the field-name mapping logic (`amount` → `amount`, etc.)

### 8. **i18n Completeness** (Low Priority)
- Test that every key in `zh` has a corresponding key in `vi`
- Test `setLang()` updates all `[data-i18n]` DOM elements
- Test that category values stored are always in Chinese (for Sheets compatibility)

### 9. **`deleteRow()` — Deletion Flow** (Medium Priority)
- Test confirm dialog cancellation
- Test optimistic UI (row fades out)
- Test error rollback (row restores on fetch failure)
- Test that `markDeleted()` persists the key

### 10. **Bar Chart Rendering** (Low Priority)
`updateBarChart()` dynamically builds bar elements:
- Test bar height scaling relative to max revenue
- Test that current month is visually highlighted
- Test handling of zero or null revenue months

---

## Architectural Recommendation

The biggest barrier to comprehensive testing is that **all logic lives in a single `<script>` block in `index.html`**, mixing pure computation with DOM manipulation and API calls. To reach meaningful coverage:

1. **Extract pure logic** into `src/logic.js` (started — this PR)
2. **Extract DOM helpers** into `src/dom.js` (functions that take data and return HTML strings)
3. **Extract API calls** into `src/api.js` (fetch wrappers that can be mocked)
4. **Import modules** in `index.html` via `<script type="module">`

This separation would unlock testing ~80% of the codebase without needing a full browser environment.

---

## Running Tests

```bash
npm test              # Run all tests once
npm run test:watch    # Watch mode during development
npm run test:coverage # Generate coverage report
```
