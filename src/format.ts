// 円整数を画面用の文字列にする。計算は必ず円整数のまま済ませ、ここでは表示だけを丸める。

const MAN = 10_000;
const OKU = 100_000_000;

const digits = (n: number) => n.toLocaleString("ja-JP");

/** 「126億4,498万円」の形。1万円の位で四捨五入し、1万円未満の額は「○円」。null は「—」。 */
export function yen(value: number | null): string {
  if (value === null) return "—";
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  if (abs < MAN) return `${sign}${digits(abs)}円`;
  const totalMan = Math.round(abs / MAN); // 先に万の位へ丸めてから億と万に分ける（9,999.5万→1億）
  const oku = Math.floor(totalMan / MAN);
  const man = totalMan % MAN;
  if (oku === 0) return `${sign}${digits(man)}万円`;
  return man === 0 ? `${sign}${digits(oku)}億円` : `${sign}${digits(oku)}億${digits(man)}万円`;
}

/** 差額用。正なら「＋」、負なら「−」を付ける。0 は記号なし。 */
export function signedYen(value: number | null): string {
  if (value === null || value <= 0) return yen(value);
  return `＋${yen(value)}`;
}

/** グラフの目盛り用の短い表記（例: 230億、8,000万、0）。 */
export function axisYen(value: number): string {
  if (value === 0) return "0";
  if (Math.abs(value) >= OKU) return `${digits(Math.round((value / OKU) * 10) / 10)}億`;
  return `${digits(Math.round(value / MAN))}万`;
}

/** 西暦年度を「令和7年度」「平成20年度」の形にする。 */
export function fiscalYearLabel(year: number): string {
  if (year >= 2019) return `令和${year - 2018 === 1 ? "元" : year - 2018}年度`;
  return `平成${year - 1988}年度`;
}

export function count(value: number | null): string {
  return value === null ? "—" : `${digits(value)}件`;
}

/** 1人あたりの額。1円単位に四捨五入して「3万4,567円」ではなく「34,567円」と書く（細かい差が見えるように）。 */
export function perPersonYen(value: number | null, signed = false): string {
  if (value === null) return "—";
  // 絶対値を四捨五入してから符号を戻す（Math.round(-1.5) は -1 になるため）
  const r = Math.round(Math.abs(value));
  const sign = r === 0 ? "" : value < 0 ? "−" : signed ? "＋" : "";
  return `${sign}${r.toLocaleString("ja-JP")}円`;
}

/** 割合を「12.3%」の形にする（小数第1位で四捨五入）。 */
export function percent(ratio: number | null): string {
  return ratio === null ? "—" : `${(Math.round(ratio * 1000) / 10).toLocaleString("ja-JP", { minimumFractionDigits: 1 })}%`;
}

export function people(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("ja-JP")}人`;
}
