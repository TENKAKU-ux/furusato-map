import type { EntityKind, FurusatoEntity, ReceiptHistoryPoint } from "./data-contract";

// ── 検索 ──

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/**
 * 団体名で探す。「世田谷」「世田谷区」「東京都世田谷区」のどれでも当たる。
 * 前方一致を先に、同じ強さなら都道府県→団体コード順に並べる。
 */
export function search(entities: FurusatoEntity[], query: string, limit = 12): FurusatoEntity[] {
  const q = norm(query);
  if (!q) return [];
  const scored: { e: FurusatoEntity; score: number }[] = [];
  for (const e of entities) {
    const name = norm(e.name);
    const full = e.kind === "prefecture" ? name : norm(e.prefName) + name;
    let score = -1;
    if (name === q || full === q) score = 0;
    else if (name.startsWith(q) || full.startsWith(q)) score = 1;
    else if (name.includes(q) || full.includes(q)) score = 2;
    if (score >= 0) scored.push({ e, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      Number(b.e.kind === "prefecture") - Number(a.e.kind === "prefecture") ||
      a.e.code.localeCompare(b.e.code),
  );
  return scored.slice(0, limit).map((s) => s.e);
}

// ── 並べ替え表 ──

export type Metric = "primaryBalanceYen" | "referenceBalanceYen";
export type Order = "desc" | "asc";

export interface RankedRow {
  rank: number;
  entity: FurusatoEntity;
  value: number;
}

/**
 * 区分ごとの順位表。都道府県と市区町村は混ぜない。値が null の団体は順位に入れない。
 * 同じ値は同じ順位（1, 2, 2, 4）にし、並びは団体コード順。
 */
export function ranking(
  entities: FurusatoEntity[],
  kind: EntityKind,
  metric: Metric,
  order: Order,
  prefName?: string,
  mode: Mode = "total",
): RankedRow[] {
  const rows = entities
    .filter((e) => e.kind === kind && (!prefName || e.prefName === prefName))
    .flatMap((e) => {
      const v = valueOf(e, metric, mode);
      return v === null ? [] : [{ entity: e, value: v }];
    })
    .sort((a, b) => (order === "desc" ? b.value - a.value : a.value - b.value) || a.entity.code.localeCompare(b.entity.code));
  let rank = 0;
  return rows.map((r, i) => {
    if (i === 0 || r.value !== rows[i - 1].value) rank = i + 1;
    return { rank, ...r };
  });
}

/** 全体の順位表のうち、指定した団体の行。表にいない（null）なら undefined。 */
export function rankOf(rows: RankedRow[], code: string): RankedRow | undefined {
  return rows.find((r) => r.entity.code === code);
}

// ── URL の hash ──

export interface Route {
  code?: string;
  pref?: string;
  /** 都道府県のページで、市区町村の地図のタブを開く */
  map?: boolean;
}

/** 「#131121」で団体、「#pref=東京都」で都道府県、「#pref=東京都&map」でその市区町村の地図のタブ。それ以外は空。 */
export function parseHash(hash: string): Route {
  const h = decodeURIComponent(hash.replace(/^#/, ""));
  if (/^\d{6}$/.test(h)) return { code: h };
  const m = h.match(/^pref=([^&]+)(&map)?$/);
  if (!m) return {};
  return m[2] ? { pref: m[1], map: true } : { pref: m[1] };
}

export function toHash(route: Route): string {
  if (route.code) return `#${route.code}`;
  if (route.pref) return `#pref=${encodeURIComponent(route.pref)}${route.map ? "&map" : ""}`;
  return "";
}

// ── 推移グラフ ──

export interface ChartGeometry {
  /** 線でつなぐ区間。年度ごとの欠測（null）で線を切る。 */
  segments: { x: number; y: number }[][];
  /** 目盛りの値（円） */
  ticks: number[];
  max: number;
}

/** 0 から始まる縦軸で、幅 width・高さ height の中に点を置く。 */
export function chartGeometry(history: ReceiptHistoryPoint[], width: number, height: number): ChartGeometry {
  const values = history.map((p) => p.receiptAmountYen).filter((v): v is number => v !== null);
  const max = niceMax(values.length ? Math.max(...values) : 0);
  const step = history.length > 1 ? width / (history.length - 1) : 0;
  const segments: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  history.forEach((p, i) => {
    if (p.receiptAmountYen === null) {
      if (cur.length) segments.push(cur);
      cur = [];
      return;
    }
    cur.push({ x: i * step, y: max === 0 ? height : height - (p.receiptAmountYen / max) * height });
  });
  if (cur.length) segments.push(cur);
  return { segments, ticks: [0, max / 2, max], max };
}

/** 目盛りの上限を、1・2・5 × 10^n の切りのよい数に上げる。 */
export function niceMax(v: number): number {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// ── 地図の色分け ──

export interface Classes {
  /** 値 → 色の段（0 から）。null は -1 */
  bin: (v: number | null) => number;
  /** 各段に入った値の範囲（円）。値が入らなかった段は null */
  ranges: ([number, number] | null)[];
  diverging: boolean;
}

/** 並べた値を k 段に分けるしきい値。値がしきい値以上なら上の段に入る */
function thresholds(sorted: number[], k: number): number[] {
  return Array.from({ length: k - 1 }, (_, i) => sorted[Math.floor(((i + 1) * sorted.length) / k)]);
}

const level = (v: number, th: number[]) => th.filter((t) => v >= t).length;

/**
 * 値の並びで段を作る（各段に同じくらいの数の自治体が入る）。
 * 金額は多いほど濃い5段。差額は「マイナス3段・プラス3段」に分け、0 を境に色を変える。
 */
export function classify(values: (number | null)[], diverging: boolean): Classes {
  const vs = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  let bin: (v: number | null) => number;
  let count: number;
  if (!diverging) {
    const th = vs.length ? thresholds(vs, 5) : [];
    count = 5;
    bin = (v) => (v === null ? -1 : level(v, th));
  } else {
    // マイナスは絶対値が大きいほど濃く（段 0 がいちばん大きなマイナス）、プラスは大きいほど濃い
    const neg = vs.filter((v) => v < 0);
    const pos = vs.filter((v) => v >= 0);
    const thNeg = neg.length ? thresholds(neg, 3) : [];
    const thPos = pos.length ? thresholds(pos, 3) : [];
    count = 6;
    bin = (v) => (v === null ? -1 : v < 0 ? level(v, thNeg) : 3 + level(v, thPos));
  }
  const ranges: ([number, number] | null)[] = Array.from({ length: count }, () => null);
  for (const v of vs) {
    const b = bin(v);
    const r = ranges[b];
    ranges[b] = r ? [Math.min(r[0], v), Math.max(r[1], v)] : [v, v];
  }
  return { bin, ranges, diverging };
}

// ── 人口1人あたり・平均・割合（画面のどこでもこの関数で計算する） ──

/** 割り算。分子・分母のどちらかが欠測、または分母が0以下なら null。丸めない（順位は丸める前の値で付ける）。 */
export function divide(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

/** 人口1人あたりの額（円・小数のまま） */
export const perCapita = (amountYen: number | null, population: number | null) => divide(amountYen, population);

export type Mode = "total" | "perCapita";

/** 表示・地図・順位に使う値。「総額」ならそのまま、「1人あたり」なら人口で割る。 */
export function valueOf(e: FurusatoEntity, metric: Metric | "receiptAmountYen" | "residentTaxDeductionYen", mode: Mode): number | null {
  return mode === "perCapita" ? perCapita(e[metric], e.population) : e[metric];
}

// ── 自治体のページに出す順位（上位10位以内なら「全国○位」と書く） ──

/**
 * 同じ区分（市区町村どうし／都道府県どうし）の中での順位。値が null の自治体は数えない。
 * 同じ値は同じ順位（自分より厳密に上の数＋1）。対象の値が null なら undefined。
 */
export function rankAmong(
  entities: FurusatoEntity[],
  target: FurusatoEntity,
  value: (e: FurusatoEntity) => number | null,
  order: Order,
): number | undefined {
  const mine = value(target);
  if (mine === null) return undefined;
  let better = 0;
  for (const e of entities) {
    if (e.kind !== target.kind) continue;
    const v = value(e);
    if (v !== null && (order === "desc" ? v > mine : v < mine)) better++;
  }
  return better + 1;
}
