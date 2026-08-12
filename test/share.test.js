// 共有リンク（share.js）の回帰テスト
//
// 実行: node --test test/*.test.js
// 依存パッケージなし（Node 組み込みの node:test / node:assert を使用）。
//
// 置き場所ごとのURL変換は、相手のサービスの都合で静かに壊れる種類のコードなので、
// 変換結果そのものを固定して検査する。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    SHARE_DEFAULT_FILE_NAME,
    resolveShareSource,
    listShareProviderLabels,
    readShareSourceParam,
    buildShareUrl,
    describeShareContentProblem,
} = require('../share.js');

/** テストデータ用の制御文字。ソースへ直接書くとエディタや検索で扱いにくい */
const NUL = '\u0000';
const REPLACEMENT_CHAR = '\uFFFD';

const readProjectFile = (/** @type {string} */ name) =>
    fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

/** 解決できた前提で結果を取り出す（失敗なら理由を添えて落とす） */
const resolved = (url) => {
    const source = resolveShareSource(url);
    assert.ok(source.ok, `解決できるはずのURLが拒否された: ${source.ok ? '' : source.reason}`);
    return source;
};

/* ========================================
   置き場所ごとのURL変換
   ======================================== */

test('GitHubのファイルページはraw URLへ変換される', () => {
    const source = resolved('https://github.com/kzbb/straw/blob/main/sample/台本.txt');
    assert.equal(source.provider, 'github');
    assert.equal(
        source.fetchUrl,
        'https://raw.githubusercontent.com/kzbb/straw/main/sample/%E5%8F%B0%E6%9C%AC.txt'
    );
});

test('GitHubのリポジトリトップは理由を添えて拒否する', () => {
    const source = resolveShareSource('https://github.com/kzbb/straw');
    assert.equal(source.ok, false);
    assert.match(source.reason, /blob/);
});

test('Dropboxの共有リンクは直接ダウンロードのホストへ差し替わる', () => {
    const source = resolved('https://www.dropbox.com/s/abc123/daihon.txt?dl=0');
    assert.equal(source.provider, 'dropbox');
    assert.match(source.fetchUrl, /^https:\/\/dl\.dropboxusercontent\.com\/s\/abc123\/daihon\.txt/);
    assert.match(source.fetchUrl, /dl=1/);
    assert.doesNotMatch(source.fetchUrl, /dl=0/);
});

test('OneDriveの共有リンクはshares APIのbase64url形式になる', () => {
    const source = resolved('https://1drv.ms/t/s!AbCdEf');
    assert.equal(source.provider, 'onedrive');
    // base64url なので +, /, = は現れない
    assert.match(source.fetchUrl, /^https:\/\/api\.onedrive\.com\/v1\.0\/shares\/u![\w-]+\/root\/content$/);
});

test('GoogleドライブのファイルURLからIDを取り出してDrive APIを呼ぶ', () => {
    const source = resolved('https://drive.google.com/file/d/1AbCdEfGhIjK/view?usp=sharing');
    assert.equal(source.provider, 'googledrive');
    assert.match(source.fetchUrl, /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/1AbCdEfGhIjK\?alt=media&key=/);
});

test('Googleドライブの id= 形式のURLも読み取れる', () => {
    const source = resolved('https://drive.usercontent.google.com/download?id=1AbCdEfGhIjK&export=download');
    assert.match(source.fetchUrl, /files\/1AbCdEfGhIjK\?/);
});

test('GoogleドライブのフォルダURLはファイルIDを取れずに拒否する', () => {
    const source = resolveShareSource('https://drive.google.com/drive/folders');
    assert.equal(source.ok, false);
});

test('変換規則の無いURLはそのまま取得先にする', () => {
    const source = resolved('https://example.com/scripts/daihon.txt');
    assert.equal(source.provider, 'direct');
    assert.equal(source.fetchUrl, 'https://example.com/scripts/daihon.txt');
});

/* ========================================
   受け付けないURL
   ======================================== */

test('https以外のURLは拒否する', () => {
    for (const url of [
        'http://example.com/daihon.txt',
        'javascript:alert(1)',
        'data:text/plain,daihon',
        'file:///Users/me/daihon.txt',
    ]) {
        const source = resolveShareSource(url);
        assert.equal(source.ok, false, `拒否されるべきURLが通った: ${url}`);
    }
});

test('空文字とURLでない文字列は拒否する', () => {
    assert.equal(resolveShareSource('').ok, false);
    assert.equal(resolveShareSource('   ').ok, false);
    assert.equal(resolveShareSource('だいほん').ok, false);
});

test('前後の空白は取り除いてから解釈する', () => {
    const source = resolved('  https://example.com/daihon.txt  ');
    assert.equal(source.fetchUrl, 'https://example.com/daihon.txt');
});

/* ========================================
   ファイル名の推測
   ======================================== */

test('URL末尾が.txtならファイル名として使う', () => {
    assert.equal(resolved('https://example.com/a/b/daihon.txt').fileName, 'daihon.txt');
});

test('パーセントエンコードされた日本語のファイル名は復元する', () => {
    assert.equal(
        resolved('https://example.com/%E5%8F%B0%E6%9C%AC.txt').fileName,
        '台本.txt'
    );
});

test('.txt以外で終わるURLは既定のファイル名にする', () => {
    assert.equal(resolved('https://example.com/scripts/').fileName, SHARE_DEFAULT_FILE_NAME);
    assert.equal(resolved('https://example.com/view?id=3').fileName, SHARE_DEFAULT_FILE_NAME);
});

/* ========================================
   共有URLの組み立てと読み取り
   ======================================== */

test('共有URLは元のクエリとフラグメントを捨ててsrcだけを持つ', () => {
    const shareUrl = buildShareUrl(
        'https://straw.bblab.org/?src=https%3A%2F%2Fold.example.com%2Fa.txt#hash',
        'https://example.com/daihon.txt'
    );

    assert.equal(
        shareUrl,
        'https://straw.bblab.org/?src=https%3A%2F%2Fexample.com%2Fdaihon.txt'
    );
});

test('組み立てた共有URLはそのまま読み取れる', () => {
    const sourceUrl = 'https://drive.google.com/file/d/1AbC/view?usp=sharing';
    const shareUrl = buildShareUrl('https://straw.bblab.org/', sourceUrl);

    assert.equal(readShareSourceParam(shareUrl), sourceUrl);
});

test('共有リンクでないURLからは空文字が返る', () => {
    assert.equal(readShareSourceParam('https://straw.bblab.org/'), '');
    assert.equal(readShareSourceParam('壊れたURL'), '');
});

/* ========================================
   取得したテキストの検査
   ======================================== */

test('台本テキストは問題なしと判定する', () => {
    const script = ['タイトル', '', '◯　部室', '', '　　　　　太郎、椅子に座っている。', '太郎「おはよう」'].join('\n');
    assert.equal(describeShareContentProblem(script), null);
});

test('HTMLが返ってきた場合はエラーにする', () => {
    for (const html of [
        '<!DOCTYPE html>\n<html><body>ログイン</body></html>',
        '\n  <html lang="ja">',
    ]) {
        const problem = describeShareContentProblem(html);
        assert.equal(problem && problem.level, 'error');
    }
});

test('ヌル文字を含むファイルはテキストでないと判定する', () => {
    const problem = describeShareContentProblem(`%PDF-1.4${NUL}${NUL}binary`);
    assert.equal(problem && problem.level, 'error');
});

test('文字化けは読み込みを止めずに警告する', () => {
    const problem = describeShareContentProblem(REPLACEMENT_CHAR.repeat(50) + 'あ'.repeat(10));
    assert.equal(problem && problem.level, 'warning');
});

test('置換文字がわずかに混ざるだけの台本は警告しない', () => {
    const script = 'あ'.repeat(2000) + REPLACEMENT_CHAR;
    assert.equal(describeShareContentProblem(script), null);
});

/* ========================================
   配信物との整合
   ======================================== */

test('index.html は format.js → share.js → app.js の順に読み込む', () => {
    const html = readProjectFile('index.html');
    const order = ['format.js', 'share.js', 'app.js'].map((name) => html.indexOf(`src="${name}?v=`));

    assert.ok(order.every((index) => index >= 0), `読み込まれていないスクリプトがある: ${order.join()}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'app.js は share.js より後に読み込むこと');
});

test('APIキーが設定されていれば案内文にGoogleドライブを含める', () => {
    const labels = listShareProviderLabels();
    const source = resolveShareSource('https://drive.google.com/file/d/1AbC/view');

    // 「案内には出るのに読めない」「読めるのに案内に出ない」を防ぐ
    assert.equal(labels.includes('Googleドライブ'), source.ok);
});
