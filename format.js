// @ts-check

/*
========================================
台本整形エンジン（DOM 非依存）
========================================
入力テキストを B5 縦書きレイアウトへ変換する純粋ロジック。
DOM も window も参照しないため、Node から require して単体テストできる。
UI 側の処理は app.js にある。

ブラウザでは通常スクリプトとして読み込み、関数をグローバルへ公開する。
（index.html の onclick 属性がグローバル関数を前提にしているため、
  ES モジュール化はしていない）
*/

// 柱書記号の唯一の定義。以下の正規表現はすべてここから組み立てる。
const SCENE_SYMBOLS = '◯○◎◇□＊☆';
const SCENE_SYMBOL_CLASS = `[${SCENE_SYMBOLS}]`;
const SCENE_SYMBOL_REGEX = new RegExp(SCENE_SYMBOL_CLASS);

// 柱書の検出用（行を trim してから適用する）
const MANUAL_SCENE_REGEX = new RegExp(`^【([^】]+)】${SCENE_SYMBOL_CLASS}`);
const AUTO_SCENE_REGEX = new RegExp(`^${SCENE_SYMBOL_CLASS}`);

// 柱書プレフィックスを丸ごと取り除く用（アウトライン表示：後続の空白も落とす）
const MANUAL_SCENE_STRIP_REGEX = new RegExp(`^\\s*【[^】]+】${SCENE_SYMBOL_CLASS}\\s*`);
const AUTO_SCENE_STRIP_REGEX = new RegExp(`^\\s*${SCENE_SYMBOL_CLASS}\\s*`);

// 柱書プレフィックスを番号欄に置換する用（プレビュー：記号の後ろの空白は本文として残す）
// 手動指定は $1 で元の字下げを保持し、自動連番は番号欄を左端に置くため字下げを畳む。
const MANUAL_SCENE_PREFIX_REGEX = new RegExp(`^(\\s*)【[^】]+】${SCENE_SYMBOL_CLASS}`);
const AUTO_SCENE_PREFIX_REGEX = new RegExp(`^\\s*${SCENE_SYMBOL_CLASS}`);

// 柱書番号欄：4桁ぶん右揃え + 区切り空白1 = 半角5文字。
// 折り返し継続行の字下げにも同じ半角スペースを使うため、
// グリフの送り幅が何であれ番号欄と正確に揃う。
const SCENE_NUMBER_PAD = 4;
const SCENE_NUMBER_FIELD_WIDTH = SCENE_NUMBER_PAD + 1;

/*
========================================
B5縦書きレイアウト制約
========================================
CSS 側（styles.css の .vertical-text / .scene-line）と対応する数値。
片方だけ変えるとプレビューと折り返し計算がズレるので、必ず両方を確認する。
*/
const MAX_LINES_PER_PAGE = 17;      // 1ページ最大行数（= 縦書きの列数）
const MAX_CHARS_PER_LINE = 29;      // 1行最大文字数（.scene-line の height: calc(29em + 5em) と対応）
const SCENE_LINE_WEIGHT = 1.8;      // 柱書1行が占める行数。.scene-line の border+margin ぶんを含む実測値
const DIALOGUE_INDENT = '　　　　'; // セリフ行の折り返し字下げ（全角4文字）

/*
========================================
日本語禁則処理の文字集合
========================================
JIS X 4051 の禁則文字をベースに、台本で実際に使う範囲へ絞ったもの。
半角の約物も含めるのは、ト書きに英数字が混ざることがあるため。
*/

// 行頭禁止文字：この文字の前では改行しない（句読点・閉じ括弧・小書き仮名など）
const LINE_START_PROHIBITED =
    '。、．，？！」』）〕］｝〉》】〗〙〛ー：；・' +
    'ぁぃぅぇぉっゃゅょゎゐゑゕゖァィゥェォッャュョヮヵヶ' +
    '々ゝゞヽヾ' +
    '”’' +
    '.,)]}!?:;' +
    '％‰℃°';

// 行末禁止文字：この文字の後では改行しない（開き括弧・前置記号）
const LINE_END_PROHIBITED =
    '「『（〔［｛〈《【〖〘〚' +
    '“‘' +
    '([{' +
    '￥＄＃';

// 分離禁止文字：同じ文字が連続する場合、その間では改行しない（……／――など）
const NO_SPLIT_CHARS = '―‐—…‥';

// 禁則で改行位置を手前へ送れる最大文字数。
// 「……。」』」のように行頭禁止文字が連続しても追い出せる程度に取る。
// 大きくすると行が短くなりやすいので、実用的な上限で止める。
const MAX_KINSOKU_PUSH = 8;

// 異体字セレクタ・結合文字。直前の文字と1文字として扱う。
// （﨑 などの人名異体字や濁点結合が base から切り離されるのを防ぐ）
const COMBINING_MARK_REGEX = /^[\p{Mn}\p{Me}\p{Mc}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]$/u;

/**
 * 文字列を「表示上の1文字」単位の配列に分割する。
 *
 * for...of がコードポイント単位で回るのでサロゲートペア（𠀋 などの CJK 拡張漢字）が
 * 分断されず、さらに後続の異体字セレクタ・結合文字を直前の要素へ畳み込む。
 * 折り返し計算をこの単位で行うことで、文字が割れて豆腐になるのを防ぐ。
 *
 * @param {string} text
 * @returns {string[]}
 */
function toDisplayChars(text) {
    /** @type {string[]} */
    const chars = [];

    for (const ch of text) {
        if (chars.length > 0 && COMBINING_MARK_REGEX.test(ch)) {
            chars[chars.length - 1] += ch;
        } else {
            chars.push(ch);
        }
    }

    return chars;
}

/**
 * 表示上の文字数を返す（サロゲートペア・異体字セレクタを1文字と数える）。
 *
 * @param {string} text
 * @returns {number}
 */
function displayLength(text) {
    return toDisplayChars(text).length;
}

/**
 * 2文字の間で改行してよいか判定する。
 *
 * @param {string} char - 改行位置の直前の文字
 * @param {string} nextChar - 改行位置の直後の文字
 * @returns {boolean}
 */
function canBreakBetween(char, nextChar) {
    // 分離禁止：…… や ―― の途中では切らない
    if (char === nextChar && NO_SPLIT_CHARS.includes(char)) return false;

    if (LINE_END_PROHIBITED.includes(char)) return false;
    if (nextChar && LINE_START_PROHIBITED.includes(nextChar)) return false;

    return true;
}

/**
 * 折り返し位置を探す。
 *
 * maxWidth から手前へ遡り、禁則に反しない位置を返す。
 * MAX_KINSOKU_PUSH 文字ぶん遡っても見つからない場合は maxWidth で強制的に切る
 * （禁則を守れない極端な入力よりも、行があふれない方を優先する）。
 *
 * @param {string[]} chars - 表示文字単位の配列
 * @param {number} maxWidth - 1行に入る文字数
 * @returns {number} chars を切るインデックス（1以上）
 */
function findBreakPoint(chars, maxWidth) {
    if (chars.length <= maxWidth) return chars.length;

    const lowerBound = Math.max(1, maxWidth - MAX_KINSOKU_PUSH);
    for (let i = maxWidth; i >= lowerBound; i--) {
        if (canBreakBetween(chars[i - 1], chars[i])) return i;
    }

    return maxWidth;
}

/**
 * 1行を指定幅で折り返す。
 *
 * 幅の計算と切り出しはすべて表示文字単位で行う。
 *
 * @param {string} text - 対象の行（1行目の字下げは text に含める）
 * @param {number} maxWidth - 1行の最大文字数
 * @param {string} continuationIndent - 2行目以降に付ける字下げ
 * @returns {string[]} 折り返し後の行（必ず1要素以上）
 */
function wrapLine(text, maxWidth, continuationIndent) {
    let rest = toDisplayChars(text);
    if (rest.length <= maxWidth) return [text];

    /** @type {string[]} */
    const wrapped = [];

    // 1行目：字下げは text 側に含まれているのでそのまま切る
    const firstBreak = findBreakPoint(rest, maxWidth);
    wrapped.push(rest.slice(0, firstBreak).join(''));
    rest = rest.slice(firstBreak);

    const availableWidth = maxWidth - displayLength(continuationIndent);

    while (rest.length > 0) {
        if (availableWidth > 0 && rest.length <= availableWidth) {
            wrapped.push(continuationIndent + rest.join(''));
            break;
        }

        // 字下げが1行を食い潰す場合は字下げを諦めて切る（無限ループ防止）
        const usableWidth = availableWidth > 0 ? availableWidth : maxWidth;
        const indent = availableWidth > 0 ? continuationIndent : '';

        const breakAt = findBreakPoint(rest, usableWidth);
        wrapped.push(indent + rest.slice(0, breakAt).join(''));
        rest = rest.slice(breakAt);
    }

    return wrapped;
}

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
 * @param {string} text - 入力テキスト（改行区切り・LF 正規化済み）
 * @returns {Array<Array<Object>>} ページ配列（各ページは行オブジェクトの配列）
 *   行オブジェクト形式：{ text: string, isScene: boolean,
 *                        originalLineIndex?: number, isDialogueLine?: boolean }
 */
function formatVerticalTextToPages(text) {
    const lines = text.split('\n');

    /** @type {Array<Object>} */
    const allFormattedLines = [];
    let sceneNumber = 1; // 柱書連番カウンタ

    /**
     * 折り返した行をまとめて積む。
     * 折り返し後の各行が originalLineIndex を持つので、
     * プレビューのどの行をクリックしてもエディタの元行へ戻れる。
     *
     * @param {string[]} wrapped
     * @param {number} lineIdx
     * @param {{ isScene?: boolean, isDialogueLine?: boolean }} flags
     */
    function pushWrapped(wrapped, lineIdx, flags) {
        wrapped.forEach((lineText, i) => {
            allFormattedLines.push({
                text: lineText,
                isScene: flags.isScene === true,
                originalLineIndex: lineIdx,
                // セリフ行の発言者名整形は1行目にしか関係しない
                isDialogueLine: i === 0 && flags.isDialogueLine === true
            });
        });
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
        const trimmedLine = line.trim();
        const manualSceneMatch = trimmedLine.match(MANUAL_SCENE_REGEX);

        if (manualSceneMatch) {
            const manualSceneText = manualSceneMatch[1]; // 【】内の文字列
            const labelChars = toDisplayChars(manualSceneText);

            // 番号欄の幅（半角5文字）に揃える：4文字以下なら右揃え＋空白、5文字以上なら切り詰め
            const numberField = labelChars.length <= SCENE_NUMBER_PAD
                // 例：「1A」→「  1A 」
                ? manualSceneText.padStart(SCENE_NUMBER_PAD, ' ') + ' '
                // 例：「シーン1回想場面」→「シーン1回想」
                : labelChars.slice(0, SCENE_NUMBER_FIELD_WIDTH).join('');

            const prefixMatch = line.match(MANUAL_SCENE_PREFIX_REGEX);
            const authorIndent = prefixMatch ? prefixMatch[1] : '';

            // 置換関数を使うのは、【$1】のように $ を含むラベルが
            // 置換パターンとして解釈されるのを防ぐため
            const sceneText = line.replace(
                MANUAL_SCENE_PREFIX_REGEX,
                (_match, indent) => indent + numberField
            );

            const hangingIndent = ' '.repeat(displayLength(authorIndent) + SCENE_NUMBER_FIELD_WIDTH);
            pushWrapped(wrapLine(sceneText, MAX_CHARS_PER_LINE, hangingIndent), lineIdx, { isScene: true });
            continue;
        }

        if (AUTO_SCENE_REGEX.test(trimmedLine)) {
            // 番号変換：記号 → "   1 " 形式（4桁右揃え + 区切り空白）
            const numberField = String(sceneNumber).padStart(SCENE_NUMBER_PAD, ' ') + ' ';
            const sceneText = line.replace(AUTO_SCENE_PREFIX_REGEX, numberField);
            sceneNumber++;

            const hangingIndent = ' '.repeat(SCENE_NUMBER_FIELD_WIDTH);
            pushWrapped(wrapLine(sceneText, MAX_CHARS_PER_LINE, hangingIndent), lineIdx, { isScene: true });
            continue;
        }

        //
        // ========== 通常行処理 ==========
        //

        // セリフ行判定：元行全体でカギカッコ終了チェック
        const isDialogueLine = trimmedLine.endsWith('」') || trimmedLine.endsWith('』');

        // セリフ行は発言者名をプレビュー上で3文字幅に揃えるため、
        // 折り返し幅の計算より先に整形しておく。
        // 整形後の幅で折り返さないと、1行が29文字を超えて紙面からはみ出す。
        let displayLine = line;
        if (isDialogueLine) {
            const quoteStart = line.search(/[「『]/);
            if (quoteStart > 0) {
                displayLine =
                    normalizeDialoguePrefixForPreview(line.slice(0, quoteStart)) +
                    line.slice(quoteStart);
            }
        }

        // 2行目以降の字下げ：セリフ行は全角4文字、通常行は元の字下げを継続
        const indentMatch = displayLine.match(/^(\s*)/);
        const continuationIndent = isDialogueLine
            ? DIALOGUE_INDENT
            : (indentMatch ? indentMatch[1] : '');

        pushWrapped(
            wrapLine(displayLine, MAX_CHARS_PER_LINE, continuationIndent),
            lineIdx,
            { isDialogueLine }
        );
    }

    //
    // ========== ページ分割処理 ==========
    // 17行制限によるページ分割（柱書は SCENE_LINE_WEIGHT 行相当）
    //
    /** @type {Array<Array<Object>>} */
    const pages = [];
    /** @type {Array<Object>} */
    let currentPage = [];
    let currentLineCount = 0;

    // 空行を足して紙面を埋める。
    // Math.ceil(count) < MAX_LINES_PER_PAGE は「あと1行ぶん入るか」と同値
    // （柱書の重みで count が小数になるため ceil で判定している）。
    const fillPage = () => {
        while (Math.ceil(currentLineCount) < MAX_LINES_PER_PAGE) {
            currentPage.push({ text: '', isScene: false });
            currentLineCount += 1;
        }
    };

    for (const lineObj of allFormattedLines) {
        const lineWeight = lineObj.isScene ? SCENE_LINE_WEIGHT : 1;

        // ページ容量チェック：17行超過判定
        if (currentLineCount + lineWeight > MAX_LINES_PER_PAGE && currentPage.length > 0) {
            fillPage();
            pages.push(currentPage);
            currentPage = [];
            currentLineCount = 0;
        }

        currentPage.push(lineObj);
        currentLineCount += lineWeight;
    }

    if (currentPage.length > 0) {
        fillPage();
        pages.push(currentPage);
    }

    // 空テキスト用に最低1ページを保証する
    if (pages.length === 0) {
        currentPage = [];
        currentLineCount = 0;
        fillPage();
        pages.push(currentPage);
    }

    return pages;
}

/**
 * セリフ行の「前」部分を、プレビュー上で最小3文字幅に整える。
 * 元テキストは変更せず、表示時にのみ不足分の全角スペースを補う。
 *
 * 例:
 * - "あいう" -> "あいう"（そのまま）
 * - "かき"   -> "か　き"
 * - "さ"     -> "　さ　"
 *
 * @param {string} prefixText
 * @returns {string}
 */
function normalizeDialoguePrefixForPreview(prefixText) {
    const chars = Array.from(prefixText);
    if (chars.length >= 3) return prefixText;

    if (chars.length === 2) {
        return `${chars[0]}　${chars[1]}`;
    }

    if (chars.length === 1) {
        return `　${chars[0]}　`;
    }

    return '　　　';
}

/**
 * 改行コードを LF に統一する。
 *
 * CRLF のまま扱うと行末に残る \r が「1行29文字」のカウント・空行判定・
 * タイトル判定のすべてを狂わせるため、ファイル読み込みの入口で必ず通す。
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeNewlines(text) {
    return text.replace(/\r\n?/g, '\n');
}

/**
 * 先頭行をタイトルとして扱えるか判定し、タイトルと本文に分ける。
 * saveText が書き出す「タイトル\n\n本文」形式を読み戻すための処理。
 *
 * 【判定条件】1行目が非空 / 2行目が空行 / 行頭が空白でない / 柱書記号を含まない
 *
 * 柱書記号を弾けば「【8A】◯ 学校」形式も同時に除外できるので、
 * 隅付き括弧そのものは判定に含めない（「【第一稿】わが町」のような
 * タイトルを通すため）。
 *
 * @param {string} content - LF に正規化済みのテキスト
 * @returns {{ title: string, body: string }}
 */
function splitTitleAndBody(content) {
    const lines = content.split('\n');
    const firstLine = lines[0] ?? '';

    const looksLikeTitle =
        firstLine.trim() !== '' &&
        lines[1] === '' &&
        !/^\s/.test(firstLine) &&   // 全角スペースで字下げしたト書きも除外する
        !SCENE_SYMBOL_REGEX.test(firstLine);

    if (!looksLikeTitle) return { title: '', body: content };

    return { title: firstLine, body: lines.slice(2).join('\n') };
}

/*
========================================
テスト用エクスポート
========================================
Node から require したときだけ有効。ブラウザでは module が未定義なので何もしない。
*/
// @ts-ignore - module は Node 専用のグローバル
if (typeof module !== "undefined" && module.exports) {
    // @ts-ignore
    module.exports = {
        SCENE_SYMBOLS,
        MANUAL_SCENE_REGEX,
        AUTO_SCENE_REGEX,
        MANUAL_SCENE_STRIP_REGEX,
        AUTO_SCENE_STRIP_REGEX,
        SCENE_NUMBER_PAD,
        SCENE_NUMBER_FIELD_WIDTH,
        MAX_LINES_PER_PAGE,
        MAX_CHARS_PER_LINE,
        SCENE_LINE_WEIGHT,
        DIALOGUE_INDENT,
        toDisplayChars,
        displayLength,
        canBreakBetween,
        findBreakPoint,
        wrapLine,
        formatVerticalTextToPages,
        normalizeDialoguePrefixForPreview,
        normalizeNewlines,
        splitTitleAndBody,
    };
}
