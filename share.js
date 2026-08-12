// @ts-check

/*
========================================
共有リンク（URLの解釈）
========================================
straw はサーバーを持たないので、台本そのものを預かることはできない。
共有できるのは「どこかに置かれた台本テキストを指すURL」だけ。

    https://straw.bblab.org/?src=<台本テキストのURL>

開いた人のブラウザが、そのURLへ直接取りに行く。取得先が
Access-Control-Allow-Origin を返さないと読めないため、主要な置き場所に
ついては取得可能な形へURLを変換する。

台本本体をURLへ圧縮して載せる方式は採らない。60分ものの台本を2万字とすると
UTF-8で約60KB、gzipして base64 にしても3万文字近くになり、メールやチャットで
途中が切れる。実用的な長さの台本がほぼ全部上限を超えるため、方式として成立しない。

このファイルは DOM も fetch も触らない。URL文字列とテキストだけを扱う。
index.html では format.js → share.js → app.js の順に読み込むこと。
*/

/* ========================================
   配信環境ごとに書き換える設定
   ======================================== */

/**
 * Googleドライブの共有リンクを読み込むための Google Cloud APIキー。
 *
 * 空文字にすると、Googleドライブのリンクだけが理由を添えて拒否される。
 * 他の置き場所（GitHub / Dropbox / OneDrive / CORS許可済みのサーバー）は
 * キーが無くても動く。
 *
 * ■ なぜキーが要るのか
 *
 * Googleドライブの共有URL（drive.google.com）は CORS ヘッダーを返さないので、
 * ブラウザから直接は取得できない。Drive API（www.googleapis.com）は返すため、
 * そちら経由なら読める。ただしAPIキーが要る。
 *
 * ■ このキーについて
 *
 * MITO（mito.bblab.org）と同じキーを使っている。キーはリファラー制限で
 * 守られており、制限に登録されたドメインからしか使えない。
 * straw を配信する前に、Google Cloud コンソールの
 * 「APIとサービス」→「認証情報」→ 該当キー →「ウェブサイトの制限」へ
 *
 *     https://straw.bblab.org/*
 *
 * を追加すること。追加しないと、Googleドライブのリンクだけが HTTP 403 になる。
 * 手元で index.html を直接開いた場合や localhost 配信でも 403 になるが、
 * これは制限が働いている正常な状態（手元でも試したいなら localhost の項目も足す）。
 *
 * キーは配信ファイルに書かれる以上、閲覧者からは必ず見える。守っているのは
 * キーの秘匿ではなくリファラー制限なので、制限をかけないまま公開しないこと。
 *
 * ■ 共有する側がやること
 *
 * キーが認可するのはアプリからのAPI利用であって、ファイルへのアクセス権ではない。
 * 読めるのは「リンクを知っている全員」に設定されたファイルだけ。
 */
const SHARE_GOOGLE_DRIVE_API_KEY = 'AIzaSyCvHPX2M3H2tqXF83Hawz29Vi0D7whGTJM';

/* ========================================
   定数
   ======================================== */

/**
 * 参照先から取得を許す最大サイズ（バイト）。
 * 台本テキストなので、2MB（日本語で約66万字）あれば足りる。
 */
const SHARE_MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** ファイル名を推測できなかったときの表示名 */
const SHARE_DEFAULT_FILE_NAME = '共有台本.txt';

/** 共有URLで台本の場所を渡すクエリパラメーター名 */
const SHARE_SOURCE_PARAM = 'src';

/**
 * @typedef {{
 *   ok: true,
 *   provider: string,
 *   providerLabel: string,
 *   fetchUrl: string,
 *   displayUrl: string,
 *   fileName: string
 * }} ResolvedShareSource
 * @typedef {{ ok: false, reason: string }} UnresolvedShareSource
 */

/* ========================================
   URLの変換
   ======================================== */

/**
 * 文字列を base64url へ変換する（OneDrive の shares API 用）。
 *
 * @param {string} text
 * @returns {string}
 */
function shareTextToBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * URLの末尾セグメントからファイル名を推測する。
 *
 * @param {URL} parsed
 * @returns {string}
 */
function shareFileNameFromUrl(parsed) {
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return SHARE_DEFAULT_FILE_NAME;

    let last = segments[segments.length - 1];
    try {
        last = decodeURIComponent(last);
    } catch (error) {
        // 壊れたパーセントエンコードはそのまま扱う
    }

    return last.toLowerCase().endsWith('.txt') ? last : SHARE_DEFAULT_FILE_NAME;
}

/**
 * GoogleドライブのURLからファイルIDを取り出す。
 *
 * @param {URL} parsed
 * @returns {string}
 */
function shareGoogleDriveFileId(parsed) {
    const fromQuery = parsed.searchParams.get('id');
    if (fromQuery) return fromQuery;

    // https://drive.google.com/file/d/{id}/view の {id} を拾う
    const segments = parsed.pathname.split('/').filter(Boolean);
    const markerIndex = segments.indexOf('d');
    if (markerIndex >= 0 && segments.length > markerIndex + 1) {
        return segments[markerIndex + 1];
    }

    return '';
}

/**
 * 置き場所の共有リンクを、ブラウザから取得できる形のURLへ変換する。
 *
 * 変換できない置き場所は、理由を添えて拒否する。黙って失敗させると
 * 「straw の不具合」に見えてしまうため。
 *
 * @param {string} rawUrl - 利用者が貼り付けたURL
 * @returns {ResolvedShareSource | UnresolvedShareSource}
 */
function resolveShareSource(rawUrl) {
    const trimmed = String(rawUrl ?? '').trim();
    if (!trimmed) {
        return { ok: false, reason: 'URLが空です。' };
    }

    /** @type {URL} */
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (error) {
        return { ok: false, reason: 'URLとして解釈できませんでした。' };
    }

    // javascript: や data: を弾く。http: も混在コンテンツで読めないため許可しない。
    if (parsed.protocol !== 'https:') {
        return { ok: false, reason: 'https で始まるURLだけを読み込めます。' };
    }

    const host = parsed.hostname.toLowerCase();
    const displayUrl = parsed.href;

    if (host === 'github.com') {
        // https://github.com/{owner}/{repo}/blob/{ref}/{path}
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments[2] !== 'blob' || segments.length < 5) {
            return {
                ok: false,
                reason: 'GitHubはファイルページのURL（.../blob/...）を指定してください。'
            };
        }

        const rawPath = [segments[0], segments[1], ...segments.slice(3)].join('/');
        return {
            ok: true,
            provider: 'github',
            providerLabel: 'GitHub',
            fetchUrl: `https://raw.githubusercontent.com/${rawPath}`,
            displayUrl,
            fileName: shareFileNameFromUrl(parsed)
        };
    }

    if (host === 'www.dropbox.com' || host === 'dropbox.com') {
        // 共有リンクのホストを差し替えると、CORSヘッダー付きで本体が返る
        const target = new URL(parsed.href);
        target.hostname = 'dl.dropboxusercontent.com';
        target.searchParams.set('dl', '1');
        return {
            ok: true,
            provider: 'dropbox',
            providerLabel: 'Dropbox',
            fetchUrl: target.href,
            displayUrl,
            fileName: shareFileNameFromUrl(parsed)
        };
    }

    if (host === '1drv.ms' || host === 'onedrive.live.com') {
        // 共有URL自体を base64url にして shares API へ渡す形式
        return {
            ok: true,
            provider: 'onedrive',
            providerLabel: 'OneDrive',
            fetchUrl: `https://api.onedrive.com/v1.0/shares/u!${shareTextToBase64Url(parsed.href)}/root/content`,
            displayUrl,
            fileName: shareFileNameFromUrl(parsed)
        };
    }

    if (host === 'drive.google.com' || host === 'drive.usercontent.google.com') {
        const fileId = shareGoogleDriveFileId(parsed);
        if (!fileId) {
            return {
                ok: false,
                reason: 'GoogleドライブのURLからファイルIDを読み取れませんでした。共有リンクをそのまま貼り付けてください。'
            };
        }

        if (!SHARE_GOOGLE_DRIVE_API_KEY) {
            return {
                ok: false,
                reason: 'この配信環境ではGoogleドライブの読み込みが設定されていません（share.js のAPIキーが空です）。'
            };
        }

        return {
            ok: true,
            provider: 'googledrive',
            providerLabel: 'Googleドライブ',
            fetchUrl: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`
                + `?alt=media&key=${encodeURIComponent(SHARE_GOOGLE_DRIVE_API_KEY)}`,
            displayUrl,
            // Drive APIはURLからファイル名を判断できない
            fileName: SHARE_DEFAULT_FILE_NAME
        };
    }

    // 変換規則を持たない置き場所。CORSを返すサーバーならそのまま読める。
    return {
        ok: true,
        provider: 'direct',
        providerLabel: '外部URL',
        fetchUrl: parsed.href,
        displayUrl,
        fileName: shareFileNameFromUrl(parsed)
    };
}

/**
 * 共有リンクをそのまま貼れる置き場所の名前。
 *
 * Googleドライブだけは配信環境の設定（APIキー）次第で使えたり使えなかったり
 * するため、案内文とエラーメッセージが食い違わないよう判定をここに集約する。
 *
 * @returns {string[]}
 */
function listShareProviderLabels() {
    const labels = ['GitHub', 'Dropbox', 'OneDrive'];
    if (SHARE_GOOGLE_DRIVE_API_KEY) labels.push('Googleドライブ');

    return labels;
}

/* ========================================
   共有URLの組み立てと読み取り
   ======================================== */

/**
 * 現在のURLから、共有された台本の場所を読み取る。
 *
 * @param {string} href - straw 自身のURL
 * @returns {string} 台本のURL（共有リンクでなければ空文字）
 */
function readShareSourceParam(href) {
    try {
        return new URL(href).searchParams.get(SHARE_SOURCE_PARAM) ?? '';
    } catch (error) {
        return '';
    }
}

/**
 * 共有URLを組み立てる。
 *
 * 載せるのは利用者が貼った元のURL。取得用URLへの変換は開く側が毎回行うので、
 * 変換規則を直しても配布済みのリンクが古びない。
 *
 * @param {string} baseHref - straw 自身のURL
 * @param {string} sourceUrl - 台本テキストのURL
 * @returns {string}
 */
function buildShareUrl(baseHref, sourceUrl) {
    const url = new URL(baseHref);
    url.search = '';
    url.hash = '';
    url.searchParams.set(SHARE_SOURCE_PARAM, sourceUrl);

    return url.href;
}

/* ========================================
   取得したテキストの検査
   ======================================== */

/**
 * 取得したテキストが台本として使えるものか調べる。
 *
 * 参照先はプレーンテキストなので、JSONのように「解析に失敗したから中身が違う」
 * とは判断できない。ログイン画面のHTMLやPDFがそのままエディタへ流れ込むと、
 * 利用者には何が起きたのか分からない。ここで代表的な失敗を言葉にする。
 *
 * @param {string} text
 * @returns {{ level: 'error' | 'warning', message: string } | null} 問題が無ければ null
 */
function describeShareContentProblem(text) {
    const head = text.slice(0, 512).trimStart().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
        return {
            level: 'error',
            message: '台本テキストではなくWebページが返ってきました。'
                + 'ファイル本体ではなく、プレビュー画面やログイン画面のURLを指している可能性があります。'
        };
    }

    // ヌル文字はテキストファイルには現れない（PDFや圧縮ファイルの目印）
    if (text.includes('\u0000')) {
        return {
            level: 'error',
            message: 'テキストファイルではないようです。.txt 以外のファイルを指している可能性があります。'
        };
    }

    // Shift_JIS のファイルを UTF-8 として読むと、ほぼ全ての漢字が U+FFFD になる。
    // 台本は読めてしまう部分もあるため、止めずに知らせるだけにする。
    const brokenCount = (text.match(/\uFFFD/g) ?? []).length;
    if (brokenCount >= 3 && brokenCount / Math.max(text.length, 1) > 0.01) {
        return {
            level: 'warning',
            message: '文字化けしています。元のファイルの文字コードがUTF-8か確認してください。'
        };
    }

    return null;
}

/*
Node（テスト）から読み込めるようにする。
format.js と同じ理由で、いったん変数へ受けてから触る。
ブラウザではグローバル関数としてそのまま app.js から呼ぶ。
*/
// @ts-ignore - module は Node 実行時のみ存在するグローバル
const shareNodeModule = typeof module === 'object' && module ? module : null;
if (shareNodeModule) {
    shareNodeModule.exports = {
        SHARE_MAX_SOURCE_BYTES,
        SHARE_DEFAULT_FILE_NAME,
        SHARE_SOURCE_PARAM,
        resolveShareSource,
        listShareProviderLabels,
        readShareSourceParam,
        buildShareUrl,
        describeShareContentProblem,
    };
}
