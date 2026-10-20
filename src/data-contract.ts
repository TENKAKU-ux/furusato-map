// 数値はすべて安全な整数。欠測はnull。範囲・形式・計算式の検証はSchemaとdocs/data.mdに従う。
export type Yen = number | null;
export type EntityKind = "prefecture" | "municipality";
export type OrdinaryGrantStatus = "receiving" | "non_receiving" | "tokyo_special_ward" | "unknown";

export interface SourceMetadata {
  url: string;
  retrievedOn: string; // 元資料の取得日（YYYY-MM-DD）。JSON生成日ではない。
  sha256: string;
}

export interface DataMetadata {
  schemaVersion: 2;
  sources: {
    receipts: SourceMetadata;
    history: SourceMetadata;
    deductions: SourceMetadata;
    population: SourceMetadata;
    ordinaryGrant: SourceMetadata;
    ordinaryGrantSummary: SourceMetadata;
  };
  units: {
    money: "JPY";
    count: "件";
    population: "人";
    taxpayer: "人";
  };
  periods: {
    receipts: string;
    history: string;
    deductions: string;
    population: string;
    ordinaryGrant: string;
  };
  rounding: "ROUND_HALF_UP";
  notes: {
    periodMismatch: string;
    excludedAdjustments: string;
    attribution: string;
  };
}

export interface ReceiptHistoryPoint {
  fiscalYear: number; // 西暦年度。2008～2025を一度ずつ昇順に並べる。
  receiptAmountYen: Yen;
}

export interface CostBreakdown {
  procurementYen: Yen;
  shippingYen: Yen;
  advertisingYen: Yen;
  settlementYen: Yen;
  administrationYen: Yen;
  otherYen: Yen;
}

export interface FurusatoEntity {
  code: string; // チェックディジットを含む6桁。先頭の0を保持する。
  kind: EntityKind;
  prefName: string;
  name: string;
  receiptAmountYen: Yen;
  receiptCount: number | null;
  proxyReceiptAmountYen: Yen;
  solicitationCostYen: Yen;
  // kindで税目を確定: municipality＝市町村民税（BE）、prefecture＝道府県民税（BH集計）。
  residentTaxDeductionYen: Yen;
  primaryBalanceYen: Yen; // 受入額 − 住民税控除額（計算済み）。
  referenceBalanceYen: Yen; // 受入額 − 募集費用合計 − 住民税控除額（計算済み）。
  history: ReceiptHistoryPoint[] | null;
  population: number | null; // 2026-01-01の総計人口。県は県人口。
  ordinaryGrantStatus: OrdinaryGrantStatus; // R8年度当初の普通交付税。未確認はunknown。
  solicitationCostBreakdown: CostBreakdown; // 受入L:Q。元の合計Rは保持する。
  portalCostBreakdown: CostBreakdown; // 受入S:X。募集費用の内数。
  portalCostYen: Yen; // 受入Y。ポータル事業者への支払額合計。
  deductionUserCount: number | null; // 控除BC。県は県内市区町村の和。
  deductionDonationAmountYen: Yen; // 控除BD。県は県内市区町村の和。
}

export interface FurusatoData {
  metadata: DataMetadata;
  entities: FurusatoEntity[];
}
