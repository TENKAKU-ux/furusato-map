import type { EntityKind, FurusatoData, FurusatoEntity, ReceiptHistoryPoint } from "./data-contract";
import { axisYen, count, fiscalYearLabel, people, percent, perPersonYen, signedYen, yen } from "./format";
import { chartGeometry, divide, parseHash, perCapita, rankAmong, rankOf, ranking, search, toHash, type Metric, type Mode, type Order, type Route } from "./logic";
import { createAgentTools } from "./agent-tools";
import { GLOSSARY, type TermKey } from "./glossary";
import { bindMapLabel, fillPrefMap, metricButtons, nationalMap, PREF_NAMES, type MapMetric } from "./map";
import { registerAgentTools } from "./webmcp";

const app = document.getElementById("app")!;
const footer = document.getElementById("footer")!;

const PAGE = 30;
// 出典として示すページ（公共データ利用規約1.0の出典記載例に合わせ、ページのURLを書く）
const SOUMU_PAGE = "https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/archive/";
const GSI_PAGE = "https://www.gsi.go.jp/kankyochiri/gm_jpn.html";
const ESTAT_PAGE = "https://www.e-stat.go.jp/stat-search/files?cycle=7&layout=dataset&stat_infid=000040479049&toukei=00200241";
const GRANT_PAGE = "https://www.soumu.go.jp/main_sosiki/c-zaisei/kouhu.html";
const QUICK = ["131121", "272132", "141003"]; // 世田谷区・泉佐野市・横浜市

interface State {
  data: FurusatoData;
  byCode: Map<string, FurusatoEntity>;
  kind: EntityKind;
  metric: Metric;
  order: Order;
  shown: number;
  mapMetric: MapMetric;
  mode: Mode;
  /** 都道府県のページの順位の表の範囲 */
  prefScope: PrefScope;
}
type PrefScope = "local" | "prefs";
let state: State;
let pendingScroll: string | null = null;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fullName = (e: FurusatoEntity) => (e.kind === "prefecture" ? e.name : `${e.prefName} ${e.name}`);

// ── 検索欄 ──

function searchBox(large: boolean): string {
  return `
  <form class="search ${large ? "search-lg" : ""}" role="search" autocomplete="off">
    <label class="visually-hidden" for="q">自治体名</label>
    <input id="q" name="q" type="search" placeholder="自治体名を入力（例: 世田谷区）" aria-controls="suggest" aria-expanded="false" />
    <button type="submit" class="btn-primary">検索する</button>
    <ul id="suggest" class="suggest" role="listbox" hidden></ul>
  </form>`;
}

function bindSearch() {
  const form = app.querySelector<HTMLFormElement>("form.search");
  if (!form) return;
  const input = form.querySelector<HTMLInputElement>("#q")!;
  const list = form.querySelector<HTMLUListElement>("#suggest")!;
  let hits: FurusatoEntity[] = [];
  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
  };
  input.addEventListener("input", () => {
    hits = search(state.data.entities, input.value);
    if (!input.value.trim()) return close();
    list.innerHTML = hits.length
      ? hits
          .map(
            (e) =>
              `<li role="option"><a href="${toHash({ code: e.code })}"><span class="sg-pref">${esc(e.kind === "prefecture" ? "都道府県" : e.prefName)}</span>${esc(e.name)}</a></li>`,
          )
          .join("")
      : `<li class="sg-none">見つかりませんでした</li>`;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
  });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    hits = search(state.data.entities, input.value);
    if (hits.length) location.hash = toHash({ code: hits[0].code });
  });
}

// 用語の説明: 画面を基準に置き、表の横スクロール枠で切れないようにする
let openTerm: HTMLElement | null = null;

function showTip(el: HTMLElement) {
  if (openTerm && openTerm !== el) hideTip();
  const tip = el.querySelector<HTMLElement>(".tip");
  if (!tip) return;
  openTerm = el;
  el.classList.add("is-open");
  el.setAttribute("aria-expanded", "true");
  const r = el.getBoundingClientRect();
  const margin = 12;
  const width = Math.min(340, window.innerWidth - margin * 2);
  tip.style.width = `${width}px`;
  const left = Math.min(Math.max(margin, r.left), window.innerWidth - width - margin);
  tip.style.left = `${left}px`;
  // 高さは画面に収まる分まで（はみ出す分は説明の中でスクロール）。下→上→画面内に寄せる、の順で置く
  tip.style.maxHeight = `${window.innerHeight - margin * 2}px`;
  const h = tip.offsetHeight;
  const below = r.bottom + 8;
  const above = r.top - 8 - h;
  let top = below;
  if (below + h > window.innerHeight - margin) top = above >= margin ? above : window.innerHeight - margin - h;
  tip.style.top = `${Math.max(margin, top)}px`;
}

function hideTip() {
  if (!openTerm) return;
  openTerm.classList.remove("is-open");
  openTerm.setAttribute("aria-expanded", "false");
  openTerm = null;
}

const termOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>(".term") : null);
// マウスは合わせている間だけ開く。指（タップ）は押すたびに開閉する。外を押すと閉じる。
// どちらの操作かは端末の種類でなく、その操作の pointerType で決める
let lastPointer = ""; // 直前に押した操作の種類（"mouse" / "touch" / "pen"）。キーボードでは空
document.addEventListener("pointerover", (ev) => {
  if (ev.pointerType !== "mouse") return;
  const el = termOf(ev.target);
  if (el) showTip(el);
  else if (openTerm && !openTerm.contains(ev.target as Node)) hideTip();
});
document.addEventListener("pointerdown", (ev) => {
  lastPointer = ev.pointerType;
});
// スクロールで押す操作が取り消されたときや、キーボードに戻ったときは「押した」印を消す
document.addEventListener("pointercancel", () => {
  lastPointer = "";
});
document.addEventListener(
  "keydown",
  () => {
    lastPointer = "";
  },
  true,
);
document.addEventListener("click", (ev) => {
  const pointer = lastPointer;
  lastPointer = "";
  const el = termOf(ev.target);
  if (!el) return hideTip();
  if (openTerm === el && pointer !== "mouse") hideTip();
  else showTip(el);
});
// 押したときのフォーカスは開閉に使わない（続く click が決める）。キーボードで移ったときだけ開く
document.addEventListener("focusin", (ev) => {
  if (lastPointer) return;
  const el = termOf(ev.target);
  if (el) showTip(el);
  else hideTip();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") hideTip();
});
// スクロールや幅の変化（スマホのアドレスバーの伸び縮みを含む）では閉じず、位置を合わせ直す
const follow = () => {
  if (openTerm) showTip(openTerm);
};
window.addEventListener("scroll", follow, { passive: true });
window.addEventListener("resize", follow);

// 検索候補は、検索欄の外を押したら閉じる（描画のたびに登録しないよう1回だけ）
document.addEventListener("click", (ev) => {
  const form = app.querySelector("form.search");
  const list = app.querySelector<HTMLUListElement>("#suggest");
  if (form && list && !form.contains(ev.target as Node)) list.hidden = true;
});

// ヘッダーのナビ: hash を変えずに該当の節へ移る。「自治体を調べる」は最初の画面へ
document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((a) =>
  a.addEventListener("click", (ev) => {
    const target = a.dataset.nav!;
    if (target === "search") return; // href="#" で最初の画面へ
    ev.preventDefault();
    if (target === "ranking" && app.querySelector("[data-preftab]")) {
      // 都道府県のページ（#pref=… でも #130001 でも）からは、全国の市区町村の一覧へ戻す
      state.kind = "municipality";
      pendingScroll = "ranking";
      location.hash = "";
      return;
    }
    document.getElementById(target)?.scrollIntoView({ behavior: "smooth" });
  }),
);

// ── 用語の説明 ──

let tipSeq = 0;

/** カーソルを合わせる・タップする・キーボードで移ると、用語の説明と見方が出る見出し。 */
function term(key: TermKey, label: string = GLOSSARY[key].title): string {
  const t = GLOSSARY[key];
  const id = `tip-${++tipSeq}`;
  return `<span class="term" tabindex="0" role="button" aria-describedby="${id}" aria-expanded="false" data-term="${key}">${esc(label)}<span class="tip" role="tooltip" id="${id}"><strong class="tip-title">${esc(t.title)}</strong><span class="tip-what">${esc(t.what)}</span><span class="tip-how"><b>見方</b>${esc(t.how)}</span></span></span>`;
}

// ── 自治体の数値 ──

function figures(e: FurusatoEntity): string {
  return `${figuresTop(e)}
  <div class="details">
    ${perCapitaBlock(e)}
    ${grantBlock(e)}
    ${usersBlock(e)}
    ${costBlock(e)}
  </div>`;
}

/** 上の大きな数字4つと、参考差額・注記 */
function figuresTop(e: FurusatoEntity): string {
  const meta = state.data.metadata.notes;
  const dedLabel = e.kind === "prefecture" ? term("deductionPref") : term("deduction");
  const proxy =
    e.proxyReceiptAmountYen && e.proxyReceiptAmountYen > 0
      ? `<p class="note">受入額に、他の自治体の代わりに受け入れた寄附（${term("proxy")}）${yen(e.proxyReceiptAmountYen)} を含みます（被災した自治体へ全額渡す前提の額です）。</p>`
      : "";
  return `
  <dl class="figures">
    <div><dt>${term("receipt")}</dt><dd>${big(e.receiptAmountYen)}</dd><dd class="sub">${count(e.receiptCount)}</dd><dd class="badges">${badges(e, (x) => x.receiptAmountYen)}</dd></div>
    <div><dt>${term("cost")}</dt><dd>${big(e.solicitationCostYen)}</dd><dd class="badges">${badges(e, (x) => x.solicitationCostYen)}</dd></div>
    <div><dt>${dedLabel}</dt><dd>${big(e.residentTaxDeductionYen)}</dd><dd class="badges">${badges(e, (x) => x.residentTaxDeductionYen)}</dd></div>
    <div class="fig-balance"><dt>${term("balance")} <span class="formula">受入額 − 住民税控除額</span></dt><dd>${big(e.primaryBalanceYen, true)}</dd><dd class="badges">${badges(e, (x) => x.primaryBalanceYen, true)}</dd></div>
  </dl>
  <p class="reference">募集費用も引いた${term("reference")} <strong>${signedYen(e.referenceBalanceYen)}</strong>${badges(e, (x) => x.referenceBalanceYen, true)}<span class="formula">受入額 − 募集費用 − 住民税控除額</span></p>
  <p class="note">${esc(meta.excludedAdjustments)}${esc(meta.periodMismatch)}</p>
  ${proxy}`;
}

// ── v2: 人口1人あたり・普通交付税・募集費用の中身・控除を受けた住民 ──

function perCapitaBlock(e: FurusatoEntity): string {
  const note = e.kind === "prefecture" ? "都道府県自身の受入額・控除額を、県の人口で割っています。" : "";
  return `
  <section class="detail">
    <h3>${term("perCapita")}</h3>
    <p class="detail-sub">人口 ${people(e.population)}（令和8年1月1日）${note ? `・${note}` : ""}</p>
    <dl class="mini">
      <div><dt>受入額</dt><dd>${perPersonYen(perCapita(e.receiptAmountYen, e.population))}</dd><dd class="badges">${badges(e, (x) => perCapita(x.receiptAmountYen, x.population))}</dd></div>
      <div><dt>住民税控除額</dt><dd>${perPersonYen(perCapita(e.residentTaxDeductionYen, e.population))}</dd><dd class="badges">${badges(e, (x) => perCapita(x.residentTaxDeductionYen, x.population))}</dd></div>
      <div><dt>差額</dt><dd>${perPersonYen(perCapita(e.primaryBalanceYen, e.population), true)}</dd><dd class="badges">${badges(e, (x) => perCapita(x.primaryBalanceYen, x.population), true)}</dd></div>
    </dl>
  </section>`;
}

const GRANT_LABEL: Record<FurusatoEntity["ordinaryGrantStatus"], [string, string]> = {
  receiving: ["交付を受けている", "住民税が減ると、その一部が普通交付税の計算で補われる仕組みがあります（このサイトの差額には含めていません）。"],
  non_receiving: ["交付を受けていない（不交付）", "住民税が減っても、普通交付税による補填の対象外です。"],
  tokyo_special_ward: ["東京都と合わせて計算（特別区）", "東京23区は東京都と合わせて計算され、東京都は不交付のため、普通交付税による補填の対象外です。"],
  unknown: ["確認できていない", "公表資料で状態を確認できませんでした。"],
};

function grantBlock(e: FurusatoEntity): string {
  const [label, note] = GRANT_LABEL[e.ordinaryGrantStatus];
  return `
  <section class="detail">
    <h3>${term("ordinaryGrant")}</h3>
    <p class="detail-value">${esc(label)}</p>
    <p class="note">${esc(note)}</p>
  </section>`;
}

const COST_ITEMS: [keyof FurusatoEntity["solicitationCostBreakdown"], string][] = [
  ["procurementYen", "返礼品の調達"],
  ["shippingYen", "送付"],
  ["advertisingYen", "広報"],
  ["settlementYen", "決済"],
  ["administrationYen", "事務"],
  ["otherYen", "その他"],
];
const COST_COLORS = ["#1d5fd6", "#5686e0", "#8db1ee", "#7a8190", "#a9b0bd", "#d3d8e0"];

function costBlock(e: FurusatoEntity): string {
  const b = e.solicitationCostBreakdown;
  const parts = COST_ITEMS.map(([k]) => b[k]);
  const known = parts.filter((v): v is number => v !== null);
  const sum = known.reduce((a, v) => a + v, 0);
  const bar =
    known.length && sum > 0
      ? `<div class="stack" role="img" aria-label="募集費用の内訳">${COST_ITEMS.map(([k, label], i) => {
          const v = b[k];
          return v && v > 0 ? `<span style="width:${((v / sum) * 100).toFixed(3)}%;background:${COST_COLORS[i]}" title="${label} ${yen(v)}"></span>` : "";
        }).join("")}</div>`
      : "";
  const items = COST_ITEMS.map(
    ([k, label], i) =>
      `<li><span class="sw" style="background:${COST_COLORS[i]}"></span>${label}<span class="amt">${yen(b[k])}<small>${percent(divide(b[k], e.receiptAmountYen))}</small></span></li>`,
  ).join("");
  const blanks = parts.some((v) => v === null) || COST_ITEMS.some(([k]) => e.portalCostBreakdown[k] === null)
    ? `<p class="note">元の表で空欄の項目があります（「—」）。空欄は0とみなさず、そのまま表示しています。</p>`
    : "";
  const offByRounding =
    known.length === COST_ITEMS.length && e.solicitationCostYen !== null && sum !== e.solicitationCostYen
      ? `<p class="note">内訳は1円単位に丸めているため、合計と${Math.abs(sum - e.solicitationCostYen).toLocaleString("ja-JP")}円ずれています。</p>`
      : "";
  return `
  <section class="detail detail-wide">
    <h3>${term("cost", "募集費用の中身")}</h3>
    <p class="detail-sub">募集費用 ${yen(e.solicitationCostYen)}＝受入額の <strong>${percent(divide(e.solicitationCostYen, e.receiptAmountYen))}</strong>（右の%は受入額に対する割合）</p>
    ${bar}
    <ul class="cost-list">${items}</ul>
    ${offByRounding}${blanks}
    <p class="portal">${term("portal")} <strong>${yen(e.portalCostYen)}</strong>（受入額の ${percent(divide(e.portalCostYen, e.receiptAmountYen))}）${badges(e, (x) => x.portalCostYen)}</p>
  </section>`;
}

function usersBlock(e: FurusatoEntity): string {
  const avg = divide(e.deductionDonationAmountYen, e.deductionUserCount);
  const share = divide(e.deductionUserCount, e.population);
  const note = e.kind === "prefecture" ? "県内の市区町村の合計です。" : "";
  return `
  <section class="detail">
    <h3>${term("deductionUsers", "ふるさと納税の控除を受けた住民")}</h3>
    <p class="detail-value">${people(e.deductionUserCount)}<small>（人口の ${percent(share)}）</small></p>
    <p class="badges">${badges(e, (x) => x.deductionUserCount)}</p>
    <p class="detail-sub">1人あたり寄附金額 ${perPersonYen(avg)}${note ? `・${note}` : ""}</p>
  </section>`;
}

// ── 上位10位以内の順位 ──

const TOP = 10;

/**
 * 同じ区分の中で上位10位以内なら「全国3位」のような小さな印を返す（無ければ空）。
 * signed（差額のようにプラスとマイナスがある値）は、下からの順位も見て「全国 下から3位」と書く。
 */
function badges(e: FurusatoEntity, value: (x: FurusatoEntity) => number | null, signed = false): string {
  const scope = e.kind === "prefecture" ? "47都道府県で" : "全国";
  const out: string[] = [];
  const desc = rankAmong(state.data.entities, e, value, "desc");
  if (desc !== undefined && desc <= TOP && (!signed || (value(e) ?? 0) > 0)) out.push(`${scope}${desc}位`);
  if (signed) {
    const asc = rankAmong(state.data.entities, e, value, "asc");
    if (asc !== undefined && asc <= TOP && (value(e) ?? 0) < 0) out.push(`${e.kind === "prefecture" ? "47都道府県で" : "全国で"}下から${asc}位`);
  }
  return out.map((t) => `<span class="rank-badge${t.includes("下から") ? " is-minus" : ""}">${t}</span>`).join("");
}

function big(v: number | null, signed = false): string {
  const s = signed ? signedYen(v) : yen(v);
  // 「126億4,498万円」の単位を小さく見せる
  return s.replace(/([億万]?円|億)/g, '<span class="unit">$1</span>');
}

// ── 推移グラフ ──

function chart(history: ReceiptHistoryPoint[] | null): string {
  if (!history) return `<p class="note">この自治体は、過去の受入額との対応が確かめられないため、推移を表示していません。</p>`;
  // 画面の幅に合わせて描き、文字が縮まないようにする
  const W = Math.min(1136, Math.max(300, app.clientWidth - 2));
  const narrow = W < 600;
  const H = narrow ? 160 : 220;
  const L = narrow ? 44 : 64;
  const R = narrow ? 36 : 48;
  const T = 16;
  const g = chartGeometry(history, W - L - R, H);
  const step = history.length > 1 ? (W - L - R) / (history.length - 1) : 0;
  const grid = g.ticks
    .map((t) => {
      const y = T + (g.max === 0 ? H : H - (t / g.max) * H);
      return `<line class="grid" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text class="tick" x="${L - 8}" y="${y + 4}" text-anchor="end">${axisYen(t)}</text>`;
    })
    .join("");
  const labelYears = new Set(narrow ? [2008, 2016, 2025] : [2008, 2012, 2016, 2020, 2025]);
  const xs = history
    .map((p, i) =>
      labelYears.has(p.fiscalYear)
        ? `<text class="tick" x="${L + i * step}" y="${T + H + 22}" text-anchor="middle">${narrow ? shortYear(p.fiscalYear) : fiscalYearLabel(p.fiscalYear)}</text>`
        : "",
    )
    .join("");
  const lines = g.segments
    .map((seg) => `<polyline class="line" points="${seg.map((p) => `${L + p.x},${T + p.y}`).join(" ")}"/>`)
    .join("");
  const dots = history
    .map((p, i) => {
      if (p.receiptAmountYen === null) return "";
      const y = T + (g.max === 0 ? H : H - (p.receiptAmountYen / g.max) * H);
      return `<circle class="dot" cx="${L + i * step}" cy="${y}" r="${i === history.length - 1 ? 5 : 3}"><title>${fiscalYearLabel(p.fiscalYear)} ${yen(p.receiptAmountYen)}</title></circle>`;
    })
    .join("");
  const last = history[history.length - 1];
  return `
  <figure class="chart">
    <svg viewBox="0 0 ${W} ${H + T + 34}" role="img" aria-label="受入額の推移（平成20年度〜令和7年度）">${grid}${xs}${lines}${dots}</svg>
    <figcaption>令和7年度 ${yen(last.receiptAmountYen)}。点に触れると各年度の額が出ます。</figcaption>
  </figure>`;
}

const shortYear = (y: number) => fiscalYearLabel(y).replace("平成", "H").replace("令和", "R").replace("年度", "");

// ── 並べ替え表 ──

function rankingSection(opts: { highlight?: FurusatoEntity; pref?: string; prefPage?: FurusatoEntity }): string {
  // 都道府県のページ: 最初は県内の市区町村、切り替えると47都道府県（その都道府県を強調）
  if (opts.prefPage) {
    opts = state.prefScope === "local" ? { pref: opts.prefPage.name, prefPage: opts.prefPage } : { highlight: opts.prefPage, prefPage: opts.prefPage };
  }
  const kind = opts.prefPage ? (state.prefScope === "local" ? "municipality" : "prefecture") : opts.pref ? "municipality" : state.kind;
  const title = opts.pref ? `${opts.pref}の市区町村` : kind === "prefecture" ? "都道府県の一覧" : "全国の市区町村";
  const rows = ranking(state.data.entities, kind, state.metric, state.order, opts.pref, state.mode);
  const total = rows.length;
  // 都道府県の表は47行しかないので全部出す（自分の都道府県の行がいつも見えるように）
  const visible = kind === "prefecture" ? rows : rows.slice(0, state.shown);
  const mine = opts.highlight && opts.highlight.kind === kind ? rankOf(ranking(state.data.entities, opts.highlight.kind, state.metric, state.order, undefined, state.mode), opts.highlight.code) : undefined;
  const per = state.mode === "perCapita" ? "（1人あたり）" : "";
  const metricName = (state.metric === "primaryBalanceYen" ? "差額" : "参考差額") + per;
  const position =
    opts.highlight && mine
      ? `<p class="position">${esc(opts.highlight.name)}は、${opts.highlight.kind === "prefecture" ? "47都道府県" : "全国の市区町村"}のうち${metricName}が${state.order === "desc" ? "大きい" : "小さい"}順で <strong>${mine.rank.toLocaleString("ja-JP")}位</strong> です。</p>`
      : "";
  const kindTabs = opts.prefPage
    ? `<div class="seg" role="group" aria-label="範囲">
        ${seg("prefscope", "local", "県内の市区町村", state.prefScope)}${seg("prefscope", "prefs", "47都道府県", state.prefScope)}
      </div>`
    : opts.pref
      ? ""
      : `<div class="seg" role="group" aria-label="区分">
        ${seg("kind", "municipality", "市区町村", state.kind)}${seg("kind", "prefecture", "都道府県", state.kind)}
      </div>`;
  const body = visible
    .map(
      (r) => `<tr${r.entity.code === opts.highlight?.code ? ' class="is-mine"' : ""}>
        <td class="num rank">${r.rank.toLocaleString("ja-JP")}</td>
        <td>${r.entity.kind === "municipality" ? `<a class="t-pref" href="${toHash({ pref: r.entity.prefName })}" title="${esc(r.entity.prefName)}の市区町村の一覧へ">${esc(r.entity.prefName)}</a>` : ""}<a href="${toHash({ code: r.entity.code })}">${esc(r.entity.name)}</a></td>
        <td class="num col-opt2">${amount(r.entity, r.entity.receiptAmountYen)}</td>
        <td class="num col-opt">${amount(r.entity, r.entity.solicitationCostYen)}</td>
        <td class="num col-opt">${amount(r.entity, r.entity.residentTaxDeductionYen)}</td>
        <td class="num strong">${state.mode === "perCapita" ? perPersonYen(r.value, true) : signedYen(r.value)}</td>
      </tr>`,
    )
    .join("");
  const more =
    total > visible.length
      ? `<button type="button" class="btn-more" data-more>続きを表示（${visible.length.toLocaleString("ja-JP")} / ${total.toLocaleString("ja-JP")}）</button>`
      : "";
  return `
  <section class="section" id="ranking">
    <div class="section-head">
      <h2>${esc(title)}</h2>
      <div class="controls">
        ${kindTabs}
        ${modeButtons()}
        <div class="seg" role="group" aria-label="並べ替える値">
          ${seg("metric", "primaryBalanceYen", "差額", state.metric)}${seg("metric", "referenceBalanceYen", "参考差額", state.metric)}
        </div>
        <div class="seg" role="group" aria-label="並び順">
          ${seg("order", "desc", "大きい順", state.order)}${seg("order", "asc", "小さい順", state.order)}
        </div>
      </div>
    </div>
    ${position}
    <div class="table-wrap">
      <table class="rank-table">
        <thead><tr>
          <th class="num">${term("rank")}</th><th>自治体</th><th class="num col-opt2">${term("receipt", "受入額" + per)}</th>
          <th class="num col-opt">${term("cost", "募集費用" + per)}</th><th class="num col-opt">${term(kind === "prefecture" ? "deductionPref" : "deduction", "住民税控除額" + per)}</th><th class="num">${term(state.metric === "primaryBalanceYen" ? "balance" : "reference", metricName)}</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${more}
  </section>`;
}

/** 「総額／人口1人あたり」の切り替え。地図と表で同じ状態を使う */
function modeButtons(): string {
  return `<div class="seg" role="group" aria-label="総額か人口1人あたりか">${seg("mode", "total", "総額", state.mode)}${seg("mode", "perCapita", "1人あたり", state.mode)}</div>`;
}

/** 表の金額の列。「1人あたり」のときは人口で割る（地図・差額の列と同じ尺度にする） */
function amount(e: FurusatoEntity, v: number | null): string {
  return state.mode === "perCapita" ? perPersonYen(perCapita(v, e.population)) : yen(v);
}

function seg(name: string, value: string, label: string, current: string): string {
  return `<button type="button" data-${name}="${value}" aria-pressed="${value === current}">${label}</button>`;
}

function bindRanking(rerender: () => void) {
  app.querySelectorAll<HTMLButtonElement>("[data-kind],[data-metric],[data-order],[data-prefscope]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.kind) state.kind = b.dataset.kind as EntityKind;
      if (b.dataset.prefscope) state.prefScope = b.dataset.prefscope as PrefScope;
      if (b.dataset.metric) state.metric = b.dataset.metric as Metric;
      if (b.dataset.order) state.order = b.dataset.order as Order;
      state.shown = PAGE;
      rerender();
    }),
  );
  app.querySelector<HTMLButtonElement>("[data-more]")?.addEventListener("click", () => {
    state.shown += PAGE;
    rerender();
  });
}

// ── 地図 ──

function mapSection(title: string, body: string): string {
  return `
  <section class="section"${title === "都道府県から探す" ? ' id="map"' : ""}>
    <div class="section-head"><h2>${esc(title)}</h2><div class="controls">${modeButtons()}${metricButtons(state.mapMetric)}</div></div>
    ${body}
  </section>`;
}

function bindMaps(rerender: () => void) {
  app.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      state.mode = b.dataset.mode as Mode;
      state.shown = PAGE;
      rerender();
    }),
  );
  app.querySelectorAll<HTMLButtonElement>("[data-mapmetric]").forEach((b) =>
    b.addEventListener("click", () => {
      state.mapMetric = b.dataset.mapmetric as MapMetric;
      rerender();
    }),
  );
  app.querySelectorAll<HTMLSelectElement>("[data-pref-select]").forEach((sel) =>
    sel.addEventListener("change", () => {
      if (sel.value) location.hash = toHash({ pref: sel.value });
    }),
  );
  const holder = app.querySelector<HTMLElement>("[data-prefmap]");
  if (holder) void fillPrefMap(holder, holder.dataset.prefmap!, state.data.entities, state.mapMetric, state.mode);
}

// ── データについて ──

function about(): string {
  const m = state.data.metadata;
  return `
  <section class="section about" id="about">
    <h2>データについて</h2>
    <div class="about-grid">
      <div>
        <h3>数字の出どころ</h3>
        <p>総務省「ふるさと納税に関する現況調査結果」（2026年7月31日公表）のExcel 3本です。</p>
        <ul class="sources">
          <li><a href="${esc(m.sources.receipts.url)}">各団体の受入額（${esc(m.periods.receipts)}）</a></li>
          <li><a href="${esc(m.sources.history.url)}">各団体の受入額の推移（${esc(m.periods.history)}）</a></li>
          <li><a href="${esc(m.sources.deductions.url)}">住民税控除額（${esc(m.periods.deductions)}）</a></li>
        </ul>
        <p>人口と普通交付税は、次の資料を使っています。</p>
        <ul class="sources">
          <li><a href="${esc(m.sources.population.url)}">人口（${esc(m.periods.population)}・e-Stat）</a></li>
          <li><a href="${esc(m.sources.ordinaryGrant.url)}">普通交付税の決定額（${esc(m.periods.ordinaryGrant)}・総務省）</a></li>
          <li><a href="${esc(m.sources.ordinaryGrantSummary.url)}">普通交付税大綱（総務省）</a></li>
        </ul>
      </div>
      <div>
        <h3>計算のしかた</h3>
        <p>差額は「受入額 − 住民税控除額」、参考差額は「受入額 − 募集費用 − 住民税控除額」です。市区町村は市町村民税の控除額、都道府県はその県内の道府県民税の控除額の合計を使います。</p>
        <p>${esc(m.notes.periodMismatch)}${esc(m.notes.excludedAdjustments)}地方交付税で減収の一部が補われる自治体もありますが、ここでは計算に入れていません。</p>
        <p>控除額は推計値を含む小数を1円単位に四捨五入してから合計しています。全国と都道府県別の合計は、総務省の報道資料の値と一致することを確かめています。</p>
        <p>地図は、国土地理院「地球地図日本」（2016年）を、jpn-atlas（Copyright (c) 2018, Dan Henri・<a href="./licenses/jpn-atlas-LICENSE.txt">BSD 3-Clause License</a>）経由で加工し、形を大まかにしたものです。沖縄県は石川県の西の点線の枠に拡大して置き、本土から離れた島は地図の外に名前で並べています。地図の色は、各段に同じくらいの数の自治体が入るように分けています。</p>
      </div>
    </div>
  </section>`;
}

// ── 都道府県のページ ──

type PrefTab = "pref" | "munis";

/**
 * 都道府県のページ。どちらのタブでも同じ意味の情報（人口・控除を受けた住民＝県内全体）は上に共通で置き、
 * 都道府県自身についての情報（受入・控除・普通交付税など）は左のタブ（既定）に置く。
 * 「県への寄附と県民税の控除」（県自身）と「市区町村ごとの色分け地図」をタブで切り替える。選ぶ物は既定を左に揃える。
 */
function prefPage(pref: FurusatoEntity, tab: PrefTab) {
  document.title = `${pref.name}のふるさと納税の収支 | ふるさと納税マップ`;
  const suffix = pref.name.slice(-1); // 都・道・府・県
  const tabBtn = (t: PrefTab, label: string) =>
    `<button type="button" role="tab" id="tab-${t}" aria-controls="panel-${t}" aria-selected="${t === tab}" tabindex="${t === tab ? 0 : -1}" data-preftab="${t}">${label}</button>`;
  const panel =
    tab === "munis"
      ? mapSection(`${pref.name}の市区町村の地図`, `<div data-prefmap="${esc(pref.name)}"><p class="note">地図を読み込んでいます…</p></div>`)
      : `<p class="note">${esc(pref.name)}という自治体そのものへの寄附（受入額）と、${suffix}内の住民による${suffix}民税（道府県民税）の控除額です。市区町村への寄附は含みません。</p>
        ${figuresTop(pref)}
        <div class="details">${perCapitaBlock(pref)}${grantBlock(pref)}${costBlock(pref)}</div>
        <section class="section"><h2>${term("history")}</h2>${chart(pref.history)}</section>`;
  app.innerHTML = `
    <div class="top-search">${searchBox(false)}</div>
    <nav class="crumbs" aria-label="現在地"><a href="#">全国</a> / <span>${esc(pref.name)}</span></nav>
    <div class="title-row">
      <h1 class="entity-name">${esc(pref.name)}</h1>
      <button type="button" class="btn-link" data-copy>このページのURLをコピー</button>
    </div>
    <p class="hint">点線の下線がある言葉に触れると、意味と数字の見方が出ます。</p>
    <div class="details details-common">
      <section class="detail">
        <h3>人口</h3>
        <p class="detail-value">${people(pref.population)}</p>
        <p class="detail-sub">令和8年1月1日</p>
      </section>
      ${usersBlock(pref)}
    </div>
    <div class="tabs" role="tablist" aria-label="${esc(pref.name)}の見方">
      ${tabBtn("pref", `${suffix}への寄附と${suffix}民税の控除`)}${tabBtn("munis", "市区町村ごとの色分け地図")}
    </div>
    <div class="tab-panel" role="tabpanel" id="panel-${tab}" aria-labelledby="tab-${tab}">
      ${panel}
    </div>
    ${rankingSection({ prefPage: pref })}
    ${mapSection("ほかの都道府県", nationalMap(state.data.entities, state.mapMetric, state.mode, pref.name))}
    ${about()}`;
}

/** タブを押したら URL も切り替える（共有・再読込で同じタブが開く）。スクロール位置は保つ */
function bindTabs() {
  const tabs = [...app.querySelectorAll<HTMLButtonElement>("[data-preftab]")];
  const go = (b: HTMLButtonElement) => {
    const prefName = app.querySelector<HTMLElement>(".entity-name")!.textContent!;
    const pref = state.data.entities.find((x) => x.kind === "prefecture" && x.name === prefName)!;
    const hash = toHash({ pref: pref.name, map: b.dataset.preftab === "munis" });
    history.replaceState(null, "", hash);
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
    app.querySelector<HTMLButtonElement>(`[data-preftab="${b.dataset.preftab}"]`)?.focus();
  };
  tabs.forEach((b, i) => {
    b.addEventListener("click", () => go(b));
    // 左右の矢印でタブを移る（タブの一般的な操作）
    b.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
      ev.preventDefault();
      go(tabs[(i + (ev.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]);
    });
  });
}

// ── 画面 ──

function render() {
  const route: Route = parseHash(location.hash);
  const e = route.code ? state.byCode.get(route.code) : undefined;
  const rerender = () => {
    render();
  };
  const prefEntity =
    e?.kind === "prefecture" ? e : route.pref && PREF_NAMES.includes(route.pref) ? state.data.entities.find((x) => x.kind === "prefecture" && x.name === route.pref) : undefined;
  if (prefEntity) {
    prefPage(prefEntity, route.map ? "munis" : "pref");
  } else if (e) {
    document.title = `${fullName(e)}のふるさと納税の収支 | ふるさと納税マップ`;
    app.innerHTML = `
      <div class="top-search">${searchBox(false)}</div>
      <nav class="crumbs" aria-label="現在地"><a href="#">全国</a>${
        e.kind === "municipality" ? ` / <a href="${toHash({ pref: e.prefName })}">${esc(e.prefName)}</a>` : ""
      } / <span>${esc(e.name)}</span></nav>
      <div class="title-row">
        <h1 class="entity-name">${esc(e.name)}${e.kind === "municipality" ? `<span class="entity-pref">${esc(e.prefName)}</span>` : ""}</h1>
        <button type="button" class="btn-link" data-copy>このページのURLをコピー</button>
      </div>
      <p class="hint">点線の下線がある言葉に触れると、意味と数字の見方が出ます。</p>
      ${figures(e)}
      <section class="section"><h2>${term("history")}</h2>${chart(e.history)}</section>
      ${rankingSection({ highlight: e })}
      ${about()}`;
  } else {
    document.title = "ふるさと納税マップ | 自治体ごとの寄附と住民税の収支";
    app.innerHTML = `
      <section class="hero">
        <h1>ふるさと納税を、まちの収支から。</h1>
        <p class="lead">自治体ごとの受入額・募集費用・住民税控除額を、総務省の公表値で確かめられます。</p>
        ${searchBox(true)}
        <p class="quick">よく調べられる自治体 ${QUICK.map((c) => state.byCode.get(c))
          .filter((x): x is FurusatoEntity => !!x)
          .map((x) => `<a href="${toHash({ code: x.code })}">${esc(x.name)}</a>`)
          .join("")}</p>
      </section>
      ${mapSection("都道府県から探す", nationalMap(state.data.entities, state.mapMetric, state.mode))}
      ${rankingSection({})}
      ${about()}`;
  }
  bindSearch();
  bindTabs();
  bindRanking(rerender);
  bindMaps(rerender);
  app.querySelector<HTMLButtonElement>("[data-copy]")?.addEventListener("click", async (ev) => {
    const b = ev.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(location.href);
      b.textContent = "コピーしました";
    } catch {
      b.textContent = "コピーできませんでした";
    }
  });
}

async function main() {
  const res = await fetch("./data/furusato.json");
  const data = (await res.json()) as FurusatoData;
  state = {
    data,
    byCode: new Map(data.entities.map((e) => [e.code, e])),
    kind: "municipality",
    metric: "primaryBalanceYen",
    order: "desc",
    shown: PAGE,
    mapMetric: "receiptAmountYen",
    mode: "total",
    prefScope: "local",
  };
  bindMapLabel();
  footer.innerHTML = `
    <p>出典：「ふるさと納税に関する現況調査結果」（総務省、2026年7月31日公表）（<a href="${SOUMU_PAGE}">${SOUMU_PAGE}</a>）を加工して作成。円単位への換算・丸め・都道府県別の控除額の集計・差額の計算を行っています。</p>
    <p>人口：政府統計の総合窓口（e-Stat）「住民基本台帳に基づく人口、人口動態及び世帯数」市区町村別・総計（令和8年1月1日現在）（<a href="${ESTAT_PAGE}">${ESTAT_PAGE}</a>）を加工して作成。</p>
    <p>普通交付税：「令和8年度 市町村別普通交付税決定額」「令和8年度普通交付税大綱」（総務省）（<a href="${GRANT_PAGE}">${GRANT_PAGE}</a>）を加工して作成（交付・不交付・特別区の分類）。</p>
    <p>地図：「地球地図日本」（国土地理院）（<a href="${GSI_PAGE}">${GSI_PAGE}</a>）を加工して作成。</p>
    <p>このサイトは個人が作成したもので、総務省・国土地理院の公式サイトではなく、両機関とは関係ありません。</p>`;
  // 画面が変わったら、表の区分と範囲を既定（左）に戻し、表示件数を戻す
  const enter = () => {
    state.kind = "municipality";
    state.prefScope = "local";
    state.shown = PAGE;
    render();
  };
  window.addEventListener("hashchange", () => {
    enter();
    const target = pendingScroll && document.getElementById(pendingScroll);
    pendingScroll = null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  });
  enter();
  // エージェント向けのツール（WebMCP）。最初の描画が済んでから登録し、失敗しても画面には影響させない
  const modelContext = (document as Document & { modelContext?: unknown }).modelContext;
  void registerAgentTools(createAgentTools(data, location.href.split("#")[0]), modelContext).then((ac) => import.meta.hot?.dispose(() => ac?.abort()));
  // 幅が変わったら（画面の回転など）グラフを描き直す。入力中の検索欄は消さない
  let width = app.clientWidth;
  let timer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (Math.abs(app.clientWidth - width) < 40 || !app.querySelector(".chart")) return;
      width = app.clientWidth;
      if (document.activeElement?.id !== "q") render();
    }, 200);
  });
}

main().catch(() => {
  app.innerHTML = `<p class="loading">データを読み込めませんでした。ページを再読み込みしてください。</p>`;
});
