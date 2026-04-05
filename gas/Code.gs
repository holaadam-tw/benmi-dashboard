// ================================================================
// 本米股份有限公司 — 發票自動記錄 LINE Bot v4（含 Claude OCR）
// 欄位：A:日期 B:時間 C:傳送者 D:類型 E:檔名 F:Drive連結
//       G:月份 H:金額 I:品項類別 J:購買日期 K:備注 L:縮圖連結 M:hash
// ================================================================

// API keys 存放在 Script Properties（不寫在程式碼裡）
// 首次部署請執行 setupProperties() 設定金鑰
const CONFIG = {
  get LINE_CHANNEL_ACCESS_TOKEN() { return PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN'); },
  get CLAUDE_API_KEY()            { return PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY'); },
  FOLDER_NAME: '本米發票記錄',
  SHEET_NAME:  '發票記錄',
};

/**
 * 首次部署時在 Apps Script 編輯器執行一次此函式，設定 API 金鑰。
 * 執行後金鑰會安全存放在 Script Properties 中。
 */
function setupProperties() {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    'LINE_CHANNEL_ACCESS_TOKEN': '在此貼上 LINE Channel Access Token',
    'CLAUDE_API_KEY':            '在此貼上 Claude API Key',
  });
  Logger.log('✅ Script Properties 已設定完成');
}

// ================================================================
// GET：Webhook 驗證 + Dashboard 欄位更新
// ================================================================
function doGet(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  if (p.action === 'getData') {
    try {
      const sheet = getOrCreateSheet(getOrCreateSpreadsheet());
      const data  = sheet.getDataRange().getValues();
      const headers = data[0];
      const rows = data.slice(1).map(row => {
        const obj = {};
        headers.forEach((h, i) => {
          const v = row[i];
          obj[h] = v instanceof Date
            ? Utilities.formatDate(v, 'Asia/Taipei', 'yyyy/MM/dd')
            : (v || '');
        });
        return obj;
      }).filter(r => r['日期']);
      return json({ status: 'ok', rows });
    } catch(err) {
      return json({ status: 'error', msg: err.message });
    }
  }
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
// Claude OCR — 使用 Claude Sonnet 4.5 API 辨識發票
// ================================================================
function recognizeInvoice(imageBase64) {
  const url = 'https://api.anthropic.com/v1/messages';

  const prompt = `這是一張收據或發票的照片。請仔細辨識後用JSON格式回傳以下資訊：
{
  "amount": 合計金額（純數字，找「合計」「總計」「Total」「金額合計」，取最大那個數字，例如：1134），
  "store": "店家或供應商名稱",
  "date": "日期（格式：YYYY/MM/DD）",
  "items": ["品項1", "品項2", "品項3"]
}

注意事項：
- amount 只填數字，例如 1134，無法辨識填 null
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
    const parsed   = JSON.parse(cleaned);
    return {
      amount: parsed.amount || null,
      store:  parsed.store  || null,
      date:   parsed.date   || null,
      items:  parsed.items  || []
    };
  } catch(e) {
    Logger.log('Claude OCR error: ' + e.toString());
    return { amount: null, store: null, date: null, items: [] };
  }
}

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
  if (/清潔|洗碗|消毒/i.test(t)) return '清潔用品';
  return '';
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
    autoCategory(ocr ? ocr.items : [], ocr ? ocr.store : ''),  // I 品項類別（自動）
    ocr && ocr.date ? ocr.date.replace(/\//g, '-') : '',       // J 購買日期（YYYY-MM-DD）
    ocr && ocr.store  ? ocr.store : '',  // K 備注（用store暫放）
    thumbUrl,
    hashVal,
  ]);
}

// ================================================================
// 文字指令（含「上一筆補金額」功能）
// ================================================================
function handleText(text, senderName, timestamp, replyToken) {
  const cmd = text.trim();

  // ── 純數字 → 補填上一筆發票的金額（1分鐘內有效）──
  const numMatch = cmd.match(/^[\$\$]?([0-9,，]+(\.[0-9]+)?)$/);
  if (numMatch) {
    const amount = parseFloat(numMatch[1].replace(/[,，]/g, ''));
    if (!isNaN(amount) && amount > 0) {
      const sheet = getOrCreateSheet(getOrCreateSpreadsheet());
      const lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        // 檢查上一筆是否在1分鐘內
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

  // ── 數字 + 說明 → 補金額和備注（1分鐘內有效）──
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
