/*
========================================
アプリケーションコア：テキスト処理エンジン
========================================
*/

// 柱書検出パターン（複数箇所で共通使用）
const MANUAL_SCENE_REGEX = /^【([^】]+)】[◯○◎◇□＊☆]/;
const AUTO_SCENE_REGEX = /^[◯○◎◇□＊☆]/;

/**
 * 縦書きB5ページ分割メイン関数
 * 
 * 【機能概要】
 * 入力テキストを台本用B5縦書きレイアウトに変換
 * - B5用紙サイズ：1ページ17行、1行29文字
 * - 日本語禁則処理：句読点・括弧の適切な改行制御
 * - 柱書処理：自動番号振り（◯○◎◇□＊☆ → 数字）
 * - セリフ行処理：カギカッコ行の自動インデント
 * 
 * @param {string} text - 入力テキスト（改行区切り）
 * @returns {Array<Array<Object>>} ページ配列（各ページは行オブジェクトの配列）
 *   行オブジェクト形式：{ text: string, isScene: boolean }
 */
function formatVerticalTextToPages(text) {
    // 
    // ========== B5縦書きレイアウト制約 ==========
    // 
    const maxLines = 17;                    // 1ページ最大行数
    const maxCharsPerLine = 29;             // 1行最大文字数
    const lines = text.split('\n');         // 入力を行単位に分割
    let allFormattedLines = [];             // 整形後全行格納配列
    let sceneNumber = 1;                    // 柱書連番カウンタ

    // 
    // ========== 日本語禁則処理設定 ==========
    // 
    const startChars = '。、？！」』）〕］｝〉》】〗〙〛ー：；'; // 行頭禁止文字
    const endChars = '「『（〔［｛〈《【〖〘〚';                // 行末禁止文字
    /**
     * 禁則処理判定関数
     * 
     * 【判定ロジック】
     * 1. 行末禁止文字（開き括弧等）の後では改行不可
     * 2. 行頭禁止文字（句読点等）の前では改行不可
     * 
     * @param {string} char - 現在文字
     * @param {string} nextChar - 次文字
     * @returns {boolean} 改行可能フラグ
     */
    function canBreakAfter(char, nextChar) {
        if (endChars.includes(char)) return false; // 行末禁止文字チェック
        if (nextChar && startChars.includes(nextChar)) return false; // 行頭禁止文字チェック
        return true; // その他は改行可能
    }

    /**
     * 最適改行位置探索関数
     * 
     * 【探索アルゴリズム】
     * 1. 最大文字数から逆方向に探索
     * 2. 禁則処理に適合する位置を優先
     * 3. 最大5文字手前まで探索
     * 4. 見つからない場合は強制切断
     * 
     * @param {string} text - 対象テキスト
     * @param {number} maxLength - 最大文字数
     * @returns {number} 最適改行位置インデックス
     */
    function findBreakPoint(text, maxLength) {
        if (text.length <= maxLength) return maxLength; // 制限内ならそのまま

        // 逆方向探索：最大5文字手前まで
        for (let i = maxLength; i > Math.max(1, maxLength - 5); i--) {
            if (i >= text.length) continue; // 範囲外スキップ

            const char = text[i - 1]; // 改行直前文字
            const nextChar = text[i]; // 改行直後文字

            if (canBreakAfter(char, nextChar)) {
                return i; // 適切な位置発見
            }
        }

        return maxLength; // 強制切断
    }

    // 
    // ========== 各行処理メインループ ==========
    // 
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        // 空行処理：そのまま追加
        if (line.length === 0) {
            allFormattedLines.push({ text: '', isScene: false, originalLineIndex: lineIdx });
            continue;
        }

        // 
        // ========== 柱書処理 ==========

        // パターン1：手動指定 - 【】で囲まれた文字列 + 記号
        // パターン2：自動連番 - 行頭の ◯○◎◇□＊☆ を番号に変換
        // 

        // 手動指定パターンの検出（【文字列】 + 記号）
        const manualSceneMatch = line.trim().match(MANUAL_SCENE_REGEX);

        if (manualSceneMatch) {
            // 手動指定の柱書処理
            const manualSceneText = manualSceneMatch[1]; // 【】内の文字列

            // 文字数を5文字に揃える：4文字以下なら右揃え＋空白、5文字以上なら切り詰め
            let formattedSceneText;
            if (manualSceneText.length <= 4) {
                // 4文字以下：右揃えで空白埋め（例：「1A」→「   1A 」）
                formattedSceneText = manualSceneText.padStart(4, ' ') + ' ';
            } else {
                // 5文字以上：5文字で切り詰め（例：「シーン1回想場面」→「シーン1回想場」）
                formattedSceneText = manualSceneText.substring(0, 5);
            }

            const sceneText = line.replace(/^(\s*)【[^】]+】[◯○◎◇□＊☆]/, `$1${formattedSceneText}`);

            // 柱書の折り返し処理
            const indentMatch = sceneText.match(/^(\s*)/);
            const baseIndent = indentMatch ? indentMatch[1] : '';

            if (sceneText.length <= maxCharsPerLine) {
                // 1行以内：そのまま追加
                allFormattedLines.push({ text: sceneText, isScene: true, originalLineIndex: lineIdx });
            } else {
                // 折り返し必要：分割処理
                const firstLineBreak = findBreakPoint(sceneText, maxCharsPerLine);
                const firstLine = sceneText.substring(0, firstLineBreak);
                allFormattedLines.push({ text: firstLine, isScene: true, originalLineIndex: lineIdx });

                // 残りテキスト処理
                let remainingText = sceneText.substring(firstLineBreak);

                while (remainingText.length > 0) {
                    const availableSpace = maxCharsPerLine - baseIndent.length;

                    if (availableSpace <= 0) {
                        // インデント過大：強制切断
                        const breakPoint = findBreakPoint(remainingText, maxCharsPerLine);
                        allFormattedLines.push({ text: remainingText.substring(0, breakPoint), isScene: true });
                        remainingText = remainingText.substring(breakPoint);
                    } else if (remainingText.length <= availableSpace) {
                        // 残り全部収まる：完了
                        allFormattedLines.push({ text: baseIndent + remainingText, isScene: true });
                        break;
                    } else {
                        // 分割継続
                        const breakPoint = findBreakPoint(remainingText, availableSpace);
                        allFormattedLines.push({ text: baseIndent + remainingText.substring(0, breakPoint), isScene: true });
                        remainingText = remainingText.substring(breakPoint);
                    }
                }
            }
            continue;
        }

        // 自動連番パターンの検出（記号のみ）
        if (line.trim().match(AUTO_SCENE_REGEX)) {
            // 番号変換：記号 → "   1 "形式（4桁+空白）
            const sceneNumber4Digits = String(sceneNumber).padStart(4, ' ') + ' ';
            const sceneText = line.replace(/^\s*[◯○◎◇□＊☆]/, sceneNumber4Digits);
            sceneNumber++; // 連番インクリメント

            // 柱書の折り返し処理
            const indentMatch = sceneText.match(/^(\s*)/);
            const baseIndent = indentMatch ? indentMatch[1] : '';

            if (sceneText.length <= maxCharsPerLine) {
                // 1行以内：そのまま追加
                allFormattedLines.push({ text: sceneText, isScene: true, originalLineIndex: lineIdx });
            } else {
                // 折り返し必要：分割処理
                const firstLineBreak = findBreakPoint(sceneText, maxCharsPerLine);
                const firstLine = sceneText.substring(0, firstLineBreak);
                allFormattedLines.push({ text: firstLine, isScene: true, originalLineIndex: lineIdx });

                // 残りテキスト処理
                let remainingText = sceneText.substring(firstLineBreak);

                while (remainingText.length > 0) {
                    const availableSpace = maxCharsPerLine - baseIndent.length;

                    if (availableSpace <= 0) {
                        // インデント過大：強制切断
                        const breakPoint = findBreakPoint(remainingText, maxCharsPerLine);
                        allFormattedLines.push({ text: remainingText.substring(0, breakPoint), isScene: true });
                        remainingText = remainingText.substring(breakPoint);
                    } else if (remainingText.length <= availableSpace) {
                        // 残り全部収まる：完了
                        allFormattedLines.push({ text: baseIndent + remainingText, isScene: true });
                        break;
                    } else {
                        // 分割継続
                        const breakPoint = findBreakPoint(remainingText, availableSpace);
                        allFormattedLines.push({ text: baseIndent + remainingText.substring(0, breakPoint), isScene: true });
                        remainingText = remainingText.substring(breakPoint);
                    }
                }
            }
            continue;
        }

        // 
        // ========== 通常行処理 ==========
        // 

        // インデント検出
        const indentMatch = line.match(/^(\s*)/);
        const baseIndent = indentMatch ? indentMatch[1] : '';

        if (line.length <= maxCharsPerLine) {
            // 1行以内：そのまま追加
            allFormattedLines.push({ text: line, isScene: false, originalLineIndex: lineIdx });
        } else {
            // 
            // ========== 29文字超過：自動折り返し処理 ==========
            // 

            // 第1行の改行位置決定
            const firstLineBreak = findBreakPoint(line, maxCharsPerLine);
            const firstLine = line.substring(0, firstLineBreak);
            allFormattedLines.push({ text: firstLine, isScene: false, originalLineIndex: lineIdx });

            // セリフ行判定：元行全体でカギカッコ終了チェック
            const originalLineEndsWithQuote = line.trim().endsWith('」') || line.trim().endsWith('』');

            // 残りテキスト処理
            let remainingText = line.substring(firstLineBreak);

            while (remainingText.length > 0) {
                // 
                // ========== 2行目以降のインデント決定 ==========
                // 
                let currentIndent;
                if (originalLineEndsWithQuote) {
                    // セリフ行：4文字インデント
                    currentIndent = '　　　　'; // 全角スペース4文字
                } else {
                    // 通常行：元インデント継続
                    currentIndent = baseIndent;
                }

                // 利用可能文字数計算
                const availableSpace = maxCharsPerLine - currentIndent.length;

                if (availableSpace <= 0) {
                    // インデント過大：強制切断
                    const breakPoint = findBreakPoint(remainingText, maxCharsPerLine);
                    allFormattedLines.push({ text: remainingText.substring(0, breakPoint), isScene: false, originalLineIndex: lineIdx });
                    remainingText = remainingText.substring(breakPoint);
                } else if (remainingText.length <= availableSpace) {
                    // 残り全部収まる：完了
                    allFormattedLines.push({ text: currentIndent + remainingText, isScene: false, originalLineIndex: lineIdx });
                    break;
                } else {
                    // 分割継続
                    const breakPoint = findBreakPoint(remainingText, availableSpace);
                    allFormattedLines.push({ text: currentIndent + remainingText.substring(0, breakPoint), isScene: false, originalLineIndex: lineIdx });
                    remainingText = remainingText.substring(breakPoint);
                }
            }
        }
    }

    // 
    // ========== ページ分割処理 ==========
    // 17行制限によるページ分割（柱書は1.8行相当）
    // 
    const pages = [];
    let currentPage = [];
    let currentLineCount = 0;

    for (let lineObj of allFormattedLines) {
        // 行重み計算：柱書1.8行、通常行1行
        const lineWeight = lineObj.isScene ? 1.8 : 1;

        // ページ容量チェック：17行超過判定
        if (currentLineCount + lineWeight > maxLines && currentPage.length > 0) {
            // 現ページを17行で埋めて確定
            while (Math.ceil(currentLineCount) < maxLines) {
                currentPage.push({ text: '', isScene: false });
                currentLineCount += 1;
            }

            pages.push(currentPage); // ページ確定
            currentPage = []; // 新ページ開始
            currentLineCount = 0;
        }

        // 行追加
        currentPage.push(lineObj);
        currentLineCount += lineWeight;
    }

    // 最終ページ処理
    if (currentPage.length > 0) {
        // 17行まで空行で埋める
        while (Math.ceil(currentLineCount) < maxLines) {
            currentPage.push({ text: '', isScene: false });
            currentLineCount += 1;
        }
        pages.push(currentPage);
    }

    // 空テキスト用最低1ページ保証
    if (pages.length === 0) {
        const emptyPage = [];
        for (let i = 0; i < maxLines; i++) {
            emptyPage.push({ text: '', isScene: false });
        }
        pages.push(emptyPage);
    }

    return pages;
}

/* 
========================================
UI更新システム：プレビュー表示
========================================
*/

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
    // DOM要素取得
    const editor = document.getElementById('editor');
    const pagesContainer = document.getElementById('pages-container');

    // テキスト → ページ変換
    const pages = formatVerticalTextToPages(editor.value);

    // 既存表示クリア
    pagesContainer.innerHTML = '';

    // 
    // ========== 各ページHTML生成 ==========
    // 
    pages.forEach((pageLines, index) => {
        // ページ全体コンテナ
        const pageDiv = document.createElement('div');
        pageDiv.className = 'mb-4'; // ページ間マージン

        // B5用紙コンテナ
        const paperDiv = document.createElement('div');
        paperDiv.className = 'b5-paper';

        // 
        // ========== SVGオーバーレイ：水平線描画 ==========
        // 
        const svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svgOverlay.style.position = 'absolute'; // 絶対位置
        svgOverlay.style.top = '0';
        svgOverlay.style.left = '0';
        svgOverlay.style.width = '100%';
        svgOverlay.style.height = '100%';
        svgOverlay.style.pointerEvents = 'none'; // マウス透過
        svgOverlay.style.zIndex = '5'; // テキスト前面
        svgOverlay.setAttribute('viewBox', '0 0 100 100');

        // 水平線要素
        const horizontalLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        horizontalLine.setAttribute('x1', '2.5'); // 左端2.5%
        horizontalLine.setAttribute('y1', '20'); // 上から20%
        horizontalLine.setAttribute('x2', '97.5'); // 右端97.5%
        horizontalLine.setAttribute('y2', '20'); // 水平線
        horizontalLine.setAttribute('stroke', '#000000'); // 黒色
        horizontalLine.setAttribute('stroke-width', '0.15'); // 細線

        svgOverlay.appendChild(horizontalLine);

        // 
        // ========== 縦書きテキスト部分 ==========
        // 
        const containerDiv = document.createElement('div');
        containerDiv.className = 'vertical-text-container';

        const textDiv = document.createElement('div');
        textDiv.className = 'vertical-text';

        // 各行のHTML要素生成
        pageLines.forEach((lineObj, lineIndex) => {
            if (lineObj.isScene) {
                // 柱書：div要素使用（特別スタイル適用）
                const lineDiv = document.createElement('div');
                lineDiv.textContent = lineObj.text;
                lineDiv.classList.add('scene-line');
                if (lineObj.originalLineIndex !== undefined) {
                    lineDiv.dataset.lineIndex = lineObj.originalLineIndex;
                }
                textDiv.appendChild(lineDiv);
            } else {
                // 通常行：span要素使用
                const lineSpan = document.createElement('span');
                lineSpan.textContent = lineObj.text;
                if (lineObj.originalLineIndex !== undefined) {
                    lineSpan.dataset.lineIndex = lineObj.originalLineIndex;
                }

                // 最終行以外は改行追加
                if (lineIndex < pageLines.length - 1) {
                    lineSpan.appendChild(document.createTextNode('\n'));
                }

                textDiv.appendChild(lineSpan);
            }
        });

        // ページ番号
        const pageNumberDiv = document.createElement('div');
        pageNumberDiv.className = 'page-number';
        pageNumberDiv.textContent = `${index + 1}`; // 1開始番号

        // 
        // ========== DOM構造構築 ==========
        // 
        containerDiv.appendChild(textDiv);
        paperDiv.appendChild(containerDiv);
        paperDiv.appendChild(svgOverlay);
        paperDiv.appendChild(pageNumberDiv);
        pageDiv.appendChild(paperDiv);
        pagesContainer.appendChild(pageDiv);
    });

    // アウトラインタブが開いている場合は柱書リストを更新
    if (activeTab === 'outline') buildSceneList();

    // ミラーを更新（jumpEditor のスクロール位置計算に使用）
    updateMirror();
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
    const text = editor.value;
    const now = new Date();
    const filename = `台本_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}.txt`;

    if (!text.trim()) {
        showNotification('保存するテキストがありません。', 'warning');
        return;
    }

    // File System Access API対応ブラウザでの処理
    if ('showSaveFilePicker' in window) {
        try {
            // 上書き保存：既存ファイルがある && 新規保存を強制しない場合
            if (currentFileHandle && !forceNewFile) {
                const writable = await currentFileHandle.createWritable();
                await writable.write(text);
                await writable.close();
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
            await writable.write(text);
            await writable.close();

            // ファイルハンドルと名前を保存
            currentFileHandle = fileHandle;
            currentFileName = fileHandle.name;

            showNotification(`「${currentFileName}」を保存しました。`, 'success');
            return;
        } catch (error) {
            if (error.name === 'AbortError') return;
            console.error('保存エラー:', error);
        }
    }

    // 従来方式（上書き保存不可）
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;

    // 自動ダウンロード実行
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // メモリ解放
    URL.revokeObjectURL(link.href);

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
document.getElementById('editor').addEventListener('input', updateVerticalDisplay);

/**
 * 印刷実行関数
 * 
 * ブラウザ印刷ダイアログ起動
 * CSS @media printによりプレビュー部分のみ印刷
 */
function printPages() {
    window.print();
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
            const content = await file.text();

            const editor = document.getElementById('editor');
            editor.value = content;
            updateVerticalDisplay();

            // ファイルハンドルを保存（上書き保存用）
            currentFileHandle = fileHandle;
            currentFileName = fileHandle.name;

            showNotification(`ファイル「${fileHandle.name}」を読み込みました。`, 'success');
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
            const content = e.target.result;
            const editor = document.getElementById('editor');
            editor.value = content;
            updateVerticalDisplay();

            // 従来方式ではファイルハンドルは取得できないため、リセット
            currentFileHandle = null;
            currentFileName = file.name;

            showNotification(`ファイル「${file.name}」を読み込みました。`, 'success');
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

// 初期プレビュー表示実行
updateVerticalDisplay();

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
        const manualMatch = line.trim().match(MANUAL_SCENE_REGEX);
        const autoMatch = !manualMatch && line.trim().match(AUTO_SCENE_REGEX);
        if (!manualMatch && !autoMatch) return;
        found = true;

        let label, rest;
        if (manualMatch) {
            label = manualMatch[1];
            rest = line.replace(/^\s*【[^】]+】[◯○◎◇□＊☆]\s*/, '').trim();
        } else {
            label = String(sceneCounter++);
            rest = line.replace(/^\s*[◯○◎◇□＊☆]\s*/, '').trim();
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
}

// エディターとプレビューの両方にジャンプ
function jumpToScene(lineIndex) {
    jumpEditor(lineIndex);
    jumpPreview(lineIndex);
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

    function initWidths() {
        const totalWidth = row.getBoundingClientRect().width;
        const available = totalWidth - DIVIDER_WIDTH * 2;
        const leftWidth = Math.floor(available * 0.1667);
        const centerWidth = Math.floor(available * 0.4167);
        const rightWidth = available - leftWidth - centerWidth;
        leftCol.style.width = leftWidth + 'px';
        centerCol.style.width = centerWidth + 'px';
        rightCol.style.width = rightWidth + 'px';
    }

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
                if (newA >= minA && newB >= minB) {
                    colA.style.width = newA + 'px';
                    colB.style.width = newB + 'px';
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

    initWidths();
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
