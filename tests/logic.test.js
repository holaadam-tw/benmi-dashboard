import { describe, it, expect } from 'vitest';
import {
  fmt, pct, parseCSV, getFileId, rowUniqueKey,
  clampMonth, calcProfit, calcMargin, calcRevenueChange,
  t, catLabel, invoiceSortComparator, isDeletedExpired,
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
