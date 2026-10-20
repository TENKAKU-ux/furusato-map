// エージェント向けのツール（WebMCP と stdio の MCP サーバーで登録する）。読み取り専用で、画面と同じ計算（logic.ts）を使う。
// 結果は成功 {ok:true, data, metadata}、入力の誤り {ok:false, error}。金額は整数の円、欠測は null のまま返す。
import type { EntityKind, FurusatoData, FurusatoEntity } from "./data-contract";
import { GLOSSARY, type TermKey } from "./glossary";
import { divide, perCapita, ranking, search, toHash, type Mode, type Order, type RankingMetric } from "./logic";

export const TOOLS_VERSION = 2;

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

/** データの識別子。stdio のサーバーは同梱 JSON の SHA256 と自分の版を渡す。ブラウザでは null。 */
export interface DatasetInfo {
  datasetSha256?: string | null;
  serverVersion?: string | null;
}

const TERM_KEYS = Object.keys(GLOSSARY) as TermKey[];

/** 全国計を足す範囲。県の受入・控除は県自身の分なので市区町村と重ならない。人口・控除を受けた住民は県の値が県内の和なので市区町村だけ足す。 */
const NATIONAL_TOTALS = [
  { key: "receiptAmountYen", label: "受入額", scope: "all" },
  { key: "receiptCount", label: "受入件数", scope: "all" },
  { key: "proxyReceiptAmountYen", label: "うち代理受入", scope: "all" },
  { key: "solicitationCostYen", label: "募集費用", scope: "all" },
  { key: "portalCostYen", label: "うちポータル事業者への支払額", scope: "all" },
  { key: "residentTaxDeductionYen", label: "住民税控除額（市町村民税＋道府県民税）", scope: "all" },
  { key: "population", label: "人口", scope: "municipality" },
  { key: "deductionUserCount", label: "控除を受けた住民", scope: "municipality" },
  { key: "deductionDonationAmountYen", label: "控除を受けた住民の寄附額", scope: "municipality" },
] as const;

/** 派生値。get_entity と compare で同じものを返す。 */
function derive(e: FurusatoEntity) {
  return {
    perCapita: {
      receiptAmountYen: perCapita(e.receiptAmountYen, e.population),
      residentTaxDeductionYen: perCapita(e.residentTaxDeductionYen, e.population),
      primaryBalanceYen: perCapita(e.primaryBalanceYen, e.population),
      referenceBalanceYen: perCapita(e.referenceBalanceYen, e.population),
    },
    solicitationCostShareOfReceipt: divide(e.solicitationCostYen, e.receiptAmountYen),
    deductionUserShareOfPopulation: divide(e.deductionUserCount, e.population),
    averageDonationPerDeductionUserYen: divide(e.deductionDonationAmountYen, e.deductionUserCount),
  };
}

/** 7つのツールを作る。siteUrl はサイトの URL（hash なし）で、各結果に付けるページの URL の基準にする。 */
export function createAgentTools(data: FurusatoData, siteUrl: string, dataset: DatasetInfo = {}): AgentTool[] {
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
      return ok({ entity: e, derived: derive(e), url: url(e) });
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

  const counts = {
    prefecture: data.entities.filter((e) => e.kind === "prefecture").length,
    municipality: data.entities.filter((e) => e.kind === "municipality").length,
  };
  const nationalTotals = NATIONAL_TOTALS.map(({ key, label, scope }) => {
    const rows = data.entities.filter((e) => scope === "all" || e.kind === scope);
    const values = rows.map((e) => e[key]);
    return {
      key,
      label,
      value: values.reduce<number>((sum, v) => sum + (v ?? 0), 0),
      missingCount: values.filter((v) => v === null).length,
      summedOver:
        scope === "all"
          ? `都道府県${counts.prefecture}と市区町村${counts.municipality}の計${rows.length}団体`
          : `市区町村${rows.length}団体だけ（都道府県の値は県内の市区町村の合計なので足さない）`,
    };
  });

  const overviewTool: AgentTool = {
    name: "furusato_get_overview",
    title: "サイトとデータの概要を見る",
    description:
      "最初に呼ぶ入口です。サイトの説明、問いに合うツールの選び方、指標の意味と単位、時点、全国計、データの版と注記・出典を返します。入力はありません。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute(input) {
      const bad = checkKeys(input, [], []);
      if (bad) return invalid(bad);
      return ok({
        about:
          "自治体ごとのふるさと納税の受入額・募集費用・住民税控除額などを、総務省などの公表値を加工してまとめたデータです。個人が作成した非公式のもので、総務省・国土地理院とは関係ありません。",
        howToUse: [
          { question: "自治体の団体コードを知りたい（名前しか分からない）", tool: "furusato_search_entities" },
          { question: "ある自治体の数値・推移を詳しく知りたい", tool: "furusato_get_entity" },
          { question: "いくつかの自治体を並べて比べたい", tool: "furusato_compare_entities" },
          { question: "受入額などの多い順・少ない順を知りたい", tool: "furusato_get_ranking" },
          { question: "ある都道府県の市区町村、または全国を全部見たい", tool: "furusato_list_entities" },
          { question: "用語（差額・募集費用・普通交付税など）の意味を知りたい", tool: "furusato_explain_term" },
        ],
        metrics: {
          receiptAmountYen: { label: "受入額", unit: "円", period: "receipts", meaning: GLOSSARY.receipt.what },
          receiptCount: { label: "受入件数", unit: "件", period: "receipts", meaning: "受入額の件数です。" },
          proxyReceiptAmountYen: { label: "うち代理受入", unit: "円", period: "receipts", meaning: GLOSSARY.proxy.what },
          solicitationCostYen: { label: "募集費用", unit: "円", period: "receipts", meaning: GLOSSARY.cost.what },
          portalCostYen: { label: "うちポータル事業者への支払額", unit: "円", period: "receipts", meaning: GLOSSARY.portal.what },
          residentTaxDeductionYen: {
            label: "住民税控除額",
            unit: "円",
            period: "deductions",
            meaning: `市区町村では、${GLOSSARY.deduction.what} 都道府県では、${GLOSSARY.deductionPref.what}`,
          },
          primaryBalanceYen: { label: "差額", unit: "円", period: "receipts と deductions", meaning: GLOSSARY.balance.what },
          referenceBalanceYen: { label: "参考差額", unit: "円", period: "receipts と deductions", meaning: GLOSSARY.reference.what },
          population: { label: "人口", unit: "人", period: "population", meaning: "住民基本台帳人口（日本人と外国人の合計）です。" },
          ordinaryGrantStatus: { label: "普通交付税の状態", unit: null, period: "ordinaryGrant", meaning: GLOSSARY.ordinaryGrant.what },
          deductionUserCount: { label: "控除を受けた住民", unit: "人", period: "deductions", meaning: GLOSSARY.deductionUsers.what },
          deductionDonationAmountYen: { label: "控除を受けた住民の寄附額", unit: "円", period: "deductions", meaning: "控除を受けた住民の寄附の合計です。" },
          history: { label: "受入額の推移", unit: "円", period: "history", meaning: GLOSSARY.history.what },
        },
        counts,
        nationalTotals: {
          note: "受入額は代理受入を含む値で、総務省の公表する全国計と一致します。全国の差額は、期間のずれと地方交付税・所得税の控除を含まないことから誤読されやすいため出していません。missingCount は値が null（欠測）で合計に入れなかった団体の数です。",
          values: nationalTotals,
        },
        dataset: {
          schemaVersion: data.metadata.schemaVersion,
          sha256: dataset.datasetSha256 ?? null,
          serverVersion: dataset.serverVersion ?? null,
          snapshot: "公表資料から作った固定のデータで、自動では更新されません。時点は metadata.periods にあります。",
        },
      });
    },
  };

  const compareTool: AgentTool = {
    name: "furusato_compare_entities",
    title: "自治体を並べて比べる",
    description:
      "2〜10の団体コードで、同じ項目を並べて返します（推移は含みません。推移は furusato_get_entity で取ります）。市区町村と都道府県は値の意味が違うので、同じ区分どうしでだけ比べられます。",
    inputSchema: {
      type: "object",
      properties: {
        codes: {
          type: "array",
          items: { type: "string", pattern: "^[0-9]{6}$" },
          minItems: 2,
          maxItems: 10,
          uniqueItems: true,
          description: "6桁の団体コード（先頭の0を含む）を2〜10個。同じ区分（市区町村どうし、または都道府県どうし）だけ",
        },
      },
      required: ["codes"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute(input) {
      const bad = checkKeys(input, ["codes"], ["codes"]);
      if (bad) return invalid(bad);
      const { codes } = input as { codes: unknown };
      if (!Array.isArray(codes) || codes.length < 2 || codes.length > 10) return invalid("codes は2〜10個の配列にしてください。");
      if (!codes.every((c): c is string => typeof c === "string" && /^[0-9]{6}$/.test(c))) return invalid("codes の要素は6桁の数字の文字列にしてください。");
      if (new Set(codes).size !== codes.length) return invalid("codes に同じコードが重なっています。");
      const missing = codes.filter((c) => !byCode.has(c));
      if (missing.length) return { ok: false, error: { code: "NOT_FOUND", message: `団体コード ${missing.join(", ")} は見つかりません。` } };
      const entities = codes.map((c) => byCode.get(c)!);
      if (new Set(entities.map((e) => e.kind)).size > 1) return invalid("市区町村と都道府県は値の意味が違うので、同じ区分どうしで比べてください。");
      return ok({
        kind: entities[0].kind,
        items: entities.map((e) => {
          const { history: _history, ...rest } = e;
          return { entity: rest, derived: derive(e), url: url(e) };
        }),
      });
    },
  };

  const listTool: AgentTool = {
    name: "furusato_list_entities",
    title: "自治体を一覧で取る",
    description:
      "市区町村または都道府県を団体コード順に、主要な値つきでページに分けて返します。prefName を付けると、その都道府県の市区町村だけです（kind が municipality のときだけ）。続きは nextOffset を offset に渡して取ります。値が null の団体も除かずに返します。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KINDS, description: "municipality＝市区町村、prefecture＝都道府県" },
        prefName: { type: "string", enum: prefNames, description: "都道府県名（例: 北海道）。kind が municipality のときだけ" },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute(input) {
      const bad = checkKeys(input, ["kind", "prefName", "offset", "limit"], ["kind"]);
      if (bad) return invalid(bad);
      const { kind, prefName, offset = 0, limit = 50 } = input as Record<string, unknown>;
      if (!oneOf(kind, KINDS)) return invalid(`kind は ${KINDS.join(" / ")} のどれかにしてください。`);
      if (prefName !== undefined) {
        if (!oneOf(prefName, prefNames)) return invalid("prefName は47都道府県の正式な名前（例: 北海道）にしてください。");
        if (kind === "prefecture") return invalid("prefName は kind が municipality のときだけ使えます。");
      }
      if (!isInt(offset, 0, Number.MAX_SAFE_INTEGER)) return invalid("offset は0以上の整数にしてください。");
      if (!isInt(limit, 1, 100)) return invalid("limit は1〜100の整数にしてください。");
      const all = data.entities
        .filter((e) => e.kind === kind && (!prefName || e.prefName === prefName))
        .sort((a, b) => a.code.localeCompare(b.code));
      const page = all.slice(offset, offset + limit);
      const hasMore = offset + page.length < all.length;
      return ok({
        conditions: { kind, prefName: prefName ?? null, offset, limit },
        total: all.length,
        hasMore,
        nextOffset: hasMore ? offset + page.length : null,
        rows: page.map((e) => ({
          ...brief(e),
          receiptAmountYen: e.receiptAmountYen,
          solicitationCostYen: e.solicitationCostYen,
          residentTaxDeductionYen: e.residentTaxDeductionYen,
          primaryBalanceYen: e.primaryBalanceYen,
          referenceBalanceYen: e.referenceBalanceYen,
          population: e.population,
        })),
      });
    },
  };

  const explainTool: AgentTool = {
    name: "furusato_explain_term",
    title: "用語の意味を見る",
    description:
      "サイトで使う用語（受入額・募集費用・住民税控除額・差額・参考差額・普通交付税など）の意味と見方を返します。term を省くと、使える用語の一覧を返します。",
    inputSchema: {
      type: "object",
      properties: { term: { type: "string", enum: TERM_KEYS, description: "用語の key。省くと一覧" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute(input) {
      const bad = checkKeys(input, ["term"], []);
      if (bad) return invalid(bad);
      const { term } = input as { term?: unknown };
      if (term === undefined) return ok({ terms: TERM_KEYS.map((key) => ({ key, title: GLOSSARY[key].title })) });
      if (!oneOf(term, TERM_KEYS)) return invalid(`term は ${TERM_KEYS.join(" / ")} のどれかにしてください。`);
      return ok({ key: term, ...GLOSSARY[term] });
    },
  };

  return [overviewTool, searchTool, getTool, compareTool, listTool, rankingTool, explainTool];
}
