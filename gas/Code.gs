// ================================================================
// 本米股份有限公司 — 發票自動記錄 LINE Bot v4（含 Gemini OCR）
// 欄位：A:日期 B:時間 C:傳送者 D:類型 E:檔名 F:Drive連結
//       G:月份 H:金額 I:品項類別 J:購買日期 K:備注 L:縮圖連結 M:hash
// ================================================================

const PROPS = PropertiesService.getScriptProperties();
const CONFIG = {
  LINE_CHANNEL_ACCESS_TOKEN: PROPS.getProperty('LINE_CHANNEL_ACCESS_TOKEN'),
  CLAUDE_API_KEY: PROPS.getProperty('CLAUDE_API_KEY'),
  SUPABASE_URL: PROPS.getProperty('SUPABASE_URL'),
  SUPABASE_KEY: PROPS.getProperty('SUPABASE_KEY'),
  FOLDER_NAME: '本米發票記錄',
  SHEET_NAME:  '發票記錄',
};

// ================================================================
// Supabase helpers
// ================================================================
function supabaseInsert(record) {
  const props = PropertiesService.getScriptProperties();
  const url   = props.getProperty('SUPABASE_URL') + '/rest/v1/invoices';
  const key   = props.getProperty('SUPABASE_KEY');

  const payload = JSON.stringify(record);
  Logger.log('Supabase insert payload: ' + payload);

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Prefer': 'return=minimal'
    },
    payload: payload,
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const body = res.getContentText();
  Logger.log('Supabase insert ' + code + ': ' + body);
  return code === 201 || code === 200;
}

function supabaseUpdate(id, fields) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_KEY || !id) return;
  try {
    UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/rest/v1/invoices?id=eq.' + id, {
      method: 'patch',
      headers: {
        'Content-Type': 'application/json',
        'apikey': CONFIG.SUPABASE_KEY,
        'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY
      },
      payload: JSON.stringify(fields),
      muteHttpExceptions: true
    });
  } catch(e) {
    Logger.log('Supabase update error: ' + e.toString());
  }
}

function supabaseFindByHash(hash) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_KEY || !hash) return null;
  try {
    const res = UrlFetchApp.fetch(
      CONFIG.SUPABASE_URL + '/rest/v1/invoices?file_hash=eq.' + encodeURIComponent(hash) + '&limit=1', {
      headers: {
        'apikey': CONFIG.SUPABASE_KEY,
        'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY
      },
      muteHttpExceptions: true
    });
    const rows = JSON.parse(res.getContentText());
    return (Array.isArray(rows) && rows.length) ? rows[0] : null;
  } catch(e) { return null; }
}

function uploadToSupabaseStorage(imageBase64, fileName) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_KEY) return null;
  try {
    const bytes = Utilities.base64Decode(imageBase64);
    const blob  = Utilities.newBlob(bytes, 'image/jpeg', fileName);
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const res   = UrlFetchApp.fetch(
      CONFIG.SUPABASE_URL + '/storage/v1/object/invoices/' + safeName, {
      method: 'put',
      headers: {
        'apikey': CONFIG.SUPABASE_KEY,
        'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'true'
      },
      payload: blob.getBytes(),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    Logger.log('Supabase storage ' + code + ' for ' + safeName);
    if (code === 200 || code === 201) {
      return CONFIG.SUPABASE_URL + '/storage/v1/object/public/invoices/' + safeName;
    }
    Logger.log('Supabase storage body: ' + res.getContentText());
    return null;
  } catch(e) {
    Logger.log('Supabase storage error: ' + e.toString());
    return null;
  }
}

// ================================================================
// GET：Webhook 驗證 + Dashboard 欄位更新
// ================================================================
function doGet(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  if (p.action === 'update') {
    try {
      const row   = parseInt(p.row);
      const sheet = getOrCreateSheet(getOrCreateSpreadsheet());
      if (p.amount   !== undefined && p.amount   !== '') sheet.getRange(row, 8).setValue(parseFloat(p.amount) || '');
      if (p.category !== undefined && p.category !== '') sheet.getRange(row, 9).setValue(p.category);
      if (p.buydate  !== undefined && p.buydate  !== '') sheet.getRange(row, 10).setValue(p.buydate);
      if (p.note     !== undefined)                      sheet.getRange(row, 11).setValue(p.note);

      // Sync to Supabase if id provided
      if (p.id) {
        const updates = {};
        if (p.amount   !== undefined && p.amount   !== '') updates.amount = parseFloat(p.amount) || null;
        if (p.category !== undefined && p.category !== '') updates.category = p.category;
        if (p.buydate  !== undefined && p.buydate  !== '') updates.purchase_date = p.buydate;
        if (p.note     !== undefined)                      updates.note = p.note;
        supabaseUpdate(p.id, updates);
      }

      return json({ status: 'ok', row });
    } catch(err) {
      return json({ status: 'error', msg: err.message });
    }
  }
  return json({ status: 'ok' });
}

// ================================================================
// POST：LINE Webhook + Dashboard 圖片上傳
// ================================================================
function doPost(e) {
  try {
    if (!e || !e.postData) return ok();
    const bodyText = e.postData.contents || '';
    if (bodyText.indexOf('"source":"dashboard"') !== -1 || bodyText.indexOf('"source": "dashboard"') !== -1) {
      return handleDashboardUpload(JSON.parse(bodyText));
    }
    const body   = JSON.parse(bodyText || '{}');
    const events = body.events || [];
    for (const event of events) {
      if (event.type === 'message') handleMessage(event);
    }
  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
  }
  return ok();
}

// ================================================================
// Dashboard 上傳處理（含 OCR）
// ================================================================
function handleDashboardUpload(body) {
  try {
    const imageBase64 = body.image;
    const fileName    = body.filename || ('upload_' + Date.now() + '.jpg');
    const uploader    = body.uploader || 'Dashboard';
    const hashVal     = body.hash || '';

    // 去重：先查 Supabase，再查 Sheets
    if (hashVal) {
      const existing = supabaseFindByHash(hashVal);
      if (existing) return json({ status: 'duplicate', msg: '此圖片已上傳過' });

      const sheet = getOrCreateSheet(getOrCreateSpreadsheet());
      const data  = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (data[i][12] === hashVal) {
          return json({ status: 'duplicate', msg: '此圖片已上傳過', row: i + 1 });
        }
      }
    }

    // OCR
    const ocr = recognizeInvoice(imageBase64);

    // 存 Drive
    const bytes    = Utilities.base64Decode(imageBase64);
    const blob     = Utilities.newBlob(bytes, 'image/jpeg', fileName);
    const folder   = getOrCreateMonthFolder(new Date());
    const file     = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const fileId   = file.getId();
    const fileUrl  = 'https://drive.google.com/file/d/' + fileId + '/view';

    // 同步上傳到 Supabase Storage
    const sbThumb  = uploadToSupabaseStorage(imageBase64, fileName);
    const thumbUrl = sbThumb || ('https://drive.google.com/thumbnail?id=' + fileId + '&sz=w400');

    // 記錄
    logToSheet(new Date(), uploader, fileName, fileUrl, thumbUrl, hashVal, ocr);

    return json({ status: 'ok', fileId, fileUrl, thumbUrl, ocr });
  } catch(err) {
    Logger.log('Dashboard upload error: ' + err.toString());
    return json({ status: 'error', msg: err.message });
  }
}

// ================================================================
// LINE 圖片處理（含 OCR）
// ================================================================
function handleMessage(event) {
  const msg        = event.message;
  const replyToken = event.replyToken;
  const source     = event.source;
  const senderName = getSenderName(source.userId || '', source.groupId || source.roomId || '');
  const timestamp  = new Date(event.timestamp);

  if (msg.type === 'image') {
    handleLineImage(msg.id, senderName, timestamp, replyToken);
  } else if (msg.type === 'text') {
    handleText(msg.text, senderName, timestamp, replyToken);
  }
}

function handleLineImage(messageId, senderName, timestamp, replyToken) {
  try {
    const blob  = fetchImageFromLine(messageId);
    const bytes = blob.getBytes();
    const hashVal = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
    ).substring(0, 16);

    // 去重
    const existing = supabaseFindByHash(hashVal);
    if (existing) {
      replyMessage(replyToken, '⚠️ 此圖片已上傳過');
      return;
    }
    const sheet = getOrCreateSheet(getOrCreateSpreadsheet());
    const data  = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][12] === hashVal) {
        replyMessage(replyToken, '⚠️ 此圖片已上傳過（' + data[i][0] + '）');
        return;
      }
    }

    // OCR（先存圖再辨識，避免 timeout）
    const folder   = getOrCreateMonthFolder(timestamp);
    const fileName = formatFileName(timestamp, senderName);
    const file     = folder.createFile(blob.setName(fileName));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const fileId   = file.getId();
    const fileUrl  = 'https://drive.google.com/file/d/' + fileId + '/view';

    const imageBase64 = Utilities.base64Encode(bytes);

    // 同步上傳到 Supabase Storage
    const sbThumb  = uploadToSupabaseStorage(imageBase64, fileName);
    const thumbUrl = sbThumb || ('https://drive.google.com/thumbnail?id=' + fileId + '&sz=w400');

    const ocr = recognizeInvoice(imageBase64);

    logToSheet(timestamp, senderName, fileName, fileUrl, thumbUrl, hashVal, ocr);

    const m = Utilities.formatDate(timestamp, 'Asia/Taipei', 'M');
    const d = Utilities.formatDate(timestamp, 'Asia/Taipei', 'd');
    const t = Utilities.formatDate(timestamp, 'Asia/Taipei', 'HH:mm');

    let reply = '✅ 發票已記錄\n';
    reply += '👤 ' + senderName + '\n';
    reply += '📅 ' + m + '月' + d + '日 ' + t + '\n';
    reply += '─────────────\n';

    if (ocr.amount) {
      reply += '💰 金額：$' + ocr.amount.toLocaleString() + '\n';
    } else {
      reply += '💰 金額：⚠️ 請手動填入\n';
    }
    if (ocr.date)  reply += '🗓 日期：' + ocr.date + '\n';
    if (ocr.store) reply += '🏪 店家：' + ocr.store + '\n';
    if (ocr.items && ocr.items.length > 0) {
      reply += '📦 品項：' + ocr.items.slice(0, 3).join('、');
      if (ocr.items.length > 3) reply += ' 等' + ocr.items.length + '項';
      reply += '\n';
    }
    reply += '─────────────\n';
    reply += '📁 已存入 Google Drive';
    if (!ocr.amount) reply += '\n⚠️ 金額未辨識，請至報表補填';

    replyMessage(replyToken, reply);

  } catch (err) {
    Logger.log('LINE image error: ' + err.toString());
    replyMessage(replyToken, '⚠️ 記錄失敗\n' + err.message);
  }
}

// ================================================================
// Gemini OCR — 改用 Claude claude-sonnet-4-5 API，辨識更準確
// ================================================================
function recognizeInvoice(imageBase64) {
  const url = 'https://api.anthropic.com/v1/messages';

  const prompt = `無論圖片內容是什麼，你必須只回傳純 JSON，格式如下，無法辨識的欄位填 null：
{"amount":null,"store":null,"date":null,"items":[]}
絕對不能回傳任何說明文字。

圖片可能是旋轉的（0度、90度、180度、270度），請自動辨識方向後再讀取內容。

這是一張收據或發票的照片。請仔細辨識後用JSON格式回傳以下資訊：
{
  "amount": 應付金額（純數字），
  "store": "店家或供應商名稱",
  "date": "日期（格式：YYYY/MM/DD）",
  "items": ["品項1", "品項2", "品項3"]
}

金額辨識規則：
- 找「銷售總額」「應付金額」「合計」「總計」「小計」「金額」「Total」
- 忽略「找零」「匯收金額」「稅額」等欄位
- 如果有多個金額，取「應付金額」或「銷售總額」
- amount 回傳純數字，不含符號，例如 1134，無法辨識填 null

其他注意事項：
- 支援中文、越南文、英文混合發票
- items 最多5項主要品項
- 只回傳JSON，不要其他文字`;

  const payload = {
    model: 'claude-sonnet-4-5',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: imageBase64
          }
        },
        { type: 'text', text: prompt }
      ]
    }]
  };

  const opts = {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CONFIG.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, opts);
    const result   = JSON.parse(response.getContentText());
    const text     = result.content?.[0]?.text || '';
    const cleaned  = text.replace(/```json|```/g, '').trim();
    try {
      const parsed = JSON.parse(cleaned);
      return {
        amount: parsed.amount || null,
        store:  parsed.store  || null,
        date:   parsed.date   || null,
        items:  parsed.items  || []
      };
    } catch(jsonErr) {
      Logger.log('Claude OCR JSON parse failed, raw text: ' + cleaned);
      return { amount: null, store: null, date: null, items: [], _rawText: cleaned };
    }
  } catch(e) {
    Logger.log('Claude OCR error: ' + e.toString());
    return { amount: null, store: null, date: null, items: [] };
  }
}

// ================================================================
// 自動品項分類
// ================================================================
function autoCategory(items, store) {
  const text = (items || []).join(' ') + ' ' + (store || '');
  const t = text.toLowerCase();
  if (/麵包|法棍|bm|bánh mì/i.test(t)) return '麵包/法棍';
  if (/豬|雞|牛|肉|pork|chicken|meat|ham|火腿|thịt/i.test(t)) return '肉類';
  if (/鹽|胡椒|醬|辣|蠔油|魚露|mayo|sauce|chilli|pepper/i.test(t)) return '醬料/調味';
  if (/蔬菜|蘿蔔|黃瓜|番茄|青菜|rau|củ|cà/i.test(t)) return '蔬菜/配料';
  if (/可樂|咖啡|茶|豆漿|coffee|cola|drink|nước|trà/i.test(t)) return '飲品';
  if (/起司|乳|cheese|milk|sữa/i.test(t)) return '乳製品';
  if (/袋|包裝|box|bag|bao/i.test(t)) return '包材';
  if (/清潔|洗碗|消毒|清洗/i.test(t)) return '清潔用品';
  return '';
}

// ================================================================
// 記錄到試算表 + Supabase（含 OCR）
// ================================================================
function logToSheet(timestamp, senderName, fileName, fileUrl, thumbUrl, hashVal, ocr) {
  const sheet = getOrCreateSheet(getOrCreateSpreadsheet());
  const buyDate = ocr && ocr.date ? ocr.date.replace(/\//g, '-') : '';
  const category = ocr ? autoCategory(ocr.items, ocr.store) : '';
  const uploadDate = Utilities.formatDate(timestamp, 'Asia/Taipei', 'yyyy/MM/dd');
  const uploadTime = Utilities.formatDate(timestamp, 'Asia/Taipei', 'HH:mm');

  // Google Sheets（備份）
  sheet.appendRow([
    uploadDate,
    uploadTime,
    senderName,
    '發票照片',
    fileName,
    fileUrl,
    Utilities.formatDate(timestamp, 'Asia/Taipei', 'yyyy-MM'),
    ocr && ocr.amount ? ocr.amount : '',
    category,
    buyDate,
    '',
    thumbUrl,
    hashVal,
  ]);

  // Supabase（主要資料庫）
  supabaseInsert({
    upload_date:    uploadDate.replace(/\//g, '-'),
    upload_time:    uploadTime,
    sender:         senderName,
    amount:         ocr && ocr.amount ? ocr.amount : null,
    category:       category || null,
    purchase_date:  buyDate || null,
    note:           null,
    drive_url:      fileUrl,
    thumb_url:      thumbUrl,
    file_hash:      hashVal || null,
  });
}

// ================================================================
// 文字指令（含「上一筆補金額」功能）
// ================================================================
function handleText(text, senderName, timestamp, replyToken) {
  const cmd = text.trim();

  // ── 純數字 → 補填上一筆發票的金額 ──
  const numMatch = cmd.match(/^[\$\$]?([0-9,，]+(\.[0-9]+)?)$/);
  if (numMatch) {
    const amount = parseFloat(numMatch[1].replace(/[,，]/g, ''));
    if (!isNaN(amount) && amount > 0) {
      const sheet = getOrCreateSheet(getOrCreateSpreadsheet());
      const lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        const lastTime = sheet.getRange(lastRow, 1).getValue() + ' ' + sheet.getRange(lastRow, 2).getValue();
        sheet.getRange(lastRow, 8).setValue(amount);
        replyMessage(replyToken,
          '✅ 金額已更新\n' +
          '💰 $' + amount.toLocaleString()
        );
      } else {
        replyMessage(replyToken, '⚠️ 找不到上一筆記錄，請先傳發票圖片');
      }
      return;
    }
  }

  // ── 數字 + 說明 → 補金額和備注 ──
  const numTextMatch = cmd.match(/^[\$\$]?([0-9,，]+)\s+(.+)$/);
  if (numTextMatch) {
    const amount = parseFloat(numTextMatch[1].replace(/[,，]/g, ''));
    const note   = numTextMatch[2].trim();
    if (!isNaN(amount) && amount > 0) {
      const sheet = getOrCreateSheet(getOrCreateSpreadsheet());
      const lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        sheet.getRange(lastRow, 8).setValue(amount);
        if (note) sheet.getRange(lastRow, 11).setValue(note);
        replyMessage(replyToken,
          '✅ 金額與備注已更新\n' +
          '💰 $' + amount.toLocaleString() + '\n' +
          '📝 ' + note
        );
      } else {
        replyMessage(replyToken, '⚠️ 找不到上一筆記錄');
      }
      return;
    }
  }

  if (cmd === '本月統計' || cmd === '統計') {
    const monthStr = Utilities.formatDate(timestamp, 'Asia/Taipei', 'yyyy-MM');
    const sheet    = getOrCreateSheet(getOrCreateSpreadsheet());
    const data     = sheet.getDataRange().getValues();
    let count = 0, total = 0, noAmt = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i][6] === monthStr) {
        count++;
        const amt = parseFloat(data[i][7]);
        if (!isNaN(amt) && amt > 0) total += amt;
        else noAmt++;
      }
    }
    const month = Utilities.formatDate(timestamp, 'Asia/Taipei', 'M');
    let reply = '📊 ' + month + '月採購統計\n';
    reply += '張數：' + count + ' 張\n';
    reply += '合計：$' + total.toLocaleString() + '\n';
    if (noAmt > 0) reply += '⚠️ 待填金額：' + noAmt + ' 張';
    replyMessage(replyToken, reply);
  } else if (cmd === '幫助' || cmd === 'help' || cmd === 'trợ giúp') {
    replyMessage(replyToken,
      '📋 本米發票記錄 Bot\n\n' +
      '📸 傳圖片 → 自動OCR辨識金額\n' +
      '💰 傳數字 → 補填上一筆金額\n' +
      '   例：1134\n' +
      '💰 傳「數字+說明」→ 補金額和備注\n' +
      '   例：1134 佳鑫肉品\n' +
      '📊 「本月統計」→ 查看合計\n' +
      '❓ 「幫助」→ 顯示說明'
    );
  }
}

// ================================================================
// 工具函式
// ================================================================
function fetchImageFromLine(messageId) {
  return UrlFetchApp.fetch(
    'https://api-data.line.me/v2/bot/message/' + messageId + '/content',
    { headers: { Authorization: 'Bearer ' + CONFIG.LINE_CHANNEL_ACCESS_TOKEN } }
  ).getBlob();
}

function getSenderName(userId, groupId) {
  try {
    const url = groupId
      ? 'https://api.line.me/v2/bot/group/' + groupId + '/member/' + userId
      : 'https://api.line.me/v2/bot/profile/' + userId;
    const res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + CONFIG.LINE_CHANNEL_ACCESS_TOKEN },
      muteHttpExceptions: true
    });
    return JSON.parse(res.getContentText()).displayName || '未知用戶';
  } catch (e) { return '未知用戶'; }
}

function getOrCreateMonthFolder(timestamp) {
  const monthStr = Utilities.formatDate(timestamp, 'Asia/Taipei', 'yyyy-MM');
  let root;
  const roots = DriveApp.getFoldersByName(CONFIG.FOLDER_NAME);
  root = roots.hasNext() ? roots.next() : DriveApp.createFolder(CONFIG.FOLDER_NAME);
  const subs = root.getFoldersByName(monthStr);
  return subs.hasNext() ? subs.next() : root.createFolder(monthStr);
}

function formatFileName(timestamp, senderName) {
  const dt   = Utilities.formatDate(timestamp, 'Asia/Taipei', 'yyyyMMdd_HHmm');
  const name = senderName.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
  return dt + '_' + name + '.jpg';
}

function getOrCreateSpreadsheet() {
  const files = DriveApp.getFilesByName('本米發票記錄');
  if (files.hasNext()) return SpreadsheetApp.open(files.next());
  return SpreadsheetApp.create('本米發票記錄');
}

function getOrCreateSheet(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    sheet.appendRow(['日期','時間','傳送者','類型','檔名','Drive連結','月份','金額','品項類別','購買日期','備注','縮圖連結','檔案hash']);
    sheet.getRange(1,1,1,13).setFontWeight('bold').setBackground('#1e3a5f').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function replyMessage(replyToken, text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CONFIG.LINE_CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function ok() {
  return ContentService.createTextOutput(JSON.stringify({ status:'ok' })).setMimeType(ContentService.MimeType.JSON);
}

// ================================================================
// 批次 OCR 補辨識 — 在 Apps Script 手動執行一次
// ================================================================
function batchOCR() {
  const sheet  = getOrCreateSheet(getOrCreateSpreadsheet());
  const data   = sheet.getDataRange().getValues();

  let processed = 0, success = 0, failed = 0;

  Logger.log('開始批次 OCR，共 ' + (data.length - 1) + ' 筆記錄');

  for (let i = 1; i < data.length; i++) {
    const amount   = data[i][7];
    const driveUrl = data[i][5];
    const fileName = data[i][4];

    if (amount !== '' && amount !== null) continue;
    if (!driveUrl) continue;

    // 跳過異常 hash（base64 格式含 / 或 +）
    const hashVal = data[i][12];
    if (hashVal && /[\/\+]/.test(hashVal)) {
      Logger.log('⏭ 第 ' + i + ' 筆跳過：異常 hash=' + hashVal);
      continue;
    }

    processed++;
    Logger.log('處理第 ' + i + ' 筆：' + fileName);

    try {
      const match = driveUrl.match(/\/d\/([^\/\?]+)/);
      if (!match) { failed++; continue; }
      const fileId = match[1];

      const file     = DriveApp.getFileById(fileId);
      const blob     = file.getBlob();
      const bytes    = blob.getBytes();
      const base64   = Utilities.base64Encode(bytes);

      let ocr;
      try {
        ocr = recognizeInvoice(base64);
      } catch(ocrErr) {
        Logger.log('⚠️ 第 ' + i + ' 筆 OCR JSON 解析失敗：' + ocrErr.toString());
        ocr = { amount: null, store: null, date: null, items: [] };
      }

      if (!ocr.amount && ocr._rawText) {
        const numMatch = ocr._rawText.match(/(\d[\d,]*\.?\d*)/g);
        if (numMatch) {
          const nums = numMatch.map(s => parseFloat(s.replace(/,/g, ''))).filter(n => n > 0);
          if (nums.length) {
            ocr.amount = Math.max(...nums);
            Logger.log('⚠️ 第 ' + i + ' 筆 regex fallback 金額=' + ocr.amount);
          }
        }
      }

      // 寫回 Google Sheets
      if (ocr.amount) {
        sheet.getRange(i + 1, 8).setValue(ocr.amount);
        success++;
      }
      if (ocr.date) {
        sheet.getRange(i + 1, 10).setValue(ocr.date.replace(/\//g, '-'));
      }
      if (ocr.store || ocr.items) {
        const cat = autoCategory(ocr.items || [], ocr.store || '');
        if (cat) sheet.getRange(i + 1, 9).setValue(cat);
      }

      // 同步到 Supabase（以 file_hash 查找）
      const hashVal = data[i][12];
      if (hashVal) {
        const existing = supabaseFindByHash(hashVal);
        if (existing) {
          const updates = {};
          if (ocr.amount) updates.amount = ocr.amount;
          if (ocr.date)   updates.purchase_date = ocr.date.replace(/\//g, '-');
          const cat = autoCategory(ocr.items || [], ocr.store || '');
          if (cat) updates.category = cat;
          if (Object.keys(updates).length) supabaseUpdate(existing.id, updates);
        }
      }

      Logger.log('✅ 第 ' + i + ' 筆完成：金額=' + ocr.amount + ', 日期=' + ocr.date + ', 店家=' + ocr.store);
      Utilities.sleep(1000);

    } catch(e) {
      failed++;
      Logger.log('❌ 第 ' + i + ' 筆失敗：' + e.toString());
    }
  }

  const msg = '批次 OCR 完成！\n處理：' + processed + ' 筆\n成功：' + success + ' 筆\n失敗：' + failed + ' 筆';
  Logger.log(msg);
}

// ================================================================
// 一次性遷移：Google Sheets → Supabase
// 在 Apps Script 編輯器手動執行一次即可
// ================================================================
function migrateToSupabase() {
  const sheet = getOrCreateSheet(getOrCreateSpreadsheet());
  const data  = sheet.getDataRange().getValues();

  let migrated = 0, skipped = 0, failed = 0;
  Logger.log('開始遷移，共 ' + (data.length - 1) + ' 筆記錄');

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    // A:日期 B:時間 C:傳送者 D:類型 E:檔名 F:Drive連結
    // G:月份 H:金額 I:品項類別 J:購買日期 K:備注 L:縮圖連結 M:hash
    const hashVal = row[12] || null;

    // 用 hash 去重，已存在就跳過
    if (hashVal) {
      const existing = supabaseFindByHash(hashVal);
      if (existing) {
        skipped++;
        continue;
      }
    }

    // 日期格式：Sheets 可能是 Date 物件或字串
    let uploadDate = row[0];
    if (uploadDate instanceof Date) {
      uploadDate = Utilities.formatDate(uploadDate, 'Asia/Taipei', 'yyyy-MM-dd');
    } else if (typeof uploadDate === 'string' && uploadDate) {
      uploadDate = uploadDate.replace(/\//g, '-');
    } else {
      uploadDate = null;
    }

    let uploadTime = row[1];
    if (uploadTime instanceof Date) {
      uploadTime = Utilities.formatDate(uploadTime, 'Asia/Taipei', 'HH:mm');
    } else {
      uploadTime = uploadTime ? String(uploadTime) : null;
    }

    let purchaseDate = row[9];
    if (purchaseDate instanceof Date) {
      purchaseDate = Utilities.formatDate(purchaseDate, 'Asia/Taipei', 'yyyy-MM-dd');
    } else if (typeof purchaseDate === 'string' && purchaseDate) {
      purchaseDate = purchaseDate.replace(/\//g, '-');
    } else {
      purchaseDate = null;
    }
    if (purchaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) {
      purchaseDate = null;
    }

    const amount = row[7] !== '' && row[7] !== null ? parseFloat(row[7]) || null : null;

    const record = {
      upload_date:   uploadDate,
      upload_time:   uploadTime,
      sender:        row[2] || null,
      amount:        amount,
      category:      row[8] || null,
      purchase_date: purchaseDate,
      note:          row[10] || null,
      drive_url:     row[5] || null,
      thumb_url:     row[11] || null,
      file_hash:     hashVal,
    };

    try {
      const result = supabaseInsert(record);
      if (result) {
        migrated++;
      } else {
        failed++;
        Logger.log('❌ 第 ' + i + ' 筆插入失敗');
      }
    } catch(e) {
      failed++;
      Logger.log('❌ 第 ' + i + ' 筆錯誤：' + e.toString());
    }

    // 避免 rate limit
    if (i % 50 === 0) {
      Logger.log('進度：' + i + '/' + (data.length - 1));
      Utilities.sleep(500);
    }
  }

  Logger.log('遷移完成！成功：' + migrated + ' 筆，跳過（已存在）：' + skipped + ' 筆，失敗：' + failed + ' 筆');
}
