// エージェント向けのツール（WebMCP で登録する）。読み取り専用で、画面と同じ計算（logic.ts）を使う。
// 結果は成功 {ok:true, data, metadata}、入力の誤り {ok:false, error}。金額は整数の円、欠測は null のまま返す。
import type { EntityKind, FurusatoData, FurusatoEntity } from "./data-contract";
import { divide, perCapita, ranking, search, toHash, type Mode, type Order, type RankingMetric } from "./logic";

export const TOOLS_VERSION = 1;

const SOURCE_PAGE = "https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/furusato/archive/";

type ErrorCode = "INVALID_ARGUMENT" | "NOT_FOUND";
export type ToolResult =
  | { ok: true; data: unknown; metadata: ToolMetadata }
  | { ok: false; error: { code: ErrorCode; message: string } };

export interface AgentTool {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: true };
  execute(input: unknown): ToolResult;
}

export type ToolMetadata = ReturnType<typeof buildMetadata>;

const KINDS: EntityKind[] = ["municipality", "prefecture"];
const METRICS: RankingMetric[] = ["receiptAmountYen", "residentTaxDeductionYen", "primaryBalanceYen", "referenceBalanceYen"];
const ORDERS: Order[] = ["desc", "asc"];
const MODES: Mode[] = ["total", "perCapita"];

function buildMetadata(data: FurusatoData, siteUrl: string) {
  const m = data.metadata;
  return {
    toolsVersion: TOOLS_VERSION,
    dataSchemaVersion: m.schemaVersion,
    site: "ふるさと納税マップ（個人が作成した非公式のサイトで、総務省・国土地理院とは関係ありません）",
    siteUrl,
    units: {
      money: "円の整数（JPY）",
      perCapita: "円/人（人口で割った値。丸める前の小数）",
      share: "割合（0〜1 の小数。丸める前）",
      count: "件",
      people: "人",
    },
    periods: m.periods,
    formulas: {
      primaryBalanceYen: "受入額 − 住民税控除額",
      referenceBalanceYen: "受入額 − 募集費用 − 住民税控除額",
    },
    notes: [
      m.notes.periodMismatch,
      m.notes.excludedAdjustments,
      "都道府県の値は、都道府県自身への寄附の受入額と、県内の市区町村から集計した道府県民税の控除額です。県内の市区町村への寄附は含みません（地図の県内合計とは別の値です）。",
      "residentTaxDeductionYen は、市区町村では市町村民税、都道府県では道府県民税の控除額です（推計値を含む）。",
      "portalCostYen と portalCostBreakdown は、ポータル事業者への支払額で、募集費用（solicitationCostYen）の内数です。",
      "ordinaryGrantStatus は令和8年度当初の普通交付税の状態です（receiving＝交付、non_receiving＝不交付、tokyo_special_ward＝特別区で都と合算、unknown＝不明）。",
      "deductionUserCount は、その自治体の住民のうちふるさと納税の控除を受けた人数です。他の自治体へ寄附した人数ではなく、控除を利用していない寄附者は含みません。",
      "null は元の表で空欄・欠測であることを表し、0 ではありません。",
    ],
    attribution: `${m.notes.attribution} 出典ページ：${SOURCE_PAGE}`,
    sources: m.sources,
  };
}

const invalid = (message: string): ToolResult => ({ ok: false, error: { code: "INVALID_ARGUMENT", message } });

/** 入力が決めたキーだけを持つオブジェクトか確かめる。誤りなら理由、正しければ null。 */
function checkKeys(input: unknown, allowed: string[], required: string[]): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "入力はオブジェクトにしてください。";
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  if (extra.length) return `使えないキーがあります: ${extra.join(", ")}`;
  const missing = required.filter((k) => !(k in input));
  if (missing.length) return `必要なキーがありません: ${missing.join(", ")}`;
  return null;
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** 3つのツールを作る。siteUrl はサイトの URL（hash なし）で、各結果に付けるページの URL の基準にする。 */
export function createAgentTools(data: FurusatoData, siteUrl: string): AgentTool[] {
  const metadata = buildMetadata(data, siteUrl);
  const byCode = new Map(data.entities.map((e) => [e.code, e]));
  const prefNames = data.entities.filter((e) => e.kind === "prefecture").map((e) => e.name);
  const url = (e: FurusatoEntity) => `${siteUrl}${toHash({ code: e.code })}`;
  const brief = (e: FurusatoEntity) => ({ code: e.code, kind: e.kind, name: e.name, prefName: e.prefName, url: url(e) });
  const ok = (d: unknown): ToolResult => ({ ok: true, data: d, metadata });

  const searchTool: AgentTool = {
    name: "furusato_search_entities",
    title: "自治体を名前で探す",
    description:
      "都道府県・市区町村を名前で探し、6桁の団体コード（code）を返します。「世田谷」「世田谷区」「東京都世田谷区」のどれでも探せます。詳しい数値は furusato_get_entity に code を渡して取ります。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 100, description: "自治体の名前（一部でもよい）" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 12, description: "返す件数の上限" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute(input) {
      const bad = checkKeys(input, ["query", "limit"], ["query"]);
      if (bad) return invalid(bad);
      const { query, limit = 12 } = input as { query: unknown; limit?: unknown };
      if (typeof query !== "string" || !query.trim() || query.length > 100) return invalid("query は1〜100字の文字列にしてください。");
      if (!isInt(limit, 1, 50)) return invalid("limit は1〜50の整数にしてください。");
      const hits = search(data.entities, query, limit);
      return ok({ query, count: hits.length, results: hits.map(brief) });
    },
  };

  const getTool: AgentTool = {
    name: "furusato_get_entity",
    title: "自治体のふるさと納税の数値を取る",
    description:
      "6桁の団体コードで、受入額・募集費用（内訳とポータル事業者への支払額）・住民税控除額・差額・人口・普通交付税の状態・控除を受けた住民・受入額の推移を返します。金額は円の整数で、欠測は null です。差額は地方交付税・所得税控除を含まず、損益ではありません。",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", pattern: "^[0-9]{6}$", description: "6桁の団体コード（先頭の0を含む）" } },
      required: ["code"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute(input) {
      const bad = checkKeys(input, ["code"], ["code"]);
      if (bad) return invalid(bad);
      const { code } = input as { code: unknown };
      if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) return invalid("code は6桁の数字の文字列にしてください。");
      const e = byCode.get(code);
      if (!e) return { ok: false, error: { code: "NOT_FOUND", message: `団体コード ${code} は見つかりません。` } };
      return ok({
        entity: e,
        derived: {
          perCapita: {
            receiptAmountYen: perCapita(e.receiptAmountYen, e.population),
            residentTaxDeductionYen: perCapita(e.residentTaxDeductionYen, e.population),
            primaryBalanceYen: perCapita(e.primaryBalanceYen, e.population),
            referenceBalanceYen: perCapita(e.referenceBalanceYen, e.population),
          },
          solicitationCostShareOfReceipt: divide(e.solicitationCostYen, e.receiptAmountYen),
          deductionUserShareOfPopulation: divide(e.deductionUserCount, e.population),
          averageDonationPerDeductionUserYen: divide(e.deductionDonationAmountYen, e.deductionUserCount),
        },
        url: url(e),
      });
    },
  };

  const rankingTool: AgentTool = {
    name: "furusato_get_ranking",
    title: "ふるさと納税の順位を取る",
    description:
      "市区町村どうし、または都道府県どうしの順位を返します。指標は受入額（receiptAmountYen）・住民税控除額（residentTaxDeductionYen）・差額（primaryBalanceYen）・参考差額（referenceBalanceYen）で、総額（total）か人口1人あたり（perCapita）を選べます。値が null の自治体は順位に入れず、同じ値は同じ順位です。prefName を付けると、その都道府県の市区町村だけで順位を付けます（kind が municipality のときだけ）。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KINDS, description: "municipality＝市区町村、prefecture＝都道府県" },
        metric: { type: "string", enum: METRICS },
        order: { type: "string", enum: ORDERS, description: "desc＝大きい順、asc＝小さい順" },
        mode: { type: "string", enum: MODES, description: "total＝総額、perCapita＝人口1人あたり" },
        prefName: { type: "string", enum: prefNames, description: "都道府県名（例: 東京都）。kind が municipality のときだけ" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      },
      required: ["kind", "metric", "order", "mode"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute(input) {
      const bad = checkKeys(input, ["kind", "metric", "order", "mode", "prefName", "limit"], ["kind", "metric", "order", "mode"]);
      if (bad) return invalid(bad);
      const { kind, metric, order, mode, prefName, limit = 10 } = input as Record<string, unknown>;
      if (!oneOf(kind, KINDS)) return invalid(`kind は ${KINDS.join(" / ")} のどれかにしてください。`);
      if (!oneOf(metric, METRICS)) return invalid(`metric は ${METRICS.join(" / ")} のどれかにしてください。`);
      if (!oneOf(order, ORDERS)) return invalid(`order は ${ORDERS.join(" / ")} のどれかにしてください。`);
      if (!oneOf(mode, MODES)) return invalid(`mode は ${MODES.join(" / ")} のどれかにしてください。`);
      if (prefName !== undefined) {
        if (!oneOf(prefName, prefNames)) return invalid("prefName は47都道府県の正式な名前（例: 東京都）にしてください。");
        if (kind === "prefecture") return invalid("prefName は kind が municipality のときだけ使えます。");
      }
      if (!isInt(limit, 1, 100)) return invalid("limit は1〜100の整数にしてください。");
      const rows = ranking(data.entities, kind, metric, order, prefName, mode);
      const universe = data.entities.filter((e) => e.kind === kind && (!prefName || e.prefName === prefName)).length;
      return ok({
        conditions: { kind, metric, order, mode, prefName: prefName ?? null, limit },
        rankedCount: rows.length,
        excludedNullCount: universe - rows.length,
        rows: rows.slice(0, limit).map((r) => ({ rank: r.rank, ...brief(r.entity), value: r.value })),
      });
    },
  };

  return [searchTool, getTool, rankingTool];
}
