// 台本整形エンジン（format.js）の回帰テスト
//
// 実行: node --test test/
// 依存パッケージなし（Node 組み込みの node:test / node:assert を使用）。
// package.json を置かないのは、Amplify のビルド検出を変えたくないため。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    formatVerticalTextToPages,
    normalizeDialoguePrefixForPreview,
    normalizeNewlines,
    splitTitleAndBody,
    toDisplayChars,
    displayLength,
    canBreakBetween,
    wrapLine,
    SCENE_NUMBER_FIELD_WIDTH,
    MAX_LINES_PER_PAGE,
    MAX_CHARS_PER_LINE,
} = require('../format.js');

const MAX_LINES = MAX_LINES_PER_PAGE;
const MAX_CHARS = MAX_CHARS_PER_LINE;

const readProjectFile = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

/** ページ配列を平坦化して行テキストの配列にする */
const flatten = (text) => formatVerticalTextToPages(text).flat();

/** 空行の詰め物を除いた実行のみ返す */
const contentLines = (text) => flatten(text).filter((l) => l.text !== '');

/** 先頭の連続空白の長さ */
const indentOf = (s) => s.match(/^ */)[0].length;

/* ========================================
   基本レイアウト
   ======================================== */

test('空テキストでも1ページぶんの空行を返す', () => {
    const pages = formatVerticalTextToPages('');
    assert.equal(pages.length, 1);
    assert.equal(pages[0].length, MAX_LINES);
    assert.ok(pages[0].every((l) => l.text === ''));
});

test('29文字ちょうどの行は折り返さない', () => {
    const line = 'あ'.repeat(MAX_CHARS);
    const lines = contentLines(line);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, line);
});

test('30文字の行は2行に折り返す', () => {
    const lines = contentLines('あ'.repeat(MAX_CHARS + 1));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].text.length, MAX_CHARS);
    assert.equal(lines[1].text, 'あ');
});

test('空行は空行として保持され、元の行番号を持つ', () => {
    const lines = flatten('あ\n\nい');
    assert.equal(lines[0].originalLineIndex, 0);
    assert.equal(lines[1].text, '');
    assert.equal(lines[1].originalLineIndex, 1);
    assert.equal(lines[2].originalLineIndex, 2);
});

test('1ページは17行を超えない', () => {
    const pages = formatVerticalTextToPages('あ\n'.repeat(40));
    for (const page of pages) {
        const weight = page.reduce((sum, l) => sum + (l.isScene ? 1.8 : 1), 0);
        assert.ok(weight <= MAX_LINES, `ページ重みが17を超えた: ${weight}`);
    }
});

/* ========================================
   柱書
   ======================================== */

test('自動連番は柱書ごとに1つ増える', () => {
    const scenes = contentLines('◯　朝\n◯　昼\n◯　夜').filter((l) => l.isScene);
    assert.equal(scenes.length, 3);
    assert.match(scenes[0].text, /^ {3}1 /);
    assert.match(scenes[1].text, /^ {3}2 /);
    assert.match(scenes[2].text, /^ {3}3 /);
});

test('手動指定は自動連番のカウントに影響しない', () => {
    const scenes = contentLines('◯　朝\n【8A】◯　回想\n◯　夜').filter((l) => l.isScene);
    assert.match(scenes[0].text, /^ {3}1 /);
    assert.match(scenes[1].text, /^ {2}8A /);   // 4桁右揃え + 区切り空白
    assert.match(scenes[2].text, /^ {3}2 /);    // 手動を挟んでも 2 のまま
});

test('手動指定のラベルは番号欄の幅で切り詰める', () => {
    const [scene] = contentLines('【シーン1回想場面】◯　回想').filter((l) => l.isScene);
    assert.equal(scene.text.slice(0, SCENE_NUMBER_FIELD_WIDTH), 'シーン1回');
});

test('手動指定ラベルに $ が含まれても置換パターンとして解釈されない', () => {
    const [scene] = contentLines('【$1】◯　テスト').filter((l) => l.isScene);
    assert.ok(scene.text.includes('$1'), `$1 が失われた: ${JSON.stringify(scene.text)}`);
    assert.ok(!scene.text.includes('【'), '隅付き括弧が残っている');
});

// A-3 の回帰テスト
test('柱書の折り返し字下げは番号の桁数に依存しない', () => {
    const longHeading = '◯　' + 'あ'.repeat(40);
    const indents = [1, 10, 100, 1000].map((n) => {
        // n 番目の柱書になるようダミーを積む
        const dummies = Array.from({ length: n - 1 }, () => '◯').join('\n');
        const text = (dummies ? dummies + '\n' : '') + longHeading;
        const scenes = flatten(text).filter((l) => l.isScene);
        return indentOf(scenes[scenes.length - 1].text);
    });

    assert.deepEqual(
        indents,
        Array(indents.length).fill(SCENE_NUMBER_FIELD_WIDTH),
        `字下げが番号の桁数で変わった: ${indents.join(', ')}`
    );
});

test('手動指定の柱書は元の字下げ＋番号欄ぶん字下げして折り返す', () => {
    const authorIndent = '  ';
    const scenes = flatten(authorIndent + '【8A】◯　' + 'あ'.repeat(40)).filter((l) => l.isScene);
    assert.equal(scenes.length, 2);
    assert.equal(indentOf(scenes[1].text), authorIndent.length + SCENE_NUMBER_FIELD_WIDTH);
});

// A-4 の回帰テスト
test('折り返した柱書の継続行も元の行番号を持つ', () => {
    const scenes = flatten('あ\n◯　' + 'い'.repeat(40)).filter((l) => l.isScene);
    assert.ok(scenes.length >= 2, '柱書が折り返されていない');
    for (const line of scenes) {
        assert.equal(line.originalLineIndex, 1, `originalLineIndex が欠落: ${JSON.stringify(line.text)}`);
    }
});

test('柱書の行は isScene フラグを持つ', () => {
    const lines = contentLines('◯　朝\nふつうの行');
    assert.equal(lines[0].isScene, true);
    assert.equal(lines[1].isScene, false);
});

/* ========================================
   セリフ行・ト書き
   ======================================== */

test('カギカッコで終わる行の継続行は全角4文字ぶん字下げされる', () => {
    const lines = contentLines('太郎「' + 'あ'.repeat(40) + '」');
    assert.equal(lines[0].isDialogueLine, true);
    assert.ok(lines[1].text.startsWith('　　　　'), `字下げが無い: ${JSON.stringify(lines[1].text)}`);
});

test('ト書きの行頭スペースは継続行にも引き継がれる', () => {
    const indent = '     '; // 半角5文字（推奨値）
    const lines = contentLines(indent + 'あ'.repeat(40));
    assert.equal(indentOf(lines[1].text), indent.length);
});

test('カギカッコで終わらない行はセリフ行として扱わない', () => {
    const [line] = contentLines('「そうか」と彼は言った。');
    assert.ok(!line.isDialogueLine);
});

/* ========================================
   禁則処理
   ======================================== */

test('行頭禁止文字は行頭に来ない（探索範囲内）', () => {
    // 29文字目に句点が来るように組む
    const lines = contentLines('あ'.repeat(28) + '。' + 'い'.repeat(5));
    assert.ok(!/^[。、」』）]/.test(lines[1].text), `行頭に禁則文字: ${JSON.stringify(lines[1].text)}`);
});

test('行末禁止文字は行末に来ない（探索範囲内）', () => {
    const lines = contentLines('あ'.repeat(28) + '「' + 'い'.repeat(5) + '」');
    assert.ok(!/[「『（]$/.test(lines[0].text), `行末に禁則文字: ${JSON.stringify(lines[0].text)}`);
});

/* ========================================
   改行コード正規化
   ======================================== */

test('CRLF は LF に正規化される', () => {
    assert.equal(normalizeNewlines('あ\r\nい\r\n'), 'あ\nい\n');
});

test('CR のみの改行も LF に正規化される', () => {
    assert.equal(normalizeNewlines('あ\rい'), 'あ\nい');
});

// A-1 の回帰テスト
test('CRLF を正規化すれば行末に \\r が残らず文字数も狂わない', () => {
    const crlf = 'あ'.repeat(MAX_CHARS) + '\r\n◯　学校\r\n';
    const lines = contentLines(normalizeNewlines(crlf));

    assert.ok(lines.every((l) => !l.text.includes('\r')), '\\r が残っている');
    assert.equal(lines[0].text.length, MAX_CHARS, '29文字が折り返された');
    assert.equal(lines.length, 2, `行数が想定外: ${JSON.stringify(lines.map((l) => l.text))}`);
});

/* ========================================
   タイトル判定
   ======================================== */

test('「タイトル + 空行 + 本文」形式を分離する', () => {
    const { title, body } = splitTitleAndBody('わが町\n\n◯　学校\nあ');
    assert.equal(title, 'わが町');
    assert.equal(body, '◯　学校\nあ');
});

test('2行目が空行でなければタイトルとみなさない', () => {
    const { title, body } = splitTitleAndBody('わが町\n◯　学校');
    assert.equal(title, '');
    assert.equal(body, 'わが町\n◯　学校');
});

test('柱書記号を含む先頭行はタイトルとみなさない', () => {
    assert.equal(splitTitleAndBody('◯　学校\n\nあ').title, '');
    assert.equal(splitTitleAndBody('【8A】◯　学校\n\nあ').title, '');
});

test('隅付き括弧を含むタイトルは通す', () => {
    assert.equal(splitTitleAndBody('【第一稿】わが町\n\nあ').title, '【第一稿】わが町');
});

test('全角スペースで字下げした先頭行はタイトルとみなさない', () => {
    assert.equal(splitTitleAndBody('　　　　　ト書きふう\n\nあ').title, '');
});

test('CRLF を正規化してからならタイトルを検出できる', () => {
    const { title, body } = splitTitleAndBody(normalizeNewlines('わが町\r\n\r\n◯　学校'));
    assert.equal(title, 'わが町');
    assert.equal(body, '◯　学校');
});

/* ========================================
   セリフ行プレフィックスの表示整形
   ======================================== */

test('発言者名は表示上3文字幅に揃える', () => {
    assert.equal(normalizeDialoguePrefixForPreview('あいう'), 'あいう');
    assert.equal(normalizeDialoguePrefixForPreview('かき'), 'か　き');
    assert.equal(normalizeDialoguePrefixForPreview('さ'), '　さ　');
    assert.equal(normalizeDialoguePrefixForPreview(''), '　　　');
});

test('4文字以上の発言者名はそのまま返す', () => {
    assert.equal(normalizeDialoguePrefixForPreview('あいうえ'), 'あいうえ');
});

/* ========================================
   表示文字単位の処理（A-2）
   ======================================== */

test('サロゲートペアを1文字として数える', () => {
    assert.equal('𠀋'.length, 2);            // UTF-16 では2
    assert.equal(displayLength('𠀋'), 1);    // 表示上は1
    assert.deepEqual(toDisplayChars('あ𠀋い'), ['あ', '𠀋', 'い']);
});

test('異体字セレクタは直前の文字と1文字にまとめる', () => {
    const ivs = '邎󠄀'; // 邎 + 異体字セレクタ(U+E0100)
    assert.equal(displayLength(ivs), 1);
    assert.deepEqual(toDisplayChars('あ' + ivs), ['あ', ivs]);
});

test('結合文字（濁点）は直前の文字と1文字にまとめる', () => {
    const combined = 'が'; // か + 結合濁点
    assert.equal(displayLength(combined), 1);
});

// A-2 の回帰テスト
test('サロゲートペアが折り返しで分断されない', () => {
    const lines = contentLines('あ'.repeat(MAX_CHARS - 1) + '𠀋' + 'い'.repeat(5));

    for (const line of lines) {
        assert.ok(
            !/[\uD800-\uDBFF]$/.test(line.text),
            `行末に孤立したサロゲート上位: ${JSON.stringify(line.text)}`
        );
        assert.ok(
            !/^[\uDC00-\uDFFF]/.test(line.text),
            `行頭に孤立したサロゲート下位: ${JSON.stringify(line.text)}`
        );
    }
});

test('サロゲートペアを含む行は表示文字数で折り返す', () => {
    // 表示上ちょうど29文字（UTF-16 では30）
    const line = 'あ'.repeat(MAX_CHARS - 1) + '𠀋';
    const lines = contentLines(line);
    assert.equal(lines.length, 1, '29文字なのに折り返された');
});

test('どの行も表示文字数が29を超えない', () => {
    const script = [
        '◯　学校の廊下',
        '太郎「' + 'あ'.repeat(60) + '」',
        '　　　　　' + 'い'.repeat(70),
        'さ「' + 'う'.repeat(26) + '」',
        '【8A】◯　' + 'え'.repeat(50),
    ].join('\n');

    for (const line of flatten(script)) {
        assert.ok(
            displayLength(line.text) <= MAX_CHARS,
            `29文字を超えた(${displayLength(line.text)}): ${JSON.stringify(line.text)}`
        );
    }
});

/* ========================================
   禁則処理の強化（A-5）
   ======================================== */

test('行頭禁止文字が連続しても行頭に来ない', () => {
    // 29文字目付近に行頭禁止文字を5個並べる
    const lines = contentLines('あ'.repeat(25) + '。、」』）' + 'い'.repeat(5));
    for (const line of lines.slice(1)) {
        assert.ok(
            !/^[。、」』）]/.test(line.text),
            `行頭に禁則文字: ${JSON.stringify(line.text)}`
        );
    }
});

test('三点リーダの連続は分割しない', () => {
    assert.equal(canBreakBetween('…', '…'), false);
    assert.equal(canBreakBetween('―', '―'), false);
});

test('半角の閉じ括弧・句読点も行頭禁止として扱う', () => {
    assert.equal(canBreakBetween('あ', ')'), false);
    assert.equal(canBreakBetween('あ', '.'), false);
    assert.equal(canBreakBetween('あ', '!'), false);
});

test('半角の開き括弧も行末禁止として扱う', () => {
    assert.equal(canBreakBetween('(', 'あ'), false);
    assert.equal(canBreakBetween('[', 'あ'), false);
});

test('繰り返し記号は行頭禁止として扱う', () => {
    assert.equal(canBreakBetween('人', '々'), false);
});

test('ふつうの文字同士は改行できる', () => {
    assert.equal(canBreakBetween('あ', 'い'), true);
    assert.equal(canBreakBetween('。', 'あ'), true); // 句点の後ろは切れる
});

/* ========================================
   セリフ行の表示幅（A-7）
   ======================================== */

// A-7 の回帰テスト
test('発言者名1文字のセリフ行も整形後の幅で折り返す', () => {
    // 元テキストは29文字。「さ」→「　さ　」で表示は31文字になるため、
    // 整形前の長さで折り返すと紙面からあふれる。
    const line = 'さ「' + 'あ'.repeat(26) + '」';
    assert.equal(displayLength(line), MAX_CHARS);

    const lines = contentLines(line);
    for (const l of lines) {
        assert.ok(
            displayLength(l.text) <= MAX_CHARS,
            `29文字を超えた(${displayLength(l.text)}): ${JSON.stringify(l.text)}`
        );
    }
    assert.ok(lines[0].text.startsWith('　さ　「'), `発言者名が整形されていない: ${JSON.stringify(lines[0].text)}`);
});

test('発言者名の整形は1行目だけに適用する', () => {
    const lines = contentLines('さ「' + 'あ'.repeat(60) + '」');
    assert.equal(lines[0].isDialogueLine, true);
    for (const l of lines.slice(1)) {
        assert.ok(!l.isDialogueLine, '継続行が isDialogueLine になっている');
    }
});

/* ========================================
   wrapLine 単体
   ======================================== */

test('wrapLine は制限内ならそのまま返す', () => {
    assert.deepEqual(wrapLine('あいう', 10, '  '), ['あいう']);
});

test('wrapLine は2行目以降に字下げを付ける', () => {
    // 6文字を幅4で折り返す。2行目は字下げ2文字ぶん狭くなる
    assert.deepEqual(wrapLine('あ'.repeat(6), 4, '__'), ['ああああ', '__ああ']);
});

test('字下げが行幅以上でも無限ループしない', () => {
    const result = wrapLine('あ'.repeat(20), 5, ' '.repeat(10));
    assert.ok(result.length >= 4);
    assert.equal(result.join('').replace(/ /g, ''), 'あ'.repeat(20));
});

/* ========================================
   JS と CSS / HTML の整合（B-2 / B-7）

   同じ数値が複数のファイルに散っている箇所を、テストで結びつけて
   片方だけ変更されるのを防ぐ。
   ======================================== */

test('レイアウト仕様は1ページ17行・1行29文字', () => {
    // index.html の使い方パネルに明記している仕様値
    assert.equal(MAX_LINES_PER_PAGE, 17);
    assert.equal(MAX_CHARS_PER_LINE, 29);
});

test('CSS の --chars-per-line が JS の MAX_CHARS_PER_LINE と一致する', () => {
    const css = readProjectFile('styles.css');
    const match = css.match(/--chars-per-line:\s*(\d+)/);

    assert.ok(match, 'styles.css に --chars-per-line が見つからない');
    assert.equal(
        Number(match[1]),
        MAX_CHARS_PER_LINE,
        '.scene-line の枠の長さと折り返し幅がズレる'
    );
});

test('CSS の --print-scale が紙面サイズの比と一致する', () => {
    const css = readProjectFile('styles.css');

    // プレビュー紙面は px、印刷紙面は mm で宣言しているので取り違えない
    const previewH = Number(css.match(/--paper-h:\s*([\d.]+)px/)[1]);
    const printHmm = Number(css.match(/--paper-h:\s*([\d.]+)mm/)[1]);
    const declared = Number(css.match(/--print-scale:\s*([\d.]+)/)[1]);

    const expected = (printHmm * 96 / 25.4) / previewH; // mm を 96dpi の px へ
    assert.ok(
        Math.abs(declared - expected) < 0.01,
        `--print-scale: ${declared} だが紙面比は ${expected.toFixed(3)}`
    );
});

test('index.html は format.js を app.js より先に読み込む', () => {
    const html = readProjectFile('index.html');
    const formatAt = html.indexOf('format.js?v=');
    const appAt = html.indexOf('app.js?v=');

    assert.ok(formatAt > -1, 'format.js の読み込みが無い');
    assert.ok(appAt > -1, 'app.js の読み込みが無い');
    assert.ok(formatAt < appAt, 'app.js が format.js より先に読み込まれている');
});

/* ========================================
   HTML / manifest の構造ガード

   壊れても画面上は動いてしまう（が挙動や支援技術での読み上げが劣化する）
   類の設定を、テストで固定しておく。
   ======================================== */

test('すべての button に type 属性がある', () => {
    const html = readProjectFile('index.html');
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);

    assert.ok(buttons.length > 0, 'button が見つからない');
    const missing = buttons.filter((tag) => !/\stype=/.test(tag));
    assert.deepEqual(missing, [], 'type 属性の無い button がある');
});

test('カラム仕切りがキーボードと支援技術に対応している', () => {
    const html = readProjectFile('index.html');
    const dividers = [...html.matchAll(/<div class="col-divider"[\s\S]*?>/g)].map((m) => m[0]);

    assert.equal(dividers.length, 2, '仕切りが2つ見つからない');
    for (const divider of dividers) {
        assert.match(divider, /role="separator"/);
        assert.match(divider, /tabindex="0"/);
        assert.match(divider, /aria-label=/);
    }
});

test('左パネルのタブが tablist として組まれている', () => {
    const html = readProjectFile('index.html');

    assert.match(html, /role="tablist"/);
    assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
    assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 2);
});

test('manifest のアイコンが any と maskable に分かれている', () => {
    const manifest = JSON.parse(readProjectFile('manifest.json'));
    const purposes = manifest.icons.map((/** @type {{purpose: string}} */ icon) => icon.purpose);

    // any と maskable を1つのエントリで兼用すると、通常表示で余白が過大になる
    assert.deepEqual(purposes.sort(), ['any', 'maskable']);

    for (const icon of manifest.icons) {
        assert.doesNotThrow(
            () => readProjectFile(icon.src),
            `manifest が参照するアイコンが無い: ${icon.src}`
        );
    }
});

test('favicon が指定されている', () => {
    const html = readProjectFile('index.html');
    assert.match(html, /<link rel="icon"/, 'rel="icon" が無いと /favicon.ico に404が出る');
});

test('バージョン文字列が全箇所で一致している', () => {
    const html = readProjectFile('index.html');
    const sw = readProjectFile('sw.js');

    const versions = [
        ...[...html.matchAll(/\?v=([0-9][\w.]*)/g)].map((m) => m[1]),
        ...[...html.matchAll(/ver\.([0-9][\w.]*)/g)].map((m) => m[1]),
        ...[...sw.matchAll(/CACHE_NAME = 'straw-([\w.]+)'/g)].map((m) => m[1]),
    ];

    assert.ok(versions.length >= 5, `検出箇所が少なすぎる: ${versions.length}`);
    assert.equal(
        new Set(versions).size,
        1,
        `不一致: ${[...new Set(versions)].join(' / ')} — node tools/bump-version.js <version> で揃える`
    );
});
