/**
 * 食事ノート 試作版 — Google Apps Script（サーバー側）
 *
 * 役割:
 *  - 画面から写真・テキストを受け取り、Claude API で栄養を推定する
 *  - 結果をスプレッドシート「食事」シートに保存する
 *  - 今日の記録を返す
 *
 * スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）に以下を登録:
 *  ANTHROPIC_API_KEY : Claude API のキー
 *  USERS             : 使う人と合言葉の対応（JSON）。下の createUsers() を実行すると自動で作られる
 *                      例: {"父":"3f8a…","母":"9c1d…","自分":"b72e…"}
 *  合言葉で「誰の記録か」を見分けるので、1人1つの合言葉を配ります。
 */

const CONFIG = {
  MODEL: 'claude-sonnet-5-5',   // 安さ重視なら 'claude-haiku-5-5'
  MAX_TOKENS: 1500,
  MAX_CALLS_PER_DAY: 40,        // API の使いすぎ防止（1日の上限）
  SHEET_NAME: '食事',
  TIMEZONE: 'Asia/Tokyo',
  // 外食の公表値を Web で調べる（Claude API の Web 検索ツール。別料金）。
  // ツールの type 名は変わることがあるので、有効にする前に Claude API のドキュメントで確認してください。
  ENABLE_WEB_SEARCH: false,
  WEB_SEARCH_TOOL: { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
};

const HEADERS = ['記録ID', '日時', '食事', '料理名', '品目', '量', 'kcal',
  'たんぱく質g', '脂質g', '炭水化物g', '塩分g', '自信', '入力', 'お店', 'メモ', '記録者'];
const COL_USER = 15; // 「記録者」列（0始まり）

const SYSTEM_PROMPT = `あなたは日本の家庭料理と外食に詳しい栄養推定アシスタントです。
食事の写真や説明文から料理を特定し、1人が食べた分の栄養を推定します。

ルール:
- 日本食品標準成分表（八訂）の値を基準に推定する。
- 油・バター・ソース・ドレッシング・マヨネーズ・汁物など、見えにくい部分も必ず含める。塩分は特に見落とさない。
- チェーン店が特定できる（ロゴ・包装・説明文）場合は、その店の公表値を優先し、store に店名を入れる。公表値を確かめられないときは推定であることを note に書く。
- ユーザーの補足や質問への回答がある場合は、それを最優先で反映する。
- 量の推定に自信がなく、答えによってカロリーか塩分が2割以上変わる場合だけ、question を1つ出す（選択肢は2〜4個の短い言葉）。それ以外は question を null にする。
- candidates には、主な料理の別の候補を最大3つ（見間違えやすい料理）入れる。
- 数値は四捨五入（kcal は整数、g は小数1桁）。

出力は次の形の JSON だけにする。前後に文章を書かない。
{
  "meal_name": "料理全体の短い名前",
  "store": null,
  "items": [
    {"name": "品目名", "amount": "量の目安", "kcal": 0, "protein_g": 0, "fat_g": 0, "carb_g": 0, "salt_g": 0}
  ],
  "confidence": "高" | "中" | "低",
  "candidates": ["候補1", "候補2"],
  "question": null | {"text": "質問文", "options": ["選択肢1", "選択肢2"]},
  "note": "補足（なければ空文字）"
}`;

/* ---------- 入口 ---------- */

function doGet() {
  return json_({ ok: true, message: '食事ノート API は動いています' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents || '{}');
    const user = userFromToken_(req.token);
    if (!user) return json_({ ok: false, error: '合言葉が違います' });
    switch (req.action) {
      case 'analyze': return json_(analyze_(req, user));
      case 'today':   return json_({ ok: true, user, rows: today_(user) });
      case 'delete':  deleteMeal_(req.mealId, user); return json_({ ok: true });
      default:        return json_({ ok: false, error: '不明な操作です' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ---------- 推定して保存 ---------- */

function analyze_(req, user) {
  if (!req.image && !req.text) throw new Error('写真か説明文が必要です');
  countCall_();

  const content = [];
  if (req.image) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: req.mediaType || 'image/jpeg', data: req.image },
    });
  }
  let text = `食事の区分: ${req.meal || '不明'}\n`;
  text += req.text ? `本人の説明・補足: ${req.text}\n` : '本人の説明: なし（写真のみ）\n';
  if (req.answers && req.answers.length) text += `質問への回答: ${req.answers.join(' / ')}\n`;
  if (req.choice) text += `主な料理はこれです: ${req.choice}\n`;
  text += 'この食事の栄養を推定してください。';
  content.push({ type: 'text', text });

  const result = callClaude_(content);
  result.items = (result.items || []).map(cleanItem_);
  result.total = sumItems_(result.items);

  const mealId = req.mealId || Utilities.getUuid();
  if (req.mealId) deleteMeal_(req.mealId, user); // 直したときは古い行を消して入れ直す
  saveRows_(mealId, req, result, user);

  return { ok: true, user, mealId, result };
}

function callClaude_(content) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY が未設定です');

  const body = {
    model: CONFIG.MODEL,
    max_tokens: CONFIG.MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  };
  if (CONFIG.ENABLE_WEB_SEARCH) body.tools = [CONFIG.WEB_SEARCH_TOOL];

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const data = JSON.parse(res.getContentText());
  if (code !== 200) throw new Error(`Claude API エラー (${code}): ${data.error && data.error.message}`);

  // Web 検索を使うと複数のブロックが返るので、最後のテキストを使う
  const texts = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  const raw = texts[texts.length - 1] || '';
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('推定結果を読み取れませんでした');
  return JSON.parse(raw.slice(start, end + 1));
}

/* ---------- スプレッドシート ---------- */

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function saveRows_(mealId, req, r, user) {
  const now = new Date();
  const source = req.image ? (req.text ? '写真＋補足' : '写真') : '音声・文字';
  const rows = r.items.map(it => [
    mealId, now, req.meal || '', r.meal_name || '', it.name, it.amount,
    it.kcal, it.protein_g, it.fat_g, it.carb_g, it.salt_g,
    r.confidence || '', source, r.store || '', r.note || '', user,
  ]);
  if (rows.length) {
    const sh = sheet_();
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
  }
}

// 本人の記録だけ消せる
function deleteMeal_(mealId, user) {
  if (!mealId) return;
  const sh = sheet_();
  const values = sh.getRange(1, 1, sh.getLastRow(), HEADERS.length).getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (values[i][0] === mealId && values[i][COL_USER] === user) sh.deleteRow(i + 1);
  }
}

function today_(user) {
  const sh = sheet_();
  if (sh.getLastRow() < 2) return [];
  const todayStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS.length).getValues();
  return values
    .filter(v => v[COL_USER] === user && v[1] instanceof Date &&
      Utilities.formatDate(v[1], CONFIG.TIMEZONE, 'yyyy-MM-dd') === todayStr)
    .map(v => ({
      mealId: v[0],
      time: Utilities.formatDate(v[1], CONFIG.TIMEZONE, 'HH:mm'),
      meal: v[2], mealName: v[3], name: v[4], amount: v[5],
      kcal: v[6], protein_g: v[7], fat_g: v[8], carb_g: v[9], salt_g: v[10],
    }));
}

/* ---------- 使う人 ---------- */

function userFromToken_(token) {
  if (!token) return null;
  let users = {};
  try { users = JSON.parse(PropertiesService.getScriptProperties().getProperty('USERS') || '{}'); }
  catch (e) { throw new Error('USERS の形が正しくありません'); }
  const name = Object.keys(users).find(n => users[n] === token);
  return name || null;
}

/**
 * 使う人ごとの合言葉を作る。names を書き換えてからエディタで実行する。
 * すでにいる人の合言葉はそのまま。新しい人だけ追加される。
 * 実行ログに各人の合言葉が出るので、setup.html の「家族に設定を送る」で使う。
 */
function createUsers() {
  const names = ['父', '母', '自分'];
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty('USERS') || '{}');
  names.forEach(n => { if (!users[n]) users[n] = Utilities.getUuid(); });
  props.setProperty('USERS', JSON.stringify(users));
  Object.keys(users).forEach(n => Logger.log(n + ' の合言葉: ' + users[n]));
}

/** ある人の合言葉を作り直す（スマホをなくしたときなど）。古い合言葉はすぐ使えなくなる */
function resetUserToken() {
  const name = '父'; // ← 作り直す人
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty('USERS') || '{}');
  if (!users[name]) throw new Error(name + ' は登録されていません');
  users[name] = Utilities.getUuid();
  props.setProperty('USERS', JSON.stringify(users));
  Logger.log(name + ' の新しい合言葉: ' + users[name]);
}

/* ---------- 小物 ---------- */

function cleanItem_(it) {
  const n = (x, d) => Math.round((Number(x) || 0) * Math.pow(10, d)) / Math.pow(10, d);
  return {
    name: String(it.name || ''), amount: String(it.amount || ''),
    kcal: n(it.kcal, 0), protein_g: n(it.protein_g, 1), fat_g: n(it.fat_g, 1),
    carb_g: n(it.carb_g, 1), salt_g: n(it.salt_g, 1),
  };
}

function sumItems_(items) {
  const t = { kcal: 0, protein_g: 0, fat_g: 0, carb_g: 0, salt_g: 0 };
  items.forEach(it => Object.keys(t).forEach(k => { t[k] += it[k]; }));
  Object.keys(t).forEach(k => { t[k] = Math.round(t[k] * 10) / 10; });
  t.kcal = Math.round(t.kcal);
  return t;
}

function countCall_() {
  const props = PropertiesService.getScriptProperties();
  const key = 'calls_' + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd');
  const count = Number(props.getProperty(key) || 0) + 1;
  if (count > CONFIG.MAX_CALLS_PER_DAY) throw new Error('今日の利用上限に達しました');
  props.setProperty(key, String(count));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** エディタから一度実行すると、シートの作成と権限の許可が済みます */
function setup() {
  sheet_();
  Logger.log('準備できました');
}
