// 共有カード: 自治体ごとに X などで使う共有ページ（dist/s/{code}.html）とカード画像（dist/og/{code}.png）を作る。
// 公開先の URL（SITE_URL）が決まっていないときは作らない（OGP の画像は絶対 URL でないと読まれないため、仮の URL は埋めない）。
// 使い方: SITE_URL=https://example.github.io/furusato-map/ npm run build
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import UPNG from "upng-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = join(ROOT, "dist");
const FONTS = [join(ROOT, "tools/fonts/BIZUDPGothic-Regular.ttf"), join(ROOT, "tools/fonts/BIZUDPGothic-Bold.ttf")];
const SITE_NAME = "ふるさと納税マップ";
const COLORS = Number(process.env.OG_COLORS ?? 16); // PNG の色数
const WIDTH = Number(process.env.OG_WIDTH ?? 900); // 書き出す幅（1200×630 で描いて縮める。X の大きいカードは幅500px前後で表示される）
const ONLY = process.env.OG_ONLY ? new Set(process.env.OG_ONLY.split(",")) : null; // 確認用に一部だけ作る

const site = process.env.SITE_URL;
if (!site) {
  console.log("共有カード: SITE_URL が無いので作りません（公開先が決まったら SITE_URL を付けてビルドする）");
  process.exit(0);
}
if (!/^https:\/\/[^/]+(\/.*)?$/.test(site)) {
  console.error(`共有カード: SITE_URL は https:// で始まる公開先の URL にしてください: ${site}`);
  process.exit(1);
}
const base = site.endsWith("/") ? site : `${site}/`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// 画面と同じ表記（src/format.ts の yen / signedYen と同じ規則: 万の位で四捨五入）
function yen(v) {
  if (v === null) return "—";
  const sign = v < 0 ? "−" : "";
  const abs = Math.abs(v);
  if (abs < 10000) return `${sign}${abs.toLocaleString("ja-JP")}円`;
  const totalMan = Math.round(abs / 10000);
  const oku = Math.floor(totalMan / 10000);
  const man = totalMan % 10000;
  if (oku === 0) return `${sign}${man.toLocaleString("ja-JP")}万円`;
  return man === 0 ? `${sign}${oku.toLocaleString("ja-JP")}億円` : `${sign}${oku.toLocaleString("ja-JP")}億${man.toLocaleString("ja-JP")}万円`;
}
const signedYen = (v) => (v === null || v <= 0 ? yen(v) : `＋${yen(v)}`);

// 字の幅（太字・大きさ100pxで実際に描いて測る。同じ字は1回だけ測る）
const FONT_OPTS = { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "BIZ UDPGothic" };
const advance = new Map();
function charWidth(ch) {
  if (!advance.has(ch)) {
    // 字の前後を「|」ではさみ、はさんだ幅から「||」の幅を引いて、字そのものの送り幅を出す
    const measure = (t) =>
      new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="200"><text x="0" y="150" font-size="100" font-weight="700">${esc(t)}</text></svg>`, { font: FONT_OPTS }).innerBBox()?.width ?? 0;
    advance.set(ch, (measure(`|${ch}|`) - measure("||")) / 100);
  }
  return advance.get(ch);
}
const emWidth = (text) => [...text].reduce((w, ch) => w + charWidth(ch), 0);
/** 決めた幅 maxPx に収まるいちばん大きな文字の大きさ（上限 maxSize） */
const fitSize = (text, maxPx, maxSize) => Math.min(maxSize, Math.floor(maxPx / emWidth(text)));

function card(e) {
  const title = e.kind === "prefecture" ? e.name : `${e.prefName} ${e.name}`;
  const nameSize = fitSize(title, 1072, 76);
  const cols = [
    ["受入額", yen(e.receiptAmountYen)],
    ["住民税控除額（推計含む）", yen(e.residentTaxDeductionYen)],
    ["差額（受入額 − 住民税控除額）", signedYen(e.primaryBalanceYen)],
  ];
  const colX = [64, 440, 816];
  const figures = cols
    .map(
      ([label, value], i) => `
    <text x="${colX[i]}" y="330" font-size="24" fill="#4a5160">${esc(label)}</text>
    <text x="${colX[i]}" y="390" font-size="${fitSize(value, 340, 46)}" font-weight="700" fill="#161a22">${esc(value)}</text>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#ffffff"/>
  <rect width="1200" height="10" fill="#1d5fd6"/>
  <text x="64" y="96" font-size="30" font-weight="700" fill="#1d5fd6">${SITE_NAME}</text>
  <text x="64" y="210" font-size="${nameSize}" font-weight="700" fill="#161a22">${esc(title)}</text>
  <line x1="64" y1="262" x2="1136" y2="262" stroke="#e2e6ee" stroke-width="2"/>
  ${figures}
  <line x1="64" y1="452" x2="1136" y2="452" stroke="#e2e6ee" stroke-width="2"/>
  <text x="64" y="496" font-size="22" fill="#4a5160">受入は令和7年度決算見込、控除は令和8年度課税（推計値を含む）。</text>
  <text x="64" y="530" font-size="22" fill="#4a5160">差額は地方交付税・所得税控除を含まず、実際の損益ではありません。</text>
  <text x="64" y="584" font-size="20" fill="#7a8190">出典：総務省「ふるさと納税に関する現況調査結果」を加工して作成（個人による非公式のサイト）</text>
</svg>`;
}

function page(e) {
  const title = e.kind === "prefecture" ? e.name : `${e.prefName}${e.name}`;
  const desc = `受入額 ${yen(e.receiptAmountYen)}・住民税控除額 ${yen(e.residentTaxDeductionYen)}・差額 ${signedYen(e.primaryBalanceYen)}（総務省の公表値を加工）`;
  const url = `${base}s/${e.code}.html`;
  const image = `${base}og/${e.code}.png`;
  const target = `../#${e.code}`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}のふるさと納税の収支 | ${SITE_NAME}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${esc(title)}のふるさと納税の収支">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="${WIDTH}">
<meta property="og:image:height" content="${Math.round((WIDTH * 630) / 1200)}">
<meta name="twitter:card" content="summary_large_image">
<script>location.replace(${JSON.stringify(target)});</script>
</head>
<body>
<p><a href="${esc(target)}">${esc(title)}のページを開く</a></p>
</body>
</html>
`;
}

const data = JSON.parse(readFileSync(join(DIST, "data/furusato.json"), "utf8"));
mkdirSync(join(DIST, "s"), { recursive: true });
mkdirSync(join(DIST, "og"), { recursive: true });
const t0 = Date.now();
let bytes = 0;
const targets = data.entities.filter((x) => !ONLY || ONLY.has(x.code));
for (const e of targets) {
  const img = new Resvg(card(e), { font: FONT_OPTS, fitTo: { mode: "width", value: WIDTH } }).render();
  // 色数を減らした PNG にして軽くする（白地・文字・青の線だけなので、色を減らしても見た目は変わらない）
  const rgba = img.pixels;
  const png = Buffer.from(UPNG.encode([rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength)], img.width, img.height, COLORS));
  writeFileSync(join(DIST, "og", `${e.code}.png`), png);
  writeFileSync(join(DIST, "s", `${e.code}.html`), page(e));
  bytes += png.length;
}
console.log(
  `共有カード: ${targets.length}件（画像 合計 ${(bytes / 1e6).toFixed(1)}MB）を ${((Date.now() - t0) / 1000).toFixed(1)}秒で作りました。公開先: ${base}`,
);
