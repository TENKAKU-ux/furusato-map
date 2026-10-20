// 都道府県の地図（全国）と市区町村の地図（県のページ）。値の大きさで色分けし、押すとその自治体のページへ移る。
import type { FurusatoEntity } from "./data-contract";
import { axisYen, perPersonYen, yen, signedYen } from "./format";
import japan from "./japan-map.json";
import { classify, perCapita, toHash, valueOf, type Classes, type Mode } from "./logic";

export type MapMetric = "receiptAmountYen" | "residentTaxDeductionYen" | "primaryBalanceYen";

export const MAP_METRICS: [MapMetric, string][] = [
  ["receiptAmountYen", "受入額"],
  ["residentTaxDeductionYen", "住民税控除額"],
  ["primaryBalanceYen", "差額"],
];

/** 都道府県名の一覧（地図データの並び＝全国地方公共団体コード順） */
export const PREF_NAMES: string[] = japan.prefectures.map((p) => p.name);

// 金額は青の5段（多いほど濃い）。差額はマイナスを赤、プラスを青の各3段にする
const SEQ = ["#e4edfc", "#bdd3f6", "#8db1ee", "#5686e0", "#1d5fd6"];
const DIV = ["#b3261e", "#e0574f", "#f6b8b3", "#c9dbf8", "#7fa6ea", "#1d5fd6"];
const NONE = "#e6e8ec";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmt = (metric: MapMetric, v: number | null, mode: Mode = "total") =>
  mode === "perCapita" ? `1人あたり ${perPersonYen(v, metric === "primaryBalanceYen")}` : metric === "primaryBalanceYen" ? signedYen(v) : yen(v);
const colorOf = (c: Classes, v: number | null) => {
  const b = c.bin(v);
  return b < 0 ? NONE : (c.diverging ? DIV : SEQ)[b];
};

export function metricButtons(current: MapMetric): string {
  return `<div class="seg" role="group" aria-label="地図で色分けする値">${MAP_METRICS.map(
    ([m, label]) => `<button type="button" data-mapmetric="${m}" aria-pressed="${m === current}">${label}</button>`,
  ).join("")}</div>`;
}

function legend(c: Classes, metric: MapMetric, note: string, mode: Mode = "total"): string {
  const colors = c.diverging ? DIV : SEQ;
  // 縦に並べ、上を「多い（プラスが大きい）」側にする
  const items = c.ranges
    .map((r, i) => [r, i] as const)
    .reverse()
    .map(([r, i]) => {
      if (!r) return "";
      const label =
        mode === "perCapita"
          ? `${perPersonYen(r[0], metric === "primaryBalanceYen")}〜${perPersonYen(r[1], metric === "primaryBalanceYen")}`
          : metric === "primaryBalanceYen"
            ? `${sign(r[0])}〜${sign(r[1])}`
            : `${axisYen(r[0])}〜${axisYen(r[1])}`;
      return `<li><span class="sw" style="background:${colors[i]}"></span>${label}</li>`;
    })
    .join("");
  const [top, bottom] = metric === "primaryBalanceYen" ? ["プラスが大きい", "マイナスが大きい"] : ["多い", "少ない"];
  return `<div class="legend"><p class="legend-end">▲ ${top}</p><ul>${items}</ul><p class="legend-end">▼ ${bottom}</p><p class="legend-note">${note}</p></div>`;
}

const sign = (v: number) => (v > 0 ? `+${axisYen(v)}` : v < 0 ? `−${axisYen(-v)}` : "0");

// ── 全国（都道府県）の地図 ──

/** 都道府県ごとの値。県自身と県内の市区町村の合計（総務省の報道資料の都道府県別の表と同じ範囲）。 */
export function prefTotals(entities: FurusatoEntity[], metric: MapMetric): Map<string, number | null> {
  const sums = new Map<string, number | null>();
  for (const e of entities) {
    const v = e[metric];
    const cur = sums.get(e.prefName);
    sums.set(e.prefName, cur === null || v === null ? null : (cur ?? 0) + v);
  }
  return sums;
}

export function nationalMap(entities: FurusatoEntity[], metric: MapMetric, mode: Mode, current?: string): string {
  const sums = prefTotals(entities, metric);
  // 1人あたりは「県内合計（県＋市区町村）÷県の人口」
  const prefPop = new Map(entities.filter((e) => e.kind === "prefecture").map((e) => [e.name, e.population]));
  const totals = new Map([...sums].map(([n, v]) => [n, mode === "perCapita" ? perCapita(v, prefPop.get(n) ?? null) : v]));
  const c = classify(PREF_NAMES.map((n) => totals.get(n) ?? null), metric === "primaryBalanceYen");
  const label = MAP_METRICS.find(([m]) => m === metric)![1];
  const paths = japan.prefectures
    .map((p) => {
      const v = totals.get(p.name) ?? null;
      return `<a href="${toHash({ pref: p.name })}" data-maplabel="${esc(`${p.name}　${label} ${fmt(metric, v, mode)}`)}" aria-label="${esc(`${p.name}（${label} ${fmt(metric, v, mode)}）`)}"><path d="${p.d}" fill="${colorOf(c, v)}"${p.name === current ? ' class="is-current"' : ""}/></a>`;
    })
    .join("");
  const [fx, fy, fw, fh] = japan.okinawaFrame;
  const options = PREF_NAMES.map((n) => `<option value="${esc(n)}"${n === current ? " selected" : ""}>${esc(n)}</option>`).join("");
  return `
  <div class="map-wrap">
    <svg class="map map-japan" viewBox="${japan.viewBox.join(" ")}" role="group" aria-label="都道府県の地図">
      <rect class="inset" x="${fx}" y="${fy}" width="${fw}" height="${fh}" rx="4"/>
      ${paths}
    </svg>
    ${legend(c, metric, `都道府県ごとに、県と県内の市区町村の合計${mode === "perCapita" ? "を県の人口で割った額" : ""}で色分けしています。地域を押すと、その都道府県の市区町村の一覧へ移ります。`, mode)}
  </div>
  <label class="pref-select">都道府県を選ぶ
    <select data-pref-select><option value="">選んでください</option>${options}</select>
  </label>`;
}

// ── 県の中（市区町村）の地図 ──

interface PrefShapes {
  viewBox: number[];
  shapes: { code: string | null; name: string | null; d: string }[];
  outside: { code: string; name: string }[];
}

const cache = new Map<number, Promise<PrefShapes>>();

function loadPref(prefCode: number): Promise<PrefShapes> {
  let p = cache.get(prefCode);
  if (!p) {
    p = fetch(`./map/${String(prefCode).padStart(2, "0")}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<PrefShapes>;
      })
      .catch((err) => {
        cache.delete(prefCode); // 失敗は覚えておかず、次に開いたときに取り直す
        throw err;
      });
    cache.set(prefCode, p);
  }
  return p;
}

/** 県のページの市区町村の地図。描く先の要素に、読み込みが済んでから差し込む。 */
export async function fillPrefMap(el: HTMLElement, prefName: string, entities: FurusatoEntity[], metric: MapMetric, mode: Mode, highlight?: string) {
  const prefCode = PREF_NAMES.indexOf(prefName) + 1;
  const munis = new Map(entities.filter((e) => e.kind === "municipality" && e.prefName === prefName).map((e) => [e.code, e]));
  const c = classify([...munis.values()].map((e) => valueOf(e, metric, mode)), metric === "primaryBalanceYen");
  const label = MAP_METRICS.find(([m]) => m === metric)![1];
  let data: PrefShapes;
  try {
    data = await loadPref(prefCode);
  } catch {
    el.innerHTML = `<p class="note">地図を読み込めませんでした。下の一覧から選んでください。</p>`;
    return;
  }
  if (!el.isConnected) return;
  const paths = data.shapes
    .map((s) => {
      const e = s.code ? munis.get(s.code) : undefined;
      if (!e) return `<path d="${s.d}" fill="${NONE}" class="no-data"/>`;
      const v = valueOf(e, metric, mode);
      return `<a href="${toHash({ code: e.code })}" data-maplabel="${esc(`${e.name}　${label} ${fmt(metric, v, mode)}`)}" aria-label="${esc(`${e.name}（${label} ${fmt(metric, v, mode)}）`)}"><path d="${s.d}" fill="${colorOf(c, v)}"${e.code === highlight ? ' class="is-current"' : ""}/></a>`;
    })
    .join("");
  const outside = data.outside.length
    ? `<div class="map-outside"><p>地図の外の島</p><ul>${data.outside
        .map((o) => {
          const e = munis.get(o.code);
          const v = e ? valueOf(e, metric, mode) : null;
          return `<li><a href="${toHash({ code: o.code })}" data-maplabel="${esc(`${o.name}　${label} ${fmt(metric, v, mode)}`)}"><span class="sw" style="background:${colorOf(c, v)}"></span>${esc(o.name)}</a></li>`;
        })
        .join("")}</ul></div>`
    : "";
  el.innerHTML = `
  <div class="map-wrap">
    <div>
      <svg class="map map-pref" viewBox="${data.viewBox.join(" ")}" role="group" aria-label="${esc(prefName)}の市区町村の地図">${paths}</svg>
      ${outside}
    </div>
    ${legend(c, metric, `${esc(prefName)}の市区町村どうしで比べた色分けです${mode === "perCapita" ? "（人口1人あたり）" : ""}。地域を押すと、その市区町村のページへ移ります。`, mode)}
  </div>`;
}

// ── 地図に触れたときの名前と値 ──

/** 触れている地域を最前面に描き直し、太い枠線が隣の地域に隠れないようにする */
function front(a: Element) {
  const parent = a.parentNode;
  // フォーカス中の地域は動かさない（DOM を付け替えるとフォーカスが外れ、Enter で開けなくなる）
  if (a.contains(document.activeElement)) return;
  if (a.closest("svg") && parent && parent.lastElementChild !== a) parent.appendChild(a);
}

let label: HTMLDivElement | null = null;

export function bindMapLabel() {
  label = document.createElement("div");
  label.className = "map-label";
  label.hidden = true;
  document.body.append(label);
  document.addEventListener("pointermove", (ev) => {
    const a = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-maplabel]") : null;
    if (!a || ev.pointerType !== "mouse") {
      label!.hidden = true;
      return;
    }
    front(a);
    label!.textContent = a.dataset.maplabel!;
    label!.hidden = false;
    const w = label!.offsetWidth;
    label!.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - w - 8)}px`;
    label!.style.top = `${ev.clientY + 18}px`;
  });
  // キーボードで地域へ移ったときも、その地域の近くに名前と値を出す
  document.addEventListener("focusin", (ev) => {
    const a = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-maplabel]") : null;
    if (!a) return hide();
    // ここでは front() しない（要素を動かすとキーボードのフォーカスが外れるため）
    label!.textContent = a.dataset.maplabel!;
    label!.hidden = false;
    const r = a.getBoundingClientRect();
    const w = label!.offsetWidth;
    label!.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8))}px`;
    label!.style.top = `${Math.min(r.bottom + 8, window.innerHeight - label!.offsetHeight - 8)}px`;
  });
  document.addEventListener("focusout", (ev) => {
    if (ev.target instanceof Element && ev.target.closest("[data-maplabel]")) hide();
  });
  const hide = () => {
    if (label) label.hidden = true;
  };
  // スクロールしたときと、別のページへ移ったときは消す（マウスが動くまで前の地域の名前が残らないように）
  document.addEventListener("scroll", hide, { passive: true });
  window.addEventListener("hashchange", hide);
}
