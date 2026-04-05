// ================================================================
// 本米股份有限公司 — 發票自動記錄 LINE Bot v4（含 Gemini OCR）
// 欄位：A:日期 B:時間 C:傳送者 D:類型 E:檔名 F:Drive連結
//       G:月份 H:金額 I:品項類別 J:購買日期 K:備注 L:縮圖連結 M:hash
// ================================================================

const CONFIG = {
  LINE_CHANNEL_ACCESS_TOKEN: 'SC76wZD86KiT9z0ZQT/o5VIctGF3lPk12LzujwPWVgJpA1ns1Ay/9EjCXJr/1SXDdwg3IQq+gqfW5yM+jAlb6UTJxLyuitOjyxxy5Kuj4bKq2eS3KNANglD1wLZ4HclIa8+ZmgC4qkUCR3PdThBu9gdB04t89/1O/w1cDnyilFU=',
  GEMINI_API_KEY: 'AIzaSyCAIGxHLCpiKNhTycIttIJx0QaxJKkJ3n8',
  FOLDER_NAME: '本米發票記錄',
  SHEET_NAME:  '發票記錄',
};

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

    // 去重
    if (hashVal) {
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
    const thumbUrl = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w400';

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
    const thumbUrl = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w400';

    const imageBase64 = Utilities.base64Encode(bytes);
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
// Gemini OCR — 金額優先，同時抓日期、店家、品項
// ================================================================
function recognizeInvoice(imageBase64) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=' + CONFIG.GEMINI_API_KEY;

  // 第一步：只問金額（最重要，單獨問準確率高）
  const amountPrompt = `這是一張收據或發票。
請找出「合計」、「總計」、「Total」、「總金額」、「金額合計」或最大的金額數字。
只回傳一個純數字（不含貨幣符號、逗號、空格），例如：1134
如果完全看不到金額就回傳 null`;

  const detailPrompt = `這是一張收據或發票。請用JSON格式回傳以下資訊（無法辨識的欄位填null）：
{"store":"店家或供應商名稱","date":"日期YYYY/MM/DD格式","items":["品項1","品項2"]}
只回傳JSON，不要其他文字，items最多5項`;

  const makePayload = (prompt) => ({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }
      ]
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 256 }
  });

  const opts = {
    method: 'post',
    headers: { 'Content-Type': 'application/json' },
    muteHttpExceptions: true
  };

  let amount = null;
  let store  = null;
  let date   = null;
  let items  = [];

  // 辨識金額
  try {
    opts.payload = JSON.stringify(makePayload(amountPrompt));
    const r1   = UrlFetchApp.fetch(url, opts);
    const j1   = JSON.parse(r1.getContentText());
    const raw1 = (j1.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    const num  = parseFloat(raw1.replace(/[^0-9.]/g, ''));
    if (!isNaN(num) && num > 0) amount = num;
  } catch(e) {
    Logger.log('OCR amount error: ' + e);
  }

  // 辨識其他欄位
  try {
    opts.payload = JSON.stringify(makePayload(detailPrompt));
    const r2   = UrlFetchApp.fetch(url, opts);
    const j2   = JSON.parse(r2.getContentText());
    const raw2 = (j2.candidates?.[0]?.content?.parts?.[0]?.text || '').replace(/```json|```/g,'').trim();
    const parsed = JSON.parse(raw2);
    store = parsed.store || null;
    date  = parsed.date  || null;
    items = parsed.items || [];
  } catch(e) {
    Logger.log('OCR detail error: ' + e);
  }

  return { amount, store, date, items };
}

// ================================================================
// 記錄到試算表（含 OCR）
// ================================================================
function logToSheet(timestamp, senderName, fileName, fileUrl, thumbUrl, hashVal, ocr) {
  const sheet = getOrCreateSheet(getOrCreateSpreadsheet());
  sheet.appendRow([
    Utilities.formatDate(timestamp, 'Asia/Taipei', 'yyyy/MM/dd'),
    Utilities.formatDate(timestamp, 'Asia/Taipei', 'HH:mm'),
    senderName,
    '發票照片',
    fileName,
    fileUrl,
    Utilities.formatDate(timestamp, 'Asia/Taipei', 'yyyy-MM'),
    ocr && ocr.amount ? ocr.amount : '',  // H 金額（OCR）
    '',                                   // I 品項類別
    ocr && ocr.date   ? ocr.date  : '',  // J 購買日期（OCR）
    ocr && ocr.store  ? ocr.store : '',  // K 備注（用store暫放）
    thumbUrl,
    hashVal,
  ]);
}

// ================================================================
// 文字指令
// ================================================================
function handleText(text, senderName, timestamp, replyToken) {
  const cmd = text.trim();
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
  } else if (cmd === '幫助' || cmd === 'help') {
    replyMessage(replyToken,
      '📋 本米發票記錄 Bot\n\n' +
      '📸 傳圖片 → 自動OCR辨識金額\n' +
      '📊 「本月統計」→ 查看合計\n' +
      '❓ 「幫助」→ 顯示說明\n\n' +
      '金額辨識有誤可至報表手動修改'
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
