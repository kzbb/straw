#!/usr/bin/env node
//
// バージョン文字列を index.html と sw.js の全箇所へ一括反映する。
//
//   node tools/bump-version.js 26.8.8    バージョンを書き換える
//   node tools/bump-version.js --check   全箇所が一致しているか確認する
//
// ビルド工程を持たない構成なので、手作業での取りこぼしをこのスクリプトで防ぐ。
//
// 【なぜ必ず上げる必要があるか】
// customHttp.yml が *.js / *.css を immutable で1年キャッシュさせているため、
// クエリ文字列 ?v= を変えないと利用者に新しい JS/CSS が届かない。
// index.html だけが no-cache なので、HTML は新しいのに JS は古いという
// 組み合わせが起きると、読み込み順やグローバル名の前提が崩れて動かなくなる。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** バージョンが埋め込まれている箇所の定義 */
const SITES = [
    {
        file: 'index.html',
        label: 'アセットのクエリ文字列 (?v=)',
        pattern: /\?v=([0-9][\w.]*)/g,
        replace: (version) => `?v=${version}`
    },
    {
        file: 'index.html',
        label: '画面表示のバージョン (ver.)',
        pattern: /ver\.([0-9][\w.]*)/g,
        replace: (version) => `ver.${version}`
    },
    {
        file: 'sw.js',
        label: 'Service Worker のキャッシュ名',
        pattern: /CACHE_NAME = 'straw-([\w.]+)'/g,
        replace: (version) => `CACHE_NAME = 'straw-${version}'`
    }
];

/** @returns {Array<{label: string, file: string, value: string}>} */
function collect() {
    const found = [];

    for (const site of SITES) {
        const text = fs.readFileSync(path.join(ROOT, site.file), 'utf8');
        for (const match of text.matchAll(site.pattern)) {
            found.push({ label: site.label, file: site.file, value: match[1] });
        }
    }

    return found;
}

function check() {
    const found = collect();

    if (found.length === 0) {
        console.error('✖ バージョン文字列が1つも見つかりませんでした');
        process.exit(1);
    }

    for (const item of found) {
        console.log(`  ${item.file.padEnd(11)} ${item.label.padEnd(30)} ${item.value}`);
    }

    const unique = [...new Set(found.map((item) => item.value))];
    if (unique.length !== 1) {
        console.error(`\n✖ バージョンが一致していません: ${unique.join(' / ')}`);
        console.error('  node tools/bump-version.js <version> で揃えてください。');
        process.exit(1);
    }

    console.log(`\n✔ ${found.length}箇所すべて ${unique[0]} で一致しています`);
}

/** @param {string} version */
function bump(version) {
    if (!/^[0-9][\w.]*$/.test(version)) {
        console.error(`✖ バージョン形式が不正です: ${version}`);
        process.exit(1);
    }

    /** @type {Map<string, string>} */
    const updated = new Map();
    let total = 0;

    for (const site of SITES) {
        const filePath = path.join(ROOT, site.file);
        const before = updated.get(site.file) ?? fs.readFileSync(filePath, 'utf8');

        let count = 0;
        const after = before.replace(site.pattern, () => {
            count++;
            return site.replace(version);
        });

        updated.set(site.file, after);
        total += count;
        console.log(`  ${site.file.padEnd(11)} ${site.label.padEnd(30)} ${count}箇所`);
    }

    for (const [file, text] of updated) {
        fs.writeFileSync(path.join(ROOT, file), text);
    }

    console.log(`\n✔ ${total}箇所を ${version} に更新しました`);
}

const arg = process.argv[2];

if (!arg) {
    console.error('使い方: node tools/bump-version.js <version> | --check');
    process.exit(1);
} else if (arg === '--check') {
    check();
} else {
    bump(arg);
}
