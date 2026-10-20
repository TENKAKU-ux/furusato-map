import { describe, expect, it } from "vitest";
import type { FurusatoData } from "../src/data-contract";
import japan from "../src/japan-map.json";
import rawData from "../public/data/furusato.json";

const data = rawData as FurusatoData;
type PrefFile = { shapes: { code: string | null }[]; outside: { code: string }[] };
const files = import.meta.glob<PrefFile>("../public/map/*.json", { eager: true, import: "default" });

describe("地図データ", () => {
  it("全国地図は47都道府県が1回ずつ、名前は今のデータと同じ", () => {
    const prefs = data.entities.filter((e) => e.kind === "prefecture").map((e) => e.name);
    expect(japan.prefectures.map((p) => p.name).sort()).toEqual(prefs.sort());
  });

  it("どの県でも、市区町村は地図の中か「地図の外の島」のどちらかにちょうど1回出る", () => {
    japan.prefectures.forEach((p, i) => {
      const file = files[`../public/map/${String(i + 1).padStart(2, "0")}.json`];
      const shown = [...file.shapes.flatMap((s) => (s.code ? [s.code] : [])), ...file.outside.map((o) => o.code)];
      const expected = data.entities.filter((e) => e.kind === "municipality" && e.prefName === p.name).map((e) => e.code);
      expect(shown.sort(), p.name).toEqual(expected.sort());
    });
  });
});
