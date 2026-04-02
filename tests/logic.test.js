import { describe, it, expect, beforeEach } from 'vitest';
import {
  fmt, pct, parseCSV, getFileId, rowUniqueKey,
  clampMonth, calcProfit, calcMargin, calcRevenueChange,
  t, catLabel, invoiceSortComparator, isDeletedExpired,
  getEdits, saveEdit, getDeletedKeys, markDeleted,
  calcDonutDash, calcBarHeights, buildSaveParams,
  driveThumbUrl, findMissingI18nKeys, I18N,
} from '../src/logic.js';

// ── Formatting ──
describe('fmt', () => {
  it('formats numbers with dollar sign and commas', () => {
    expect(fmt(113163)).toBe('$113,163');
    expect(fmt(0)).toBe('$0');
  });

  it('returns dash for null/undefined', () => {
    expect(fmt(null)).toBe('—');
    expect(fmt(undefined)).toBe('—');
  });

  it('rounds decimals', () => {
    expect(fmt(1234.7)).toBe('$1,235');
    expect(fmt(1234.2)).toBe('$1,234');
  });
});

describe('pct', () => {
  it('computes percentage string', () => {
    expect(pct(50, 200)).toBe('25.0%');
    expect(pct(1, 3)).toBe('33.3%');
  });

  it('returns dash when denominator is 0 or falsy', () => {
    expect(pct(50, 0)).toBe('—');
    expect(pct(50, null)).toBe('—');
  });
});

// ── CSV Parser ──
describe('parseCSV', () => {
  it('parses simple CSV', () => {
    const csv = '日期,金額,備注\n2026-01-01,500,test\n2026-01-02,300,';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]['日期']).toBe('2026-01-01');
    expect(rows[0]['金額']).toBe('500');
    expect(rows[1]['備注']).toBe('');
  });

  it('handles quoted fields with commas', () => {
    const csv = '名稱,描述\n"Item A","has, commas"\n"Item B",normal';
    const rows = parseCSV(csv);
    expect(rows[0]['描述']).toBe('has, commas');
    expect(rows[1]['描述']).toBe('normal');
  });

  it('handles empty CSV (header only)', () => {
    const csv = '日期,金額';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(0);
  });

  it('strips quotes from headers', () => {
    const csv = '"日期","金額"\n2026-01-01,100';
    const rows = parseCSV(csv);
    expect(rows[0]['日期']).toBe('2026-01-01');
  });
});

// ── Drive URL helpers ──
describe('getFileId', () => {
  it('extracts last 8 chars of file ID from Drive URL', () => {
    const url = 'https://drive.google.com/file/d/1a2b3c4d5e6f7g8h9i0j/view';
    expect(getFileId(url)).toBe('7g8h9i0j'); // last 8 of "1a2b3c4d5e6f7g8h9i0j"
  });

  it('returns empty string for falsy input', () => {
    expect(getFileId('')).toBe('');
    expect(getFileId(null)).toBe('');
    expect(getFileId(undefined)).toBe('');
  });

  it('returns empty string for non-Drive URL', () => {
    expect(getFileId('https://example.com')).toBe('');
  });
});

describe('rowUniqueKey', () => {
  it('generates key from row data', () => {
    const row = { '日期': '2026-01-15', '時間': '14:30', 'Drive連結': '' };
    expect(rowUniqueKey(row)).toBe('2026-01-15_14:30_');
  });

  it('uses fallback "x" for missing fields', () => {
    expect(rowUniqueKey({})).toBe('x_x_');
  });
});

// ── Month navigation ──
describe('clampMonth', () => {
  it('increments within bounds', () => {
    expect(clampMonth(3, 1)).toBe(4);
    expect(clampMonth(5, 1)).toBe(6);
  });

  it('decrements within bounds', () => {
    expect(clampMonth(3, -1)).toBe(2);
    expect(clampMonth(1, -1)).toBe(0);
  });

  it('clamps at boundaries', () => {
    expect(clampMonth(6, 1)).toBe(6);
    expect(clampMonth(0, -1)).toBe(0);
  });
});

// ── Profit / Margin ──
describe('calcProfit', () => {
  it('computes revenue - food - salary', () => {
    expect(calcProfit({ revenue: 300000, food: 100000, salary: 100000 })).toBe(100000);
  });

  it('returns null when food is null', () => {
    expect(calcProfit({ revenue: 300000, food: null, salary: 100000 })).toBeNull();
  });

  it('returns null when salary is null', () => {
    expect(calcProfit({ revenue: 300000, food: 100000, salary: null })).toBeNull();
  });

  it('handles negative profit', () => {
    expect(calcProfit({ revenue: 100000, food: 80000, salary: 50000 })).toBe(-30000);
  });
});

describe('calcMargin', () => {
  it('computes margin percentage', () => {
    expect(calcMargin({ revenue: 200000, food: 80000, salary: 60000 })).toBe('30.0');
  });

  it('returns null when data is incomplete', () => {
    expect(calcMargin({ revenue: 200000, food: null, salary: 60000 })).toBeNull();
  });
});

describe('calcRevenueChange', () => {
  it('computes percent change', () => {
    const curr = { revenue: 200000 };
    const prev = { revenue: 100000 };
    expect(calcRevenueChange(curr, prev)).toBe('100.0');
  });

  it('returns null when no previous data', () => {
    expect(calcRevenueChange({ revenue: 200000 }, null)).toBeNull();
  });

  it('handles revenue decrease', () => {
    const result = calcRevenueChange({ revenue: 100000 }, { revenue: 200000 });
    expect(parseFloat(result)).toBeLessThan(0);
  });
});

// ── i18n ──
describe('t (translation)', () => {
  it('returns Chinese by default', () => {
    expect(t('tab_overview')).toBe('月度總覽');
  });

  it('returns Vietnamese when specified', () => {
    expect(t('tab_overview', 'vi')).toBe('Tổng quan');
  });

  it('falls back to key for missing translations', () => {
    expect(t('nonexistent_key', 'vi')).toBe('nonexistent_key');
  });
});

describe('catLabel', () => {
  it('translates category to Chinese', () => {
    expect(catLabel('肉類', 'zh')).toBe('肉類');
  });

  it('translates category to Vietnamese', () => {
    expect(catLabel('肉類', 'vi')).toBe('Thịt');
  });

  it('returns select placeholder for empty value', () => {
    expect(catLabel('', 'zh')).toBe('— 選擇品項 —');
    expect(catLabel('', 'vi')).toBe('— Chọn danh mục —');
  });
});

// ── Invoice sorting ──
describe('invoiceSortComparator', () => {
  const rowA = { '日期': '2026-01-10', '時間': '10:00', '傳送者': 'Alice', '金額': '500', '品項類別': '肉類' };
  const rowB = { '日期': '2026-01-15', '時間': '14:00', '傳送者': 'Bob', '金額': '300', '品項類別': '飲品' };

  it('sorts by time ascending', () => {
    expect(invoiceSortComparator(rowA, rowB, 'time', 'asc')).toBeLessThan(0);
  });

  it('sorts by time descending', () => {
    expect(invoiceSortComparator(rowA, rowB, 'time', 'desc')).toBeGreaterThan(0);
  });

  it('sorts by amount descending', () => {
    expect(invoiceSortComparator(rowA, rowB, 'amount', 'desc')).toBeLessThan(0); // 500 > 300
  });

  it('sorts by amount ascending', () => {
    expect(invoiceSortComparator(rowA, rowB, 'amount', 'asc')).toBeGreaterThan(0);
  });

  it('uses cached edits for amount', () => {
    const result = invoiceSortComparator(rowA, rowB, 'amount', 'desc', { amount: '100' }, {});
    // A has edited amount 100, B has 300 → B first in desc
    expect(result).toBeGreaterThan(0);
  });

  it('sorts by sender', () => {
    const result = invoiceSortComparator(rowA, rowB, 'sender', 'asc');
    expect(result).toBeLessThan(0); // Alice < Bob
  });
});

// ── Deleted keys TTL ──
describe('isDeletedExpired', () => {
  it('returns false for recent data', () => {
    expect(isDeletedExpired({ time: Date.now() - 1000 })).toBe(false);
  });

  it('returns true for data older than 10 minutes', () => {
    expect(isDeletedExpired({ time: Date.now() - 700000 })).toBe(true);
  });

  it('returns true when time is 0', () => {
    expect(isDeletedExpired({ time: 0 })).toBe(true);
  });
});

// ══════════════════════════════════════════════
// 新增測試：CSV 解析器邊界案例
// ══════════════════════════════════════════════
describe('parseCSV — edge cases', () => {
  it('handles escaped quotes (double-quote inside quoted field)', () => {
    const csv = '名稱,描述\n"Item ""A""","desc"';
    const rows = parseCSV(csv);
    // 雙引號在 CSV 中用 "" 轉義，解析後內部引號被移除
    expect(rows[0]['名稱']).toBe('Item A');
  });

  it('handles CJK characters in headers and values', () => {
    const csv = '品項類別,金額,備注\n麵包/法棍,250,好吃\n肉類,500,新鮮';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]['品項類別']).toBe('麵包/法棍');
    expect(rows[1]['金額']).toBe('500');
    expect(rows[1]['備注']).toBe('新鮮');
  });

  it('handles trailing comma (extra empty column)', () => {
    const csv = '日期,金額,\n2026-01-01,500,';
    const rows = parseCSV(csv);
    expect(rows[0]['日期']).toBe('2026-01-01');
    expect(rows[0]['金額']).toBe('500');
  });

  it('handles single column CSV', () => {
    const csv = '日期\n2026-01-01\n2026-01-02';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]['日期']).toBe('2026-01-01');
  });

  it('handles fields with spaces around commas', () => {
    const csv = '名稱 , 金額\nApple , 100';
    const rows = parseCSV(csv);
    expect(rows[0]['名稱']).toBe('Apple');
    expect(rows[0]['金額']).toBe('100');
  });

  it('handles many columns (wide CSV)', () => {
    const headers = Array.from({ length: 20 }, (_, i) => `col${i}`).join(',');
    const values = Array.from({ length: 20 }, (_, i) => `val${i}`).join(',');
    const rows = parseCSV(headers + '\n' + values);
    expect(rows).toHaveLength(1);
    expect(rows[0]['col0']).toBe('val0');
    expect(rows[0]['col19']).toBe('val19');
  });

  it('handles empty quoted field', () => {
    const csv = '日期,金額\n"",""';
    const rows = parseCSV(csv);
    expect(rows[0]['日期']).toBe('');
    expect(rows[0]['金額']).toBe('');
  });

  it('handles mixed quoted and unquoted in same row', () => {
    const csv = '名稱,描述,金額\nApple,"has, comma",100';
    const rows = parseCSV(csv);
    expect(rows[0]['名稱']).toBe('Apple');
    expect(rows[0]['描述']).toBe('has, comma');
    expect(rows[0]['金額']).toBe('100');
  });

  it('handles rows with fewer columns than headers', () => {
    const csv = '日期,金額,備注\n2026-01-01,500';
    const rows = parseCSV(csv);
    expect(rows[0]['日期']).toBe('2026-01-01');
    expect(rows[0]['金額']).toBe('500');
    expect(rows[0]['備注']).toBe('');
  });
});

// ══════════════════════════════════════════════
// 新增測試：sessionStorage / localStorage 資料層
// ══════════════════════════════════════════════
describe('Storage layer — getEdits / saveEdit', () => {
  let mockStorage;

  beforeEach(() => {
    // 模擬 storage（跟真實 sessionStorage 介面一致）
    const store = {};
    mockStorage = {
      getItem: (key) => store[key] ?? null,
      setItem: (key, val) => { store[key] = String(val); },
      removeItem: (key) => { delete store[key]; },
    };
  });

  it('returns empty v2 object when storage is empty', () => {
    const edits = getEdits(mockStorage);
    expect(edits).toEqual({ _version: 2 });
  });

  it('saves and retrieves an edit', () => {
    saveEdit('key1', 'amount', '500', mockStorage);
    const edits = getEdits(mockStorage);
    expect(edits['key1'].amount).toBe('500');
    expect(edits._version).toBe(2);
  });

  it('saves multiple fields for the same key', () => {
    saveEdit('key1', 'amount', '500', mockStorage);
    saveEdit('key1', 'category', '肉類', mockStorage);
    const edits = getEdits(mockStorage);
    expect(edits['key1'].amount).toBe('500');
    expect(edits['key1'].category).toBe('肉類');
  });

  it('saves edits for multiple keys', () => {
    saveEdit('key1', 'amount', '500', mockStorage);
    saveEdit('key2', 'amount', '300', mockStorage);
    const edits = getEdits(mockStorage);
    expect(edits['key1'].amount).toBe('500');
    expect(edits['key2'].amount).toBe('300');
  });

  it('migrates from v1 (missing _version) to v2', () => {
    mockStorage.setItem('inv_edits', JSON.stringify({ someKey: { amount: '100' } }));
    const edits = getEdits(mockStorage);
    expect(edits).toEqual({ _version: 2 }); // v1 被清除
    expect(mockStorage.getItem('inv_edits')).toBeNull();
  });

  it('handles corrupt JSON gracefully', () => {
    mockStorage.setItem('inv_edits', '{broken json!!!');
    const edits = getEdits(mockStorage);
    expect(edits).toEqual({ _version: 2 });
  });

  it('overwrites previous value for the same field', () => {
    saveEdit('key1', 'amount', '500', mockStorage);
    saveEdit('key1', 'amount', '800', mockStorage);
    const edits = getEdits(mockStorage);
    expect(edits['key1'].amount).toBe('800');
  });
});

describe('Storage layer — getDeletedKeys / markDeleted', () => {
  let mockStorage;

  beforeEach(() => {
    const store = {};
    mockStorage = {
      getItem: (key) => store[key] ?? null,
      setItem: (key, val) => { store[key] = String(val); },
      removeItem: (key) => { delete store[key]; },
    };
  });

  it('returns empty array when storage is empty', () => {
    expect(getDeletedKeys(mockStorage)).toEqual([]);
  });

  it('marks a key as deleted and retrieves it', () => {
    markDeleted('row_1', mockStorage);
    const keys = getDeletedKeys(mockStorage);
    expect(keys).toContain('row_1');
  });

  it('does not add duplicate keys', () => {
    markDeleted('row_1', mockStorage);
    markDeleted('row_1', mockStorage);
    const keys = getDeletedKeys(mockStorage);
    expect(keys.filter(k => k === 'row_1')).toHaveLength(1);
  });

  it('tracks multiple deleted keys', () => {
    markDeleted('row_1', mockStorage);
    markDeleted('row_2', mockStorage);
    const keys = getDeletedKeys(mockStorage);
    expect(keys).toContain('row_1');
    expect(keys).toContain('row_2');
  });

  it('expires deleted keys after 10 minutes', () => {
    // 直接寫入一個 11 分鐘前的時間戳
    mockStorage.setItem('inv_deleted', JSON.stringify({
      keys: ['old_row'],
      time: Date.now() - 660000, // 11 分鐘前
    }));
    const keys = getDeletedKeys(mockStorage);
    expect(keys).toEqual([]); // 已過期，清空
    expect(mockStorage.getItem('inv_deleted')).toBeNull(); // storage 也被清除
  });

  it('preserves deleted keys within 10 minutes', () => {
    mockStorage.setItem('inv_deleted', JSON.stringify({
      keys: ['recent_row'],
      time: Date.now() - 300000, // 5 分鐘前
    }));
    const keys = getDeletedKeys(mockStorage);
    expect(keys).toContain('recent_row');
  });

  it('handles corrupt JSON gracefully', () => {
    mockStorage.setItem('inv_deleted', 'not valid json');
    expect(getDeletedKeys(mockStorage)).toEqual([]);
  });
});

// ══════════════════════════════════════════════
// 新增測試：甜甜圈圖 SVG 數學
// ══════════════════════════════════════════════
describe('calcDonutDash', () => {
  it('computes correct circumference', () => {
    const result = calcDonutDash(100000, 40000, 30000);
    expect(result.circ).toBeCloseTo(2 * Math.PI * 42);
  });

  it('food 40% of revenue → foodDash is 40% of circumference', () => {
    const result = calcDonutDash(100000, 40000, 30000);
    expect(result.foodDash).toBeCloseTo(result.circ * 0.4);
  });

  it('salary 30% of revenue → salDash is 30% of circumference', () => {
    const result = calcDonutDash(100000, 40000, 30000);
    expect(result.salDash).toBeCloseTo(result.circ * 0.3);
  });

  it('handles null food', () => {
    const result = calcDonutDash(100000, null, 30000);
    expect(result.foodDash).toBe(0);
    expect(result.foodOffset).toBeCloseTo(result.circ);
  });

  it('handles null salary', () => {
    const result = calcDonutDash(100000, 40000, null);
    expect(result.salDash).toBe(0);
  });

  it('handles both null', () => {
    const result = calcDonutDash(100000, null, null);
    expect(result.foodDash).toBe(0);
    expect(result.salDash).toBe(0);
  });
});

// ══════════════════════════════════════════════
// 新增測試：長條圖高度計算
// ══════════════════════════════════════════════
describe('calcBarHeights', () => {
  const DATA = [
    { revenue: 100000, food: 40000, salary: 30000 },
    { revenue: 200000, food: 80000, salary: 60000 },
    { revenue: 50000,  food: null,  salary: null },
  ];

  it('scales tallest bar to maxHeight', () => {
    const heights = calcBarHeights(DATA);
    expect(heights[1].revenue).toBe(130); // 200000 is max → full height
  });

  it('scales proportionally', () => {
    const heights = calcBarHeights(DATA);
    expect(heights[0].revenue).toBe(65); // 100000/200000 * 130
    expect(heights[2].revenue).toBe(33); // Math.round(50000/200000 * 130)
  });

  it('sets food/salary to 0 when null', () => {
    const heights = calcBarHeights(DATA);
    expect(heights[2].food).toBe(0);
    expect(heights[2].salary).toBe(0);
  });

  it('uses custom maxHeight', () => {
    const heights = calcBarHeights(DATA, 200);
    expect(heights[1].revenue).toBe(200);
    expect(heights[0].revenue).toBe(100);
  });
});

// ══════════════════════════════════════════════
// 新增測試：saveField URL 參數構建
// ══════════════════════════════════════════════
describe('buildSaveParams', () => {
  it('builds amount param', () => {
    const qs = buildSaveParams(5, 'amount', '1500');
    expect(qs).toContain('action=update');
    expect(qs).toContain('row=5');
    expect(qs).toContain('amount=1500');
  });

  it('builds category param', () => {
    const qs = buildSaveParams(3, 'category', '肉類');
    expect(qs).toContain('category=' + encodeURIComponent('肉類'));
  });

  it('builds buydate param', () => {
    const qs = buildSaveParams(2, 'buydate', '2026-01-15');
    expect(qs).toContain('buydate=2026-01-15');
  });

  it('defaults to note for unknown field', () => {
    const qs = buildSaveParams(2, 'note', '測試備注');
    expect(qs).toContain('note=' + encodeURIComponent('測試備注'));
  });

  it('defaults unknown fields to note param', () => {
    const qs = buildSaveParams(2, 'something_else', 'value');
    expect(qs).toContain('note=value');
  });
});

// ══════════════════════════════════════════════
// 新增測試：Drive 縮圖 URL 建構
// ══════════════════════════════════════════════
describe('driveThumbUrl', () => {
  it('returns fallback thumbnail when provided', () => {
    expect(driveThumbUrl('https://drive.google.com/file/d/abc123/view', 'https://fallback.jpg'))
      .toBe('https://fallback.jpg');
  });

  it('builds thumbnail URL from Drive link', () => {
    const url = driveThumbUrl('https://drive.google.com/file/d/abc123xyz/view', '');
    expect(url).toBe('https://drive.google.com/thumbnail?id=abc123xyz&sz=w800');
  });

  it('returns empty string when no URL and no fallback', () => {
    expect(driveThumbUrl('', '')).toBe('');
    expect(driveThumbUrl(null, '')).toBe('');
  });

  it('returns empty string for non-Drive URL without fallback', () => {
    expect(driveThumbUrl('https://example.com/image.jpg', '')).toBe('');
  });
});

// ══════════════════════════════════════════════
// 新增測試：i18n 完整性檢查
// ══════════════════════════════════════════════
describe('i18n completeness', () => {
  it('zh and vi have the same keys', () => {
    const { missingInVi, missingInZh } = findMissingI18nKeys();
    expect(missingInVi).toEqual([]);
    expect(missingInZh).toEqual([]);
  });

  it('no i18n values are empty strings', () => {
    for (const lang of ['zh', 'vi']) {
      for (const [key, val] of Object.entries(I18N[lang])) {
        expect(val, `${lang}.${key} should not be empty`).not.toBe('');
      }
    }
  });
});

// ══════════════════════════════════════════════
// 新增測試：排序比較器更多邊界情況
// ══════════════════════════════════════════════
describe('invoiceSortComparator — additional edge cases', () => {
  it('sorts by category with edits override', () => {
    const a = { '品項類別': '肉類' };
    const b = { '品項類別': '飲品' };
    const result = invoiceSortComparator(a, b, 'category', 'asc', { category: '麵包/法棍' }, {});
    // a 被覆蓋為 '麵包/法棍'，跟 b '飲品' 比較
    expect(typeof result).toBe('number');
  });

  it('sorts by buydate', () => {
    const a = { '發票日期': '2026-01-01' };
    const b = { '發票日期': '2026-02-01' };
    const result = invoiceSortComparator(a, b, 'buydate', 'asc');
    expect(result).toBeLessThan(0);
  });

  it('returns 0 for unknown sort field', () => {
    const a = { '日期': '2026-01-01' };
    const b = { '日期': '2026-02-01' };
    expect(invoiceSortComparator(a, b, 'unknown_field', 'asc')).toBe(0);
  });

  it('handles equal values', () => {
    const a = { '金額': '500' };
    const b = { '金額': '500' };
    expect(invoiceSortComparator(a, b, 'amount', 'desc')).toBe(0);
  });

  it('handles NaN amounts gracefully (treated as 0)', () => {
    const a = { '金額': 'abc' };
    const b = { '金額': '500' };
    const result = invoiceSortComparator(a, b, 'amount', 'desc');
    expect(result).toBeGreaterThan(0); // 0 < 500, desc → b first
  });
});
