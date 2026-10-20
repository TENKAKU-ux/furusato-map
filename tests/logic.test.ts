import { describe, expect, it } from "vitest";
import type { FurusatoEntity } from "../src/data-contract";
import { axisYen, fiscalYearLabel, signedYen, yen } from "../src/format";
import { chartGeometry, niceMax, parseHash, rankOf, ranking, search, toHash } from "../src/logic";

const EMPTY_BREAKDOWN = {
  procurementYen: null,
  shippingYen: null,
  advertisingYen: null,
  settlementYen: null,
  administrationYen: null,
  otherYen: null,
};

function ent(p: Partial<FurusatoEntity> & Pick<FurusatoEntity, "code" | "name">): FurusatoEntity {
  return {
    kind: "municipality",
    prefName: "東京都",
    receiptAmountYen: 0,
    receiptCount: 0,
    proxyReceiptAmountYen: 0,
    solicitationCostYen: 0,
    residentTaxDeductionYen: 0,
    primaryBalanceYen: 0,
    referenceBalanceYen: 0,
    history: null,
    population: null,
    ordinaryGrantStatus: "unknown",
    solicitationCostBreakdown: { ...EMPTY_BREAKDOWN },
    portalCostBreakdown: { ...EMPTY_BREAKDOWN },
    portalCostYen: null,
    deductionUserCount: null,
    deductionDonationAmountYen: null,
    ...p,
  };
}

describe("金額の表記", () => {
  it("世田谷区の差額を億と万で書く（万未満は切り捨て）", () => {
    expect(yen(-12_644_981_893)).toBe("−126億4,498万円");
    expect(yen(797_244_869)).toBe("7億9,724万円");
  });
  it("万の位で四捨五入し、繰り上がりも正しく書く", () => {
    expect(yen(13_442_226_763)).toBe("134億4,223万円");
    expect(yen(99_995_000)).toBe("1億円");
    expect(yen(14_999)).toBe("1万円");
  });
  it("端数のない億・万未満・null", () => {
    expect(yen(300_000_000)).toBe("3億円");
    expect(yen(52_000)).toBe("5万円");
    expect(yen(9_999)).toBe("9,999円");
    expect(yen(0)).toBe("0円");
    expect(yen(null)).toBe("—");
  });
  it("差額は正なら＋、負なら−、0 は記号なし", () => {
    expect(signedYen(22_629_000_000)).toBe("＋226億2,900万円");
    expect(signedYen(-50_000)).toBe("−5万円");
    expect(signedYen(0)).toBe("0円");
  });
  it("目盛りと年度", () => {
    expect(axisYen(25_000_000_000)).toBe("250億");
    expect(axisYen(80_000_000)).toBe("8,000万");
    expect(axisYen(0)).toBe("0");
    expect(fiscalYearLabel(2008)).toBe("平成20年度");
    expect(fiscalYearLabel(2018)).toBe("平成30年度");
    expect(fiscalYearLabel(2019)).toBe("令和元年度");
    expect(fiscalYearLabel(2025)).toBe("令和7年度");
  });
});

describe("検索", () => {
  const list = [
    ent({ code: "130001", name: "東京都", kind: "prefecture" }),
    ent({ code: "131121", name: "世田谷区" }),
    ent({ code: "132012", name: "八王子市" }),
    ent({ code: "072010", name: "福島市", prefName: "福島県" }),
    ent({ code: "070009", name: "福島県", prefName: "福島県", kind: "prefecture" }),
  ];
  it("部分一致・県名つき・全角半角の違いで当たる", () => {
    expect(search(list, "世田谷").map((e) => e.code)).toEqual(["131121"]);
    expect(search(list, "東京都世田谷区").map((e) => e.code)).toEqual(["131121"]);
    expect(search(list, " 八王子 ").map((e) => e.code)).toEqual(["132012"]);
  });
  it("完全一致→前方一致の順、同じ強さなら都道府県が先", () => {
    expect(search(list, "福島").map((e) => e.code)).toEqual(["070009", "072010"]);
  });
  it("空の入力は何も返さない", () => {
    expect(search(list, "  ")).toEqual([]);
  });
});

describe("並べ替え表", () => {
  const list = [
    ent({ code: "000001", name: "A", primaryBalanceYen: 100 }),
    ent({ code: "000002", name: "B", primaryBalanceYen: -50 }),
    ent({ code: "000003", name: "C", primaryBalanceYen: null }),
    ent({ code: "000004", name: "D", primaryBalanceYen: 100 }),
    ent({ code: "000005", name: "E", primaryBalanceYen: 0, prefName: "大阪府" }),
    ent({ code: "000006", name: "県", kind: "prefecture", primaryBalanceYen: 999 }),
  ];
  it("都道府県を混ぜず、null を外し、同じ値は同順位", () => {
    const rows = ranking(list, "municipality", "primaryBalanceYen", "desc");
    expect(rows.map((r) => [r.rank, r.entity.name, r.value])).toEqual([
      [1, "A", 100],
      [1, "D", 100],
      [3, "E", 0],
      [4, "B", -50],
    ]);
    expect(rankOf(rows, "000003")).toBeUndefined();
  });
  it("小さい順と都道府県での絞り込み", () => {
    expect(ranking(list, "municipality", "primaryBalanceYen", "asc").map((r) => r.entity.name)).toEqual(["B", "E", "A", "D"]);
    expect(ranking(list, "municipality", "primaryBalanceYen", "desc", "大阪府").map((r) => r.entity.name)).toEqual(["E"]);
    expect(ranking(list, "prefecture", "primaryBalanceYen", "desc").map((r) => r.entity.name)).toEqual(["県"]);
  });
});

describe("URL の hash", () => {
  it("団体コードと都道府県を行き来できる", () => {
    expect(parseHash("#131121")).toEqual({ code: "131121" });
    expect(parseHash(toHash({ pref: "東京都" }))).toEqual({ pref: "東京都" });
    expect(parseHash(toHash({ pref: "東京都", map: true }))).toEqual({ pref: "東京都", map: true });
    expect(parseHash("#12345")).toEqual({});
    expect(parseHash("")).toEqual({});
    expect(toHash({})).toBe("");
  });
});

describe("推移グラフ", () => {
  it("欠測で線を切り、上限は切りのよい数", () => {
    const g = chartGeometry(
      [
        { fiscalYear: 2008, receiptAmountYen: 100 },
        { fiscalYear: 2009, receiptAmountYen: null },
        { fiscalYear: 2010, receiptAmountYen: 400 },
        { fiscalYear: 2011, receiptAmountYen: 0 },
      ],
      300,
      100,
    );
    expect(g.max).toBe(500);
    expect(g.segments).toEqual([
      [{ x: 0, y: 80 }],
      [
        { x: 200, y: 20 },
        { x: 300, y: 100 },
      ],
    ]);
  });
  it("niceMax", () => {
    expect(niceMax(23_038_604_299)).toBe(50_000_000_000);
    expect(niceMax(797_244_869)).toBe(1_000_000_000);
    expect(niceMax(0)).toBe(0);
  });
});

describe("地図の色分け", () => {
  it("金額は5段で、少ない値ほど低い段・null は -1", async () => {
    const { classify } = await import("../src/logic");
    const c = classify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null], false);
    expect(c.ranges.length).toBe(5);
    expect(c.bin(1)).toBe(0);
    expect(c.bin(10)).toBe(4);
    expect(c.bin(null)).toBe(-1);
    for (let i = 1; i < 10; i++) expect(c.bin(i)).toBeLessThanOrEqual(c.bin(i + 1));
  });
  it("差額はマイナスとプラスで段を分け、0 はプラス側", async () => {
    const { classify } = await import("../src/logic");
    const c = classify([-300, -200, -100, 0, 100, 200, 300], true);
    expect(c.ranges.length).toBe(6);
    expect(c.ranges.every((r) => r !== null)).toBe(true);
    expect(c.bin(-300)).toBe(0);
    expect(c.bin(-100)).toBeLessThan(3);
    expect(c.bin(0)).toBeGreaterThanOrEqual(3);
    expect(c.bin(300)).toBe(5);
  });
  it("片側しかない差額でも壊れない", async () => {
    const { classify } = await import("../src/logic");
    const c = classify([5, 10], true);
    expect(c.bin(5)).toBeGreaterThanOrEqual(0);
    expect(c.bin(10)).toBe(5);
    expect(c.bin(5)).toBeLessThan(c.bin(10));
  });
});

describe("1人あたり・割合（共通の計算）", () => {
  it("分母0・欠測は null、丸めない", async () => {
    const { divide, perCapita } = await import("../src/logic");
    expect(divide(10, 4)).toBe(2.5);
    expect(divide(10, 0)).toBeNull();
    expect(divide(null, 4)).toBeNull();
    expect(divide(10, null)).toBeNull();
    expect(perCapita(-12_644_981_894, 940_000)).toBeCloseTo(-13452.1, 1);
  });
  it("1人あたりで並べると、人口の少ない自治体が上に来ることがある・人口なしは外れる", async () => {
    const { ranking } = await import("../src/logic");
    const list = [
      ent({ code: "000001", name: "大都市", primaryBalanceYen: 1000, population: 1000 }),
      ent({ code: "000002", name: "小村", primaryBalanceYen: 100, population: 10 }),
      ent({ code: "000003", name: "人口なし", primaryBalanceYen: 5000, population: null }),
    ];
    expect(ranking(list, "municipality", "primaryBalanceYen", "desc").map((r) => r.entity.name)).toEqual(["人口なし", "大都市", "小村"]);
    const per = ranking(list, "municipality", "primaryBalanceYen", "desc", undefined, "perCapita");
    expect(per.map((r) => [r.entity.name, r.value])).toEqual([
      ["小村", 10],
      ["大都市", 1],
    ]);
  });
  it("1人あたり・割合・人数の表記", async () => {
    const { perPersonYen, percent, people } = await import("../src/format");
    expect(perPersonYen(-13452.1)).toBe("−13,452円");
    expect(perPersonYen(2499.5, true)).toBe("＋2,500円");
    expect(perPersonYen(null)).toBe("—");
    expect(perPersonYen(-1.5)).toBe("−2円");
    expect(perPersonYen(-0.5)).toBe("−1円");
    expect(perPersonYen(-0.4)).toBe("0円");
    expect(perPersonYen(1.5, true)).toBe("＋2円");
    expect(percent(0.4713)).toBe("47.1%");
    expect(percent(0.5)).toBe("50.0%");
    expect(percent(null)).toBe("—");
    expect(people(11_514_115)).toBe("11,514,115人");
  });
});

describe("自治体のページの順位", () => {
  it("同じ区分の中だけで数え、同じ値は同じ順位、null は数えない", async () => {
    const { rankAmong } = await import("../src/logic");
    const list = [
      ent({ code: "000001", name: "A", receiptAmountYen: 300 }),
      ent({ code: "000002", name: "B", receiptAmountYen: 500 }),
      ent({ code: "000003", name: "C", receiptAmountYen: 500 }),
      ent({ code: "000004", name: "D", receiptAmountYen: null }),
      ent({ code: "000005", name: "県", kind: "prefecture", receiptAmountYen: 9999 }),
    ];
    const v = (e: FurusatoEntity) => e.receiptAmountYen;
    expect(rankAmong(list, list[1], v, "desc")).toBe(1);
    expect(rankAmong(list, list[2], v, "desc")).toBe(1);
    expect(rankAmong(list, list[0], v, "desc")).toBe(3);
    expect(rankAmong(list, list[0], v, "asc")).toBe(1);
    expect(rankAmong(list, list[3], v, "desc")).toBeUndefined();
    expect(rankAmong(list, list[4], v, "desc")).toBe(1);
  });
});
