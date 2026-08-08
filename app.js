// @ts-check

/*
========================================
UI レイヤー
========================================
テキスト整形そのものは format.js（DOM 非依存）にある。
このファイルは DOM 生成・イベント処理・ファイル入出力を担当する。
index.html では format.js → app.js の順に読み込むこと。
*/

// 連続呼び出しを間引くユーティリティ
function debounce(fn, delay) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

const PREVIEW_UPDATE_DEBOUNCE_MS = 150;
const PREVIEW_UPDATE_SYNC_THRESHOLD_MS = 16;
let lastPreviewUpdateDuration = 0;

/*
========================================
UI更新システム：プレビュー表示
========================================
*/

/**
 * セリフ行プレフィックスを描画し、スペース文字だけを固定幅化する。
 * Chrome の縦書き行頭空白の差異を吸収するため、空白は要素化して 1em を保証する。
 *
 * @param {HTMLElement} target
 * @param {string} prefixText
 */
function appendDialoguePrefixWithFixedSpaces(target, prefixText) {
    for (const ch of prefixText) {
        if (ch === ' ' || ch === '　') {
            const spaceSpan = document.createElement('span');
            spaceSpan.className = 'fixed-space';
            spaceSpan.textContent = ch;
            target.appendChild(spaceSpan);
            continue;
        }

        target.appendChild(document.createTextNode(ch));
    }
}

/**
 * @param {HTMLElement} titleText
 */
function adjustTitleFontSize(titleText) {
    const container = titleText.parentElement;
    if (!container) return;

    // 印刷倍率は styles.css の --print-scale が単一の定義。
    // プレビューではその逆数ぶん小さく収めておけば、印刷時に紙面いっぱいになる。
    const printScale = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--print-scale')
    ) || 1.566;
    const previewScale = 1 / printScale;

    const maxH = container.clientHeight * previewScale;
    const maxW = container.clientWidth * previewScale;

    let lo = 10, hi = 120;
    titleText.style.fontSize = hi + 'px';

    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        titleText.style.fontSize = mid + 'px';
        if (titleText.offsetHeight <= maxH && titleText.offsetWidth <= maxW) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    titleText.style.setProperty('--title-font-px', lo.toString());
    titleText.style.fontSize = lo + 'px';
}

function createTitlePageElement(title) {
    const pageDiv = document.createElement('div');
    pageDiv.className = 'mb-4';

    const paperDiv = document.createElement('div');
    paperDiv.className = 'b5-paper';

    const coverContainer = document.createElement('div');
    coverContainer.className = 'title-cover-container';

    const titleText = document.createElement('div');
    titleText.className = 'title-cover-text';
    titleText.textContent = title;

    coverContainer.appendChild(titleText);
    paperDiv.appendChild(coverContainer);
    pageDiv.appendChild(paperDiv);

    return pageDiv;
}

function createPageElement(pageLines, index) {
    const pageDiv = document.createElement('div');
    pageDiv.className = 'mb-4';

    const paperDiv = document.createElement('div');
    paperDiv.className = 'b5-paper';

    const svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgOverlay.style.position = 'absolute';
    svgOverlay.style.top = '0';
    svgOverlay.style.left = '0';
    svgOverlay.style.width = '100%';
    svgOverlay.style.height = '100%';
    svgOverlay.style.pointerEvents = 'none';
    svgOverlay.style.zIndex = '5';
    svgOverlay.setAttribute('viewBox', '0 0 100 100');

    const horizontalLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    horizontalLine.setAttribute('x1', '2.5');
    horizontalLine.setAttribute('y1', '20');
    horizontalLine.setAttribute('x2', '97.5');
    horizontalLine.setAttribute('y2', '20');
    horizontalLine.setAttribute('stroke', '#000000');
    horizontalLine.setAttribute('stroke-width', '0.15');
    svgOverlay.appendChild(horizontalLine);

    const containerDiv = document.createElement('div');
    containerDiv.className = 'vertical-text-container';

    const textDiv = document.createElement('div');
    textDiv.className = 'vertical-text';

    pageLines.forEach((lineObj, lineIndex) => {
        if (lineObj.isScene) {
            const lineDiv = document.createElement('div');
            lineDiv.textContent = lineObj.text;
            lineDiv.classList.add('scene-line');
            if (lineObj.originalLineIndex !== undefined) {
                lineDiv.dataset.lineIndex = lineObj.originalLineIndex;
            }
            textDiv.appendChild(lineDiv);
        } else {
            const lineSpan = document.createElement('span');
            const lineText = lineObj.text;
            const quoteStartIndex = lineText.search(/[「『]/);

            if (lineObj.isDialogueLine && quoteStartIndex > 0) {
                // 発言者名の幅揃えは format.js 側で済んでいる（折り返し幅の
                // 計算に反映させる必要があるため）。ここでは空白の固定幅化だけ行う。
                appendDialoguePrefixWithFixedSpaces(lineSpan, lineText.slice(0, quoteStartIndex));
                lineSpan.appendChild(document.createTextNode(lineText.slice(quoteStartIndex)));
            } else {
                lineSpan.textContent = lineText;
            }

            if (lineObj.originalLineIndex !== undefined) {
                lineSpan.dataset.lineIndex = lineObj.originalLineIndex;
            }

            if (lineIndex < pageLines.length - 1) {
                lineSpan.appendChild(document.createTextNode('\n'));
            }

            textDiv.appendChild(lineSpan);
        }
    });

    const pageNumberDiv = document.createElement('div');
    pageNumberDiv.className = 'page-number';
    pageNumberDiv.textContent = `${index + 1}`;

    containerDiv.appendChild(textDiv);
    paperDiv.appendChild(containerDiv);
    paperDiv.appendChild(svgOverlay);
    paperDiv.appendChild(pageNumberDiv);
    pageDiv.appendChild(paperDiv);

    return pageDiv;
}

/**
 * 縦書きプレビュー更新関数
 *
 * 【処理フロー】
 * 1. エディタテキスト取得
 * 2. ページ形式変換
 * 3. 既存プレビュークリア
 * 4. 新プレビュー生成・表示
 *
 * リアルタイム更新：inputイベントで自動実行
 */
function updateVerticalDisplay() {
    const startTime = performance.now();
    const editor = document.getElementById('editor');
    const pagesContainer = document.getElementById('pages-container');
    const scrollEl = pagesContainer?.closest('.column-content');
    const savedScrollTop = scrollEl instanceof HTMLElement ? scrollEl.scrollTop : 0;

    const pages = formatVerticalTextToPages(editor.value);

    pagesContainer.innerHTML = '';

    const title = document.querySelector('.titleInput')?.value?.trim();
    if (title) {
        const titlePage = createTitlePageElement(title);
        pagesContainer.appendChild(titlePage);
        const titleText = titlePage.querySelector('.title-cover-text');
        if (titleText instanceof HTMLElement) adjustTitleFontSize(titleText);
    }

    pages.forEach((pageLines, index) => {
        pagesContainer.appendChild(createPageElement(pageLines, index));
    });

    if (scrollEl instanceof HTMLElement) scrollEl.scrollTop = savedScrollTop;

    // アウトラインタブが開いている場合は柱書リストを更新
    if (activeTab === 'outline') buildSceneList();

    // ミラーを更新（jumpEditor のスクロール位置計算に使用）
    updateMirror();
    lastPreviewUpdateDuration = performance.now() - startTime;
}

/* 
========================================
ファイル操作システム
========================================
*/

/**
 * テキスト保存関数（モダンAPI対応）
 * 
 * 【保存方式】
 * 1. File System Access API（Chrome/Edge - 保存先指定可能）
 * 2. 従来ダウンロード方式（その他ブラウザ）
 * 
 * @returns {Promise<void>} 非同期処理
 */
let currentFileHandle = null;
let currentFileName = null;
let activeTab = 'usage'; // 'usage' | 'outline'

async function saveText(forceNewFile = false) {
    const editor = document.getElementById('editor');
    const titleInput = document.querySelector('.titleInput');
    const title = titleInput?.value?.trim() || '';
    const text = editor.value;

    if (!text.trim()) {
        showNotification('保存するテキストがありません。', 'warning');
        return;
    }

    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const filename = title ? `${title}_${timestamp}.txt` : `台本_${timestamp}.txt`;
    const contentToSave = title ? `${title}\n\n${text}` : text;

    // File System Access API対応ブラウザでの処理
    if ('showSaveFilePicker' in window) {
        try {
            // 上書き保存：既存ファイルがある && 新規保存を強制しない場合
            if (currentFileHandle && !forceNewFile) {
                const writable = await currentFileHandle.createWritable();
                await writable.write(contentToSave);
                await writable.close();
                markAsSavedToFile();
                showNotification(`「${currentFileName}」を上書き保存しました。`, 'success');
                return;
            }

            // 新規保存（名前を付けて保存）
            const fileHandle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [{
                    description: 'テキストファイル',
                    accept: { 'text/plain': ['.txt'] }
                }]
            });

            const writable = await fileHandle.createWritable();
            await writable.write(contentToSave);
            await writable.close();

            // ファイルハンドルと名前を保存
            currentFileHandle = fileHandle;
            currentFileName = fileHandle.name;

            markAsSavedToFile();
            showNotification(`「${currentFileName}」を保存しました。`, 'success');
            return;
        } catch (error) {
            if (error.name === 'AbortError') return;
            console.error('保存エラー:', error);
            showNotification('保存に失敗しました。別名で保存を試みます。', 'error');
        }
    }

    // 従来方式（上書き保存不可）
    const blob = new Blob([contentToSave], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;

    // 自動ダウンロード実行
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // メモリ解放
    URL.revokeObjectURL(link.href);

    markAsSavedToFile();
    showNotification(`ファイル「${filename}」がダウンロードフォルダに保存されました。`, 'success');
}

/**
 * テキスト名前を付けて保存関数
 * 
 * 【処理フロー】
 * 1. エディタテキスト取得
 * 2. ファイル名入力ダイアログ表示
 * 3. テキストファイルとして保存
 * 
 * @returns {Promise<void>} 非同期処理
 */
async function saveAsText() {
    await saveText(true); // 強制的に新規保存
}

/* 
========================================
通知システム
========================================
*/

/**
 * トースト通知表示関数
 * 
 * 【アニメーション】
 * - 表示：右からスライドイン
 * - 非表示：右にスライドアウト
 * - 自動消去：3秒後
 * 
 * @param {string} message - 表示メッセージ
 * @param {string} type - 通知種類（success/warning/error）
 */
function showNotification(message, type = 'success') {
    // 通知要素作成
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;

    // DOM追加
    document.body.appendChild(notification);

    // アニメーション：フェードイン（0.1秒後）
    setTimeout(() => {
        notification.classList.add('show');
    }, 100);

    // アニメーション：フェードアウト開始（3秒後）
    setTimeout(() => {
        notification.classList.add('fade-out');
    }, 3000);

    // DOM削除（4秒後）
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 4000);
}

/* 
========================================
ユーザーインタラクション
========================================
*/

// リアルタイムプレビュー更新：入力時イベント
const debouncedUpdateVerticalDisplay = debounce(updateVerticalDisplay, PREVIEW_UPDATE_DEBOUNCE_MS);

function handleEditorInput() {
    debouncedWriteDraft();

    if (lastPreviewUpdateDuration >= PREVIEW_UPDATE_SYNC_THRESHOLD_MS) {
        debouncedUpdateVerticalDisplay();
        return;
    }

    updateVerticalDisplay();
}

const DEFAULT_TITLE = document.title;

document.getElementById('editor').addEventListener('input', handleEditorInput);
document.querySelector('.titleInput').addEventListener('input', () => {
    const workTitle = document.querySelector('.titleInput').value.trim();
    document.title = workTitle || DEFAULT_TITLE;
    debouncedWriteDraft();
    updateVerticalDisplay();
});

/**
 * 印刷実行関数
 *
 * ブラウザ印刷ダイアログ起動
 * CSS @media printによりプレビュー部分のみ印刷
 */
function printPages() {
    window.print();
}

/*
========================================
下書きの自動保存と未保存警告
========================================
ブラウザ上で長文を書くツールなので、タブを閉じただけで内容が消えないようにする。
- localStorage への下書き保存：入力のたびに上書きし、次回起動時に自動復元する
- beforeunload での警告：ファイルへ書き出していない変更がある場合のみ出す

「保存済み」の基準はあくまでファイルへの書き出し。下書きが残っていても
ユーザーの認識では未保存なので、両者は別に扱う。
*/

const DRAFT_STORAGE_KEY = 'straw.draft.v1';
const DRAFT_SAVE_DEBOUNCE_MS = 800;

/**
 * 未保存判定・下書き保存に共通で使うスナップショット表現
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function snapshotOf(title, body) {
    return JSON.stringify({ title, body });
}

/** @returns {string} 現在の編集内容のスナップショット */
function currentSnapshot() {
    const titleInput = /** @type {HTMLInputElement | null} */ (document.querySelector('.titleInput'));
    const editor = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('editor'));
    return snapshotOf(titleInput?.value ?? '', editor?.value ?? '');
}

// 最後にファイルへ書き出した時点の内容。初期値は「空の状態」。
let lastSavedSnapshot = snapshotOf('', '');

function hasUnsavedChanges() {
    return currentSnapshot() !== lastSavedSnapshot;
}

/** ファイルへの保存・読み込み直後に呼び、その時点を「保存済み」の基準にする */
function markAsSavedToFile() {
    lastSavedSnapshot = currentSnapshot();
    writeDraft();
}

/**
 * 下書きを localStorage へ書く。
 * 未保存フラグも一緒に持たせることで、リロードを挟んでも警告の状態を保てる。
 * 下書きは補助機能なので、書き込みに失敗しても操作は止めない。
 */
function writeDraft() {
    const titleInput = /** @type {HTMLInputElement | null} */ (document.querySelector('.titleInput'));
    const editor = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('editor'));

    try {
        localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({
            title: titleInput?.value ?? '',
            body: editor?.value ?? '',
            savedSnapshot: lastSavedSnapshot
        }));
    } catch (error) {
        // 容量超過・プライベートモード・ストレージ無効など
        console.warn('下書きの保存に失敗しました:', error);
    }
}

const debouncedWriteDraft = debounce(writeDraft, DRAFT_SAVE_DEBOUNCE_MS);

/**
 * 起動時に下書きを復元する。
 * 下書きは入力のたびに上書きしているため、常に前回終了時点の内容と一致する。
 *
 * @returns {boolean} 復元したか
 */
function restoreDraft() {
    let draft;
    try {
        const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
        if (!raw) return false;
        draft = JSON.parse(raw);
    } catch (error) {
        return false; // ストレージが使えない、または壊れた下書き
    }

    if (!draft || (!draft.title && !draft.body)) return false;

    const titleInput = /** @type {HTMLInputElement} */ (document.querySelector('.titleInput'));
    const editor = /** @type {HTMLTextAreaElement} */ (document.getElementById('editor'));

    titleInput.value = draft.title ?? '';
    editor.value = draft.body ?? '';
    document.title = draft.title || DEFAULT_TITLE;
    lastSavedSnapshot = draft.savedSnapshot ?? snapshotOf('', '');

    return true;
}

/**
 * 読み込んだテキストをエディタへ反映する共通処理。
 * loadText（File System Access API）と handleFileSelect（従来方式）の両方から使う。
 *
 * @param {string} rawContent - ファイルの生テキスト
 * @param {string} fileName - 表示・保存に使うファイル名
 * @param {FileSystemFileHandle | null} fileHandle - 上書き保存用ハンドル（従来方式では null）
 */
function applyLoadedContent(rawContent, fileName, fileHandle) {
    const content = normalizeNewlines(rawContent);
    const { title, body } = splitTitleAndBody(content);

    document.querySelector('.titleInput').value = title;
    document.getElementById('editor').value = body;
    document.title = title || DEFAULT_TITLE;

    updateVerticalDisplay();

    // 上書き保存用の状態を更新（従来方式はハンドルを取得できないので null）
    currentFileHandle = fileHandle;
    currentFileName = fileName;

    // 読み込み直後はファイルと一致しているので「保存済み」の基準にする
    markAsSavedToFile();

    if (buildSceneList()) switchLeftTab('outline');

    showNotification(`ファイル「${fileName}」を読み込みました。`, 'success');
}

/**
 * ファイル読み込みトリガー関数
 *
 * File System Access API対応ブラウザでは直接ファイルを開き、
 * その他のブラウザでは隠しファイル入力要素を使用
 */
async function loadText() {
    // File System Access API対応ブラウザでの処理
    if ('showOpenFilePicker' in window) {
        try {
            const [fileHandle] = await window.showOpenFilePicker({
                types: [{
                    description: 'テキストファイル',
                    accept: { 'text/plain': ['.txt'] }
                }]
            });

            const file = await fileHandle.getFile();
            applyLoadedContent(await file.text(), fileHandle.name, fileHandle);
        } catch (error) {
            if (error.name === 'AbortError') return; // ユーザーキャンセル
            console.error('ファイル読み込みエラー:', error);
            showNotification('ファイルの読み込みに失敗しました。', 'error');
        }
    } else {
        // 従来方式：隠しファイル入力要素を使用
        const fileInput = document.getElementById('fileInput');
        fileInput.click();
    }
}

/**
 * ファイル選択処理関数（従来方式用）
 * 
 * 【処理フロー】
 * 1. ファイル形式検証
 * 2. FileReader API使用
 * 3. エディタに内容設定
 * 4. プレビュー更新
 * 
 * @param {Event} event - ファイル選択イベント
 */
function handleFileSelect(event) {
    const file = event.target.files[0];

    if (!file) {
        return; // ファイル未選択
    }

    // ファイル形式検証
    if (!file.type.includes('text') && !file.name.toLowerCase().endsWith('.txt')) {
        showNotification('テキストファイル(.txt)を選択してください。', 'warning');
        return;
    }

    // 
    // ========== FileReader使用ファイル読み込み ==========
    // 
    const reader = new FileReader();

    // 読み込み成功処理
    reader.onload = function(e) {
        try {
            // 従来方式ではファイルハンドルを取得できないため上書き保存は不可
            applyLoadedContent(String(e.target.result), file.name, null);
        } catch (error) {
            console.error('ファイル読み込みエラー:', error);
            showNotification('ファイルの読み込み中にエラーが発生しました。', 'error');
        }
    };

    // 読み込み失敗処理
    reader.onerror = function() {
        showNotification('ファイルの読み込みに失敗しました。', 'error');
    };

    // UTF-8テキスト読み込み開始
    reader.readAsText(file, 'UTF-8');

    // ファイル入力リセット（同一ファイル再選択対応）
    event.target.value = '';
}

/* 
========================================
アプリケーション初期化
========================================
*/

// 前回の下書きがあれば復元してから初期プレビューを表示する
const draftRestored = restoreDraft();

updateVerticalDisplay();

if (draftRestored) {
    if (buildSceneList()) switchLeftTab('outline');
    showNotification('前回の続きを復元しました。', 'success');
}

// 未保存の変更があるまま離脱しようとしたら確認する
// （文言はブラウザ側が決めるため、こちらからは指定できない）
window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    // preventDefault() だけで足りるのは比較的新しいブラウザのみ。
    // 古い Safari / Firefox 向けに非推奨の returnValue も併用する。
    event.returnValue = '';
});

// 離脱・バックグラウンド化の直前に下書きを確定させる
// （debounce 待ちのぶんを取りこぼさないため。モバイルではタブが
//   そのまま破棄されることがあるので visibilitychange も拾う）
window.addEventListener('pagehide', writeDraft);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') writeDraft();
});

// 柱書リストのクリックを委譲（リスト再構築ごとにリスナーを作り直さない）
document.getElementById('scene-list').addEventListener('click', (e) => {
    const item = e.target.closest('.scene-list-item');
    if (item) jumpToScene(parseInt(item.dataset.lineIndex, 10));
});

// プレビュークリックでエディタの対応行にジャンプ
document.getElementById('pages-container').addEventListener('click', (e) => {
    const el = e.target.closest('[data-line-index]');
    if (el) jumpEditor(parseInt(el.dataset.lineIndex, 10));
});

// エディタのカーソル移動でプレビューの対応行にスクロール
/** @type {ReturnType<typeof setTimeout> | undefined} */
let _previewSyncTimer;
const _editorEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('editor'));
_editorEl.addEventListener('selectionchange', () => {
    clearTimeout(_previewSyncTimer);
    _previewSyncTimer = setTimeout(() => {
        if (document.activeElement !== _editorEl) return;
        const lineIndex = _editorEl.value.substring(0, _editorEl.selectionStart ?? 0).split('\n').length - 1;
        const pagesContainer = document.getElementById('pages-container');
        if (!pagesContainer) return;
        let el = pagesContainer.querySelector(`[data-line-index="${lineIndex}"]`);
        if (!el) {
            for (let d = 1; d <= 30 && !el; d++) {
                el = pagesContainer.querySelector(`[data-line-index="${lineIndex - d}"]`) ||
                     pagesContainer.querySelector(`[data-line-index="${lineIndex + d}"]`);
            }
        }
        if (!el) return;
        const scrollEl = /** @type {HTMLElement | null} */ (pagesContainer.closest('.column-content'));
        if (!scrollEl) return;
        const scrollRect = scrollEl.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        // 要素がすでに可視域内なら何もしない
        if (elRect.top >= scrollRect.top && elRect.bottom <= scrollRect.bottom) return;
        // 要素を縦中央に来るようスクロール
        const targetScrollTop = scrollEl.scrollTop + (elRect.top - scrollRect.top) - scrollEl.clientHeight / 2;
        scrollEl.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });
    }, 120);
});

/*
========================================
アウトライン（柱書リスト）システム
========================================
*/

// タブ切り替え
function switchLeftTab(tabName) {
    activeTab = tabName;
    document.getElementById('panel-usage').hidden = tabName !== 'usage';
    document.getElementById('panel-outline').hidden = tabName !== 'outline';
    document.getElementById('tab-btn-usage').classList.toggle('active', tabName === 'usage');
    document.getElementById('tab-btn-outline').classList.toggle('active', tabName === 'outline');
    if (tabName === 'outline') buildSceneList();
}

// 柱書リスト構築
function buildSceneList() {
    const editor = document.getElementById('editor');
    const lines = editor.value.split('\n');
    const container = document.getElementById('scene-list');
    container.innerHTML = '';
    let sceneCounter = 1;
    let found = false;

    lines.forEach((line, lineIndex) => {
        const trimmed = line.trim();
        const manualMatch = trimmed.match(MANUAL_SCENE_REGEX);
        const autoMatch = !manualMatch && trimmed.match(AUTO_SCENE_REGEX);
        if (!manualMatch && !autoMatch) return;
        found = true;

        let label, rest;
        if (manualMatch) {
            label = manualMatch[1];
            rest = line.replace(MANUAL_SCENE_STRIP_REGEX, '').trim();
        } else {
            label = String(sceneCounter++);
            rest = line.replace(AUTO_SCENE_STRIP_REGEX, '').trim();
        }

        const item = document.createElement('div');
        item.className = 'scene-list-item';

        const numSpan = document.createElement('span');
        numSpan.className = 'scene-number';
        numSpan.textContent = label;

        const textSpan = document.createElement('span');
        textSpan.className = 'scene-text';
        textSpan.textContent = rest || '（無題）';

        item.dataset.lineIndex = lineIndex;
        item.appendChild(numSpan);
        item.appendChild(textSpan);
        container.appendChild(item);
    });

    if (!found) {
        const empty = document.createElement('p');
        empty.className = 'scene-list-empty';
        empty.textContent = '柱書がありません';
        container.appendChild(empty);
    }

    return found;
}

// エディターとプレビューの両方にジャンプ
function jumpToScene(lineIndex) {
    jumpEditor(lineIndex);
    const mobileControls = document.querySelector('.mobile-panel-controls');
    if (mobileControls && getComputedStyle(mobileControls).display !== 'none') {
        hideSidePanels();
    } else {
        jumpPreview(lineIndex);
    }
}

/*
========================================
エディターミラーシステム
テキストエリアの後ろに不可視のミラーdivを配置し、
各行の実際のDOM位置（折り返し込み）を取得してジャンプに使用する。
========================================
*/

/**
 * ミラーdiv更新：入力テキストの各行をspanで分割して格納
 * テキストエリアと同じフォント・幅なので、offsetTop が実際の行位置と一致する
 */
function updateMirror() {
    const editor = document.getElementById('editor');
    const mirror = document.getElementById('editor-mirror');
    if (!mirror) return;
    const lines = editor.value.split('\n');
    mirror.innerHTML = '';
    lines.forEach((line, index) => {
        const span = document.createElement('span');
        span.dataset.lineIndex = index;
        // 改行文字をテキストとして含めることで、テキストエリアと同じ折り返しを再現
        span.textContent = line + (index < lines.length - 1 ? '\n' : '');
        mirror.appendChild(span);
    });
}

// エディターの指定行にジャンプ・選択
function jumpEditor(lineIndex) {
    const editor = document.getElementById('editor');
    const mirror = document.getElementById('editor-mirror');
    const lines = editor.value.split('\n');
    let charPos = 0;
    for (let i = 0; i < lineIndex; i++) charPos += lines[i].length + 1;
    const lineLen = (lines[lineIndex] || '').length;

    // ミラーのspanのoffsetTopから正確なスクロール位置を取得
    // lineIndex * lineH の推計より正確（長い行の折り返しを考慮済み）
    const span = mirror && mirror.querySelector(`[data-line-index="${lineIndex}"]`);
    let targetScrollTop;
    if (span) {
        targetScrollTop = Math.max(0, span.offsetTop - editor.clientHeight / 2);
    } else {
        // フォールバック（ミラーが使えない場合）
        const style = window.getComputedStyle(editor);
        const lineH = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
        const padT = parseFloat(style.paddingTop);
        targetScrollTop = Math.max(0, lineIndex * lineH + padT - editor.clientHeight / 2);
    }

    editor.focus({ preventScroll: true });
    // 先にスクロールすることで選択範囲が可視域内に入り、
    // setSelectionRange がスクロールを起こさない状態を作る
    editor.scrollTop = targetScrollTop;
    editor.setSelectionRange(charPos, charPos + lineLen);
    editor.scrollTop = targetScrollTop;
}

// プレビューの該当柱書ページにジャンプ
function jumpPreview(lineIndex) {
    const sceneEl = document.querySelector(`.scene-line[data-line-index="${lineIndex}"]`);
    if (!sceneEl) return;
    const pageDiv = sceneEl.closest('.mb-4');
    if (pageDiv) pageDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/*
========================================
カラムリサイズシステム
========================================
*/

function initResizers() {
    const row = document.querySelector('.row');
    const leftCol = document.querySelector('.left-column');
    const centerCol = document.querySelector('.center-column');
    const rightCol = document.querySelector('.right-column');
    const dividerLeft = document.getElementById('divider-left');
    const dividerRight = document.getElementById('divider-right');

    const DIVIDER_WIDTH = 5;
    const MIN_LEFT = 100;
    const MIN_CENTER = 200;
    const MIN_RIGHT = 200;

    // 右カラムは flex:1 で残り幅を自動的に埋める
    rightCol.style.flex = '1';
    rightCol.style.minWidth = MIN_RIGHT + 'px';

    function initWidths() {
        const totalWidth = row.getBoundingClientRect().width;
        const available = totalWidth - DIVIDER_WIDTH * 2;
        const leftWidth = 260;
        const rightTarget = 440; // B5用紙(400px) × 110% + padding(40px)
        const centerWidth = Math.max(MIN_CENTER, available - leftWidth - rightTarget);
        leftCol.style.width = leftWidth + 'px';
        centerCol.style.width = centerWidth + 'px';
    }

    function handleResize() {
        const totalWidth = row.getBoundingClientRect().width;
        // 右カラムが MIN_RIGHT を確保できる上限
        const maxLeftCenter = totalWidth - DIVIDER_WIDTH * 2 - MIN_RIGHT;
        const currentLeft = leftCol.getBoundingClientRect().width;
        const currentCenter = centerCol.getBoundingClientRect().width;
        const currentSum = currentLeft + currentCenter;

        // 右カラムに十分なスペースがある場合は何もしない（右が自動で広がる）
        if (currentSum <= maxLeftCenter) return;

        // ウィンドウが縮んで右カラムが圧迫される場合、左・中を比率を保ちながら縮める
        const ratio = maxLeftCenter / currentSum;
        let newLeft = Math.round(currentLeft * ratio);
        let newCenter = maxLeftCenter - newLeft;
        if (newLeft < MIN_LEFT) { newLeft = MIN_LEFT; newCenter = maxLeftCenter - newLeft; }
        if (newCenter < MIN_CENTER) { newCenter = MIN_CENTER; newLeft = maxLeftCenter - newCenter; }

        leftCol.style.width = newLeft + 'px';
        centerCol.style.width = newCenter + 'px';
    }

    window.addEventListener('resize', handleResize);

    function setupDivider(divider, colA, colB, minA, minB) {
        divider.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startA = colA.getBoundingClientRect().width;
            const startB = colB.getBoundingClientRect().width;

            function onMove(e) {
                const dx = e.clientX - startX;
                const newA = startA + dx;
                const newB = startB - dx;
                if (colB === rightCol) {
                    // 右カラムは flex:1 なので実際の残り幅で最小幅チェック
                    const rightWidth = row.getBoundingClientRect().width
                        - DIVIDER_WIDTH * 2
                        - leftCol.getBoundingClientRect().width
                        - newA;
                    if (newA >= minA && rightWidth >= minB) {
                        colA.style.width = newA + 'px';
                    }
                } else {
                    if (newA >= minA && newB >= minB) {
                        colA.style.width = newA + 'px';
                        colB.style.width = newB + 'px';
                    }
                }
            }

            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                divider.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            divider.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });
    }

    requestAnimationFrame(initWidths);
    setupDivider(dividerLeft, leftCol, centerCol, MIN_LEFT, MIN_CENTER);
    setupDivider(dividerRight, centerCol, rightCol, MIN_CENTER, MIN_RIGHT);
}

initResizers();


// キーボードショートカット（Cmd+S）でファイル保存
document.addEventListener('keydown', function(event) {
    // Macの場合：Cmd+S、WindowsLinuxの場合：Ctrl+S
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault(); // ブラウザのデフォルト保存動作を無効化
        saveText(); // 既存の保存関数を呼び出し
    }
});

/*
========================================
狭幅・縦長ビューポート用：サイドパネル切替
========================================
*/

/**
 * 左の使い方・アウトラインパネルを表示する
 */
function showLeftPanel() {
    if (document.body.classList.contains('show-left-panel')) {
        hideSidePanels();
    } else {
        document.body.classList.add('show-left-panel');
        document.body.classList.remove('show-right-panel');
    }
}

/**
 * 右のプレビューパネルを表示する
 */
function showRightPanel() {
    if (document.body.classList.contains('show-right-panel')) {
        hideSidePanels();
    } else {
        document.body.classList.add('show-right-panel');
        document.body.classList.remove('show-left-panel');
    }
}

/**
 * 左右のサイドパネルを閉じる
 */
function hideSidePanels() {
    document.body.classList.remove('show-left-panel', 'show-right-panel');
}
