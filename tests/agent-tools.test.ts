import { describe, expect, it, vi } from "vitest";
import type { FurusatoData } from "../src/data-contract";
import rawData from "../public/data/furusato.json";
import { createAgentTools, type AgentTool, type ToolResult } from "../src/agent-tools";
import { ranking, valueOf, type RankingMetric } from "../src/logic";
import { registerAgentTools } from "../src/webmcp";

const data = rawData as FurusatoData;
const SITE = "https://tenkaku-ux.github.io/furusato-map/";
const tools = createAgentTools(data, SITE);
const tool = (name: string) => tools.find((t) => t.name === name)!;
const run = (name: string, input: unknown) => tool(name).execute(input);
const okData = (r: ToolResult) => {
  if (!r.ok) throw new Error(`ok:false ${r.error.code} ${r.error.message}`);
  return r.data as any;
};
const errCode = (r: ToolResult) => (r.ok ? "ok" : r.error.code);
const byCode = new Map(data.entities.map((e) => [e.code, e]));

describe("エージェント向けのツール", () => {
  it("3つとも読み取り専用で、名前は仕様の文字の範囲に収まる", () => {
    expect(tools.map((t) => t.name)).toEqual(["furusato_search_entities", "furusato_get_entity", "furusato_get_ranking"]);
    for (const t of tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("検索: 名前から団体コードと URL が返る", () => {
    const d = okData(run("furusato_search_entities", { query: "泉佐野" }));
    expect(d.results[0]).toEqual({ code: "272132", kind: "municipality", name: "泉佐野市", prefName: "大阪府", url: `${SITE}#272132` });
    expect(okData(run("furusato_search_entities", { query: "東京都", limit: 1 })).results).toHaveLength(1);
  });

  it("検索: 入力の誤りは INVALID_ARGUMENT（丸めや読み替えをしない）", () => {
    for (const input of [{}, { query: "" }, { query: "   " }, { query: 1 }, { query: "a".repeat(101) }, { query: "泉", limit: 0 }, { query: "泉", limit: 51 }, { query: "泉", limit: 1.5 }, { query: "泉", extra: 1 }, null, [], "泉佐野"]) {
      expect(errCode(run("furusato_search_entities", input))).toBe("INVALID_ARGUMENT");
    }
  });

  it("取得: 代表団体の値が JSON と一致し、欠測は null のまま", () => {
    for (const code of ["272132", "141003", "130001", "133621"]) {
      const d = okData(run("furusato_get_entity", { code }));
      expect(d.entity).toEqual(byCode.get(code));
      expect(d.url).toBe(`${SITE}#${code}`);
    }
    const toshima = okData(run("furusato_get_entity", { code: "133621" }));
    expect(toshima.entity.solicitationCostBreakdown.advertisingYen).toBeNull();
    const izumisano = okData(run("furusato_get_entity", { code: "272132" }));
    expect(izumisano.entity.receiptAmountYen).toBe(23038604299);
    expect(izumisano.derived.perCapita.receiptAmountYen).toBeCloseTo(23038604299 / izumisano.entity.population, 6);
    expect(izumisano.derived.solicitationCostShareOfReceipt).toBeCloseTo(izumisano.entity.solicitationCostYen / 23038604299, 9);
  });

  it("取得: 6桁の数字以外は INVALID_ARGUMENT、無いコードは NOT_FOUND", () => {
    for (const input of [{}, { code: 272132 }, { code: "27213" }, { code: "2721320" }, { code: "27213a" }, { code: "272132", x: 1 }]) {
      expect(errCode(run("furusato_get_entity", input))).toBe("INVALID_ARGUMENT");
    }
    expect(errCode(run("furusato_get_entity", { code: "999999" }))).toBe("NOT_FOUND");
  });

  it("順位: 4指標×総額/1人あたり×大きい順/小さい順で、画面と同じ順位（null 除外・同順位・コード順）", () => {
    const metrics: RankingMetric[] = ["receiptAmountYen", "residentTaxDeductionYen", "primaryBalanceYen", "referenceBalanceYen"];
    for (const kind of ["municipality", "prefecture"] as const)
      for (const metric of metrics)
        for (const mode of ["total", "perCapita"] as const)
          for (const order of ["desc", "asc"] as const) {
            const d = okData(run("furusato_get_ranking", { kind, metric, order, mode, limit: 100 }));
            const expected = ranking(data.entities, kind, metric, order, undefined, mode);
            expect(d.rows.map((r: any) => [r.rank, r.code, r.value])).toEqual(expected.slice(0, 100).map((r) => [r.rank, r.entity.code, r.value]));
            const nulls = data.entities.filter((e) => e.kind === kind && valueOf(e, metric, mode) === null).length;
            expect(d.excludedNullCount).toBe(nulls);
            expect(d.rankedCount + d.excludedNullCount).toBe(data.entities.filter((e) => e.kind === kind).length);
          }
    const top = okData(run("furusato_get_ranking", { kind: "municipality", metric: "receiptAmountYen", order: "desc", mode: "total" }));
    expect(top.rows).toHaveLength(10);
    expect(top.rows[0]).toMatchObject({ rank: 1, code: "272132", name: "泉佐野市", url: `${SITE}#272132` });
  });

  it("順位: 都道府県で絞ると、その県の市区町村だけ", () => {
    const d = okData(run("furusato_get_ranking", { kind: "municipality", metric: "primaryBalanceYen", order: "asc", mode: "total", prefName: "東京都", limit: 100 }));
    expect(d.rows.every((r: any) => r.prefName === "東京都")).toBe(true);
    expect(d.conditions.prefName).toBe("東京都");
  });

  it("順位: 入力の誤りは INVALID_ARGUMENT", () => {
    const base = { kind: "municipality", metric: "receiptAmountYen", order: "desc", mode: "total" };
    for (const input of [
      {},
      { ...base, kind: "city" },
      { ...base, metric: "solicitationCostYen" },
      { ...base, order: "up" },
      { ...base, mode: "avg" },
      { ...base, prefName: "東京" },
      { ...base, kind: "prefecture", prefName: "東京都" },
      { ...base, limit: 0 },
      { ...base, limit: 101 },
      { ...base, other: true },
    ]) {
      expect(errCode(run("furusato_get_ranking", input))).toBe("INVALID_ARGUMENT");
    }
  });

  it("結果は JSON にしても変わらず（undefined・NaN・Infinity を含まない）、出典と注記が毎回付く", () => {
    const results = [
      run("furusato_search_entities", { query: "世田谷" }),
      run("furusato_get_entity", { code: "130001" }),
      run("furusato_get_entity", { code: "133621" }),
      run("furusato_get_ranking", { kind: "prefecture", metric: "primaryBalanceYen", order: "asc", mode: "perCapita", limit: 47 }),
    ];
    for (const r of results) {
      expect(JSON.parse(JSON.stringify(r))).toEqual(r);
      const text = JSON.stringify(r);
      expect(text).not.toMatch(/NaN|Infinity/);
      if (!r.ok) throw new Error("ok:false");
      expect(r.metadata.toolsVersion).toBe(1);
      expect(r.metadata.dataSchemaVersion).toBe(2);
      expect(Object.keys(r.metadata.sources)).toHaveLength(6);
      expect(r.metadata.attribution).toContain("総務省");
      expect(r.metadata.attribution).toContain("e-Stat");
      expect(r.metadata.site).toContain("非公式");
      expect(r.metadata.notes.join("")).toContain("損益を示すものではありません");
      expect(text).not.toMatch(/お得|得する|損する|損をして|赤字|黒字|儲/);
    }
  });
});

describe("WebMCP への登録", () => {
  const fakeContext = (fail?: (n: number) => "throw" | "reject" | undefined) => {
    const live = new Map<string, any>();
    let n = 0;
    return {
      live,
      registerTool: vi.fn((t: any, opts: { signal: AbortSignal }) => {
        const i = n++;
        const how = fail?.(i);
        if (how === "throw") throw new Error("同期の失敗");
        if (how === "reject") return Promise.reject(new Error("非同期の失敗"));
        live.set(t.name, t);
        opts.signal.addEventListener("abort", () => live.delete(t.name));
        return Promise.resolve();
      }),
    };
  };

  it("対応していなければ何もしない", async () => {
    expect(await registerAgentTools(tools, undefined)).toBeNull();
    expect(await registerAgentTools(tools, {})).toBeNull();
  });

  it("3つを登録し、実行すると結果を返す。abort で全部外れ、そのあとは登録し直せる", async () => {
    const mc = fakeContext();
    const ac = await registerAgentTools(tools, mc);
    expect(ac).not.toBeNull();
    expect([...mc.live.keys()]).toEqual(tools.map((t) => t.name));
    const t = mc.live.get("furusato_get_entity");
    expect(t.annotations.readOnlyHint).toBe(true);
    expect((await t.execute({ code: "272132" }, {})).ok).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    await expect(t.execute({ code: "272132" }, { signal: aborted.signal })).rejects.toThrow();
    expect(await registerAgentTools(tools, mc)).toBeNull(); // 2回目は重複して登録しない
    expect(mc.registerTool).toHaveBeenCalledTimes(3);
    ac!.abort();
    expect(mc.live.size).toBe(0);
    expect(await registerAgentTools(tools, mc)).not.toBeNull();
    expect(mc.live.size).toBe(3);
  });

  it.each(["throw", "reject"] as const)("2つ目で失敗（%s）したら、1つ目も外し、例外を外へ出さない", async (how) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mc = fakeContext((i) => (i === 1 ? how : undefined));
    await expect(registerAgentTools(tools, mc)).resolves.toBeNull();
    expect(mc.live.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("登録した execute は、ツール本体と同じ結果を返す", async () => {
    const mc = fakeContext();
    await registerAgentTools(tools, mc);
    const input = { kind: "municipality", metric: "receiptAmountYen", order: "desc", mode: "total" };
    expect(await mc.live.get("furusato_get_ranking").execute(input, {})).toEqual((tool("furusato_get_ranking") as AgentTool).execute(input));
  });
});
