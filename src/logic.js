/**
 * Extracted pure-logic functions from index.html for testability.
 * These mirror the functions embedded in the dashboard's <script> block.
 */

// ── Formatting helpers ──
export const fmt = n => n == null ? '—' : '$' + Math.round(n).toLocaleString();
export const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';

// ── CSV parser ──
export function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = []; let cur = '', inQ = false;
    for (let c of line) {
      if (c === '"') inQ = !inQ;
      else if (c === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || '').replace(/^"|"$/g, ''));
    return obj;
  });
}

// ── Drive URL helpers ──
export function getFileId(driveUrl) {
  if (!driveUrl) return '';
  const m = driveUrl.match(/\/d\/([^\/\?]+)/);
  return m ? m[1].slice(-8) : '';
}

export function rowUniqueKey(r) {
  return (r['日期'] || 'x') + '_' + (r['時間'] || 'x') + '_' + getFileId(r['Drive連結']);
}

// ── Month navigation logic ──
export function clampMonth(current, dir, min = 0, max = 6) {
  return Math.max(min, Math.min(max, current + dir));
}

// ── Profit / margin calculations ──
export function calcProfit(data) {
  if (data.food != null && data.salary != null) {
    return data.revenue - data.food - data.salary;
  }
  return null;
}

export function calcMargin(data) {
  const profit = calcProfit(data);
  if (profit != null) {
    return (profit / data.revenue * 100).toFixed(1);
  }
  return null;
}

export function calcRevenueChange(current, previous) {
  if (!previous) return null;
  return ((current.revenue - previous.revenue) / previous.revenue * 100).toFixed(1);
}

// ── i18n ──
export const I18N = {
  zh: {
    tab_overview: '月度總覽', tab_purchase: '採購發票', tab_salary: '薪資工時', tab_products: '商品業績',
    select_cat: '— 選擇品項 —',
    cat_bread: '麵包/法棍', cat_meat: '肉類', cat_veg: '蔬菜/配料', cat_sauce: '醬料/調味',
    cat_drink: '飲品', cat_pack: '包材', cat_dairy: '乳製品', cat_other: '其他',
    ph_amount: '填入', ph_note: '備注', ph_pending: '待填入',
  },
  vi: {
    tab_overview: 'Tổng quan', tab_purchase: 'Hóa đơn', tab_salary: 'Lương & giờ', tab_products: 'Doanh thu',
    select_cat: '— Chọn danh mục —',
    cat_bread: 'Bánh mì', cat_meat: 'Thịt', cat_veg: 'Rau/Gia vị', cat_sauce: 'Nước chấm/Sốt',
    cat_drink: 'Đồ uống', cat_pack: 'Bao bì', cat_dairy: 'Sữa/Phô mai', cat_other: 'Khác',
    ph_amount: 'Nhập', ph_note: 'Ghi chú', ph_pending: 'Chưa nhập',
  }
};

export function t(key, lang = 'zh') {
  return (I18N[lang] && I18N[lang][key]) || (I18N.zh[key] || key);
}

const CAT_KEYS = {
  '麵包/法棍': 'cat_bread', '肉類': 'cat_meat', '蔬菜/配料': 'cat_veg',
  '醬料/調味': 'cat_sauce', '飲品': 'cat_drink', '包材': 'cat_pack',
  '乳製品': 'cat_dairy', '其他': 'cat_other'
};

export function catLabel(val, lang = 'zh') {
  return val ? (t(CAT_KEYS[val], lang) || val) : t('select_cat', lang);
}

// ── Sorting comparator ──
export function invoiceSortComparator(a, b, field, dir, editsA = {}, editsB = {}) {
  let va, vb;
  switch (field) {
    case 'time':
      va = (a['日期'] || '') + ' ' + (a['時間'] || '');
      vb = (b['日期'] || '') + ' ' + (b['時間'] || '');
      break;
    case 'sender':
      va = a['傳送者'] || '';
      vb = b['傳送者'] || '';
      break;
    case 'buydate':
      va = editsA.buydate !== undefined ? editsA.buydate : a['發票日期'] || '';
      vb = editsB.buydate !== undefined ? editsB.buydate : b['發票日期'] || '';
      break;
    case 'amount':
      va = parseFloat(editsA.amount !== undefined ? editsA.amount : a['金額']) || 0;
      vb = parseFloat(editsB.amount !== undefined ? editsB.amount : b['金額']) || 0;
      return dir === 'desc' ? vb - va : va - vb;
    case 'category':
      va = editsA.category !== undefined ? editsA.category : a['品項類別'] || '';
      vb = editsB.category !== undefined ? editsB.category : b['品項類別'] || '';
      break;
    default: va = ''; vb = '';
  }
  if (typeof va === 'string') {
    const cmp = va.localeCompare(vb, 'zh-TW');
    return dir === 'desc' ? -cmp : cmp;
  }
  return 0;
}

// ── Deleted keys with TTL ──
export function isDeletedExpired(data, now = Date.now()) {
  return now - (data.time || 0) > 600000;
}

// ── Storage layer (injectable storage for testability) ──
export function getEdits(storage = sessionStorage) {
  try {
    const data = JSON.parse(storage.getItem('inv_edits') || '{}');
    if (data._version !== 2) { storage.removeItem('inv_edits'); return { _version: 2 }; }
    return data;
  } catch (e) { return { _version: 2 }; }
}

export function saveEdit(key, field, value, storage = sessionStorage) {
  const edits = getEdits(storage);
  if (!edits[key]) edits[key] = {};
  edits[key][field] = value;
  edits._version = 2;
  storage.setItem('inv_edits', JSON.stringify(edits));
}

export function getDeletedKeys(storage = sessionStorage) {
  try {
    const data = JSON.parse(storage.getItem('inv_deleted') || '{"keys":[],"time":0}');
    if (Date.now() - (data.time || 0) > 600000) {
      storage.removeItem('inv_deleted');
      return [];
    }
    return data.keys || [];
  } catch (e) { return []; }
}

export function markDeleted(uniqueKey, storage = sessionStorage) {
  const list = getDeletedKeys(storage);
  if (!list.includes(uniqueKey)) list.push(uniqueKey);
  storage.setItem('inv_deleted', JSON.stringify({ keys: list, time: Date.now() }));
}

// ── Donut chart math ──
export function calcDonutDash(revenue, food, salary) {
  const circ = 2 * Math.PI * 42;
  const foodPct = food ? food / revenue : 0;
  const salPct = salary ? salary / revenue : 0;
  const foodDash = circ * foodPct;
  const salDash = circ * salPct;
  return {
    circ,
    foodDash,
    salDash,
    foodOffset: circ - foodDash,
    foodArray: foodDash + ' ' + (circ - foodDash),
    salOffset: circ - foodDash - salDash,
    salArray: salDash + ' ' + (circ - salDash),
  };
}

// ── Bar chart height calculation ──
export function calcBarHeights(data, maxHeight = 130) {
  const maxRev = Math.max(...data.filter(d => d.revenue).map(d => d.revenue));
  return data.map(d => ({
    revenue: Math.round(d.revenue / maxRev * maxHeight),
    food: d.food ? Math.round(d.food / maxRev * maxHeight) : 0,
    salary: d.salary ? Math.round(d.salary / maxRev * maxHeight) : 0,
  }));
}

// ── Build saveField URL params ──
export function buildSaveParams(gasRow, field, value) {
  const params = new URLSearchParams({ action: 'update', row: gasRow });
  const paramKey = field === 'amount' ? 'amount'
    : field === 'category' ? 'category'
    : field === 'buydate' ? 'buydate'
    : 'note';
  params.set(paramKey, value);
  return params.toString();
}

// ── Drive thumbnail URL builder ──
export function driveThumbUrl(driveUrl, fallbackThumb) {
  if (fallbackThumb) return fallbackThumb;
  if (!driveUrl) return '';
  const m = driveUrl.match(/\/d\/([^\/\?]+)/);
  return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w800' : '';
}

// ── i18n completeness check ──
export function findMissingI18nKeys() {
  const zhKeys = Object.keys(I18N.zh);
  const viKeys = Object.keys(I18N.vi);
  return {
    missingInVi: zhKeys.filter(k => !viKeys.includes(k)),
    missingInZh: viKeys.filter(k => !zhKeys.includes(k)),
  };
}
