from copy import deepcopy
import hashlib
import json
import unittest

import build


SOURCE_DIGESTS = {
    "population": "76378bfa269f3b3c5681eeb895929f2078a25d719bf5d3428d1394831e95df17",
    "ordinaryGrant": "b2e6fc16cf5553c1e930c7af7955961d8b97be64af592b6b750063044b00f08c",
    "ordinaryGrantSummary": "f18d95bed68a7986de9962f26cf8804f8f106ec46311235a9f9f30046972f09c",
}
# 総務省001083397.pdf、印字p.6（物理7ページ）の一覧を目視転記。単位: 市町村。
NON_RECEIVING_P6 = {
    "北海道": "泊村", "青森県": "六ヶ所村", "宮城県": "大和町 女川町",
    "福島県": "西郷村 広野町 大熊町", "茨城県": "つくば市 神栖市 東海村",
    "栃木県": "宇都宮市 芳賀町", "群馬県": "太田市 明和町 大泉町",
    "埼玉県": "戸田市 和光市 八潮市 三芳町",
    "千葉県": "市川市 成田市 市原市 君津市 浦安市 袖ケ浦市 印西市 芝山町",
    "東京都": "立川市 武蔵野市 三鷹市 府中市 調布市 小金井市 国分寺市 国立市 多摩市 瑞穂町",
    "神奈川県": "川崎市 平塚市 鎌倉市 藤沢市 厚木市 海老名市 寒川町 箱根町 愛川町",
    "新潟県": "聖籠町 刈羽村", "福井県": "美浜町 高浜町 おおい町",
    "山梨県": "昭和町 忍野村 山中湖村", "長野県": "軽井沢町",
    "静岡県": "富士市 御殿場市 裾野市 湖西市 長泉町",
    "愛知県": "豊橋市 岡崎市 碧南市 刈谷市 豊田市 安城市 小牧市 東海市 大府市 日進市 田原市 みよし市 長久手市 豊山町 大口町 飛島村 武豊町 幸田町",
    "三重県": "四日市市 川越町", "京都府": "久御山町", "大阪府": "田尻町",
    "兵庫県": "芦屋市", "福岡県": "苅田町", "佐賀県": "玄海町", "熊本県": "菊陽町",
}
V1_FIELDS = "code kind prefName name receiptAmountYen receiptCount proxyReceiptAmountYen solicitationCostYen residentTaxDeductionYen primaryBalanceYen referenceBalanceYen history".split()
# f68dea4時点の配信JSONの全1788団体・v1全フィールドを正規化したSHA-256。
V1_ENTITY_DIGEST = "5ca1dba1b97cd4d5a55274cd4c20da96c34851900f2a0c5838287f347c0aa66e"


class V2DataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data, cls.report = build.build_dataset()
        cls.entities = cls.data["entities"]
        cls.by_code = {e["code"]: e for e in cls.entities}

    def test_new_sources_have_exact_hashes_and_dates(self):
        self.assertEqual(self.data["metadata"]["schemaVersion"], 2)
        for key, expected in SOURCE_DIGESTS.items():
            with self.subTest(source=key):
                self.assertEqual(hashlib.sha256((build.RAW / build.SOURCES[key]).read_bytes()).hexdigest(), expected)
                self.assertEqual(self.data["metadata"]["sources"][key], {"url": build.SOURCE_URLS[key], "retrievedOn": "2026-10-18", "sha256": expected})

    def test_all_population_codes_and_47_prefecture_sums(self):
        report = self.report["v2"]["population"]
        self.assertEqual(report["matched"], 1788)
        self.assertEqual(report["missingCodes"], [])
        self.assertEqual(len(report["excludedRows"]), 485)
        self.assertEqual(len(report["prefectureSums"]), 47)
        for pref in (e for e in self.entities if e["kind"] == "prefecture"):
            self.assertEqual(pref["population"], sum(e["population"] for e in self.entities if e["kind"] == "municipality" and e["prefName"] == pref["prefName"]))
        self.assertEqual(sum(e["population"] for e in self.entities if e["kind"] == "prefecture"), 123767642)
        self.assertEqual(self.by_code["010006"]["population"], 4996492)
        self.assertEqual(self.by_code["011002"]["population"], 1954588)

    def test_grant_counts_and_four_exact_aliases(self):
        report = self.report["v2"]["ordinaryGrant"]
        self.assertEqual(report["counts"], {"receiving": 1678, "non_receiving": 87, "tokyo_special_ward": 23, "unknown": 0})
        self.assertEqual({(r["prefName"], r["sourceName"]): (r["code"], r["name"]) for r in report["aliases"]}, build.GRANT_NAME_ALIASES)
        self.assertEqual(report["missingCodes"], [])
        self.assertEqual(self.by_code["130001"]["ordinaryGrantStatus"], "non_receiving")
        self.assertEqual(self.by_code["131121"]["ordinaryGrantStatus"], "tokyo_special_ward")

    def test_non_receiving_names_match_summary_p6_all_86(self):
        expected = {(pref, name) for pref, names in NON_RECEIVING_P6.items() for name in names.split()}
        actual = {(e["prefName"], e["name"]) for e in self.entities if e["kind"] == "municipality" and e["ordinaryGrantStatus"] == "non_receiving"}
        self.assertEqual(len(expected), 86)
        self.assertEqual(actual, expected)

    def test_bc_bd_and_all_prefecture_aggregations(self):
        rows = build.read_sheet(build.RAW / build.SOURCES["deductions"], "集計表")
        municipal = {c["A"].zfill(6): c for c in rows.values() if c.get("A", "").isdigit()}
        for e in self.entities:
            codes = [e["code"]] if e["kind"] == "municipality" else [code for code in municipal if code[:2] == e["code"][:2]]
            self.assertEqual(e["deductionUserCount"], sum(int(municipal[c]["BC"]) for c in codes))
            self.assertEqual(e["deductionDonationAmountYen"], sum(int(municipal[c]["BD"]) for c in codes))
        self.assertEqual(sum(e["deductionUserCount"] for e in self.entities if e["kind"] == "municipality"), 11514115)
        self.assertEqual(self.report["v2"]["deductions"]["municipalDonationAmountYen"], 1273227756270)

    def test_cost_pairs_totals_and_three_rounding_differences(self):
        report = self.report["v2"]["costs"]
        self.assertEqual({r["code"]: r["deltaYen"] for r in report["roundingDifferences"]}, {"222151": 1, "272141": 1, "303411": 1})
        self.assertEqual(report["verifiedComparisons"], 10712)
        self.assertEqual(len(report["unknownComparisons"]), 16)
        for e in self.entities:
            for key in build.COST_KEYS:
                total, portal = e["solicitationCostBreakdown"][key], e["portalCostBreakdown"][key]
                if total is not None and portal is not None:
                    self.assertLessEqual(portal, total)
            values = list(e["portalCostBreakdown"].values())
            if all(v is not None for v in values):
                self.assertEqual(sum(values), e["portalCostYen"])
            self.assertLessEqual(e["portalCostYen"], e["solicitationCostYen"])

    def test_missing_costs_stay_null_and_are_not_reported_as_verified(self):
        report = self.report["v2"]["costs"]
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(len(report["missingCells"]), 20)
        self.assertEqual(len(report["incompleteSums"]), 14)
        for missing in report["missingCells"]:
            self.assertIsNone(self.by_code[missing["code"]][missing["field"]][missing["key"]])
        self.assertTrue(all(r["residualYen"] == 0 for r in report["incompleteSums"]))

    def test_v1_every_entity_every_field_is_unchanged(self):
        projection = [{key: e[key] for key in V1_FIELDS} for e in self.entities]
        digest = hashlib.sha256(json.dumps(projection, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(digest, V1_ENTITY_DIGEST)

    def test_every_v1_scalar_against_original_cells(self):
        rows = build.read_sheet(build.RAW / build.SOURCES["receipts"], "Sheet1")
        receipts = {c["A"]: c for c in rows.values() if c.get("A", "").isdigit()}
        for e in self.entities:
            c = receipts[e["code"]]
            self.assertEqual(e["receiptAmountYen"], int(c["E"]))
            self.assertEqual(e["receiptCount"], int(c["D"]))
            self.assertEqual(e["proxyReceiptAmountYen"], int(c["K"]))
            self.assertEqual(e["solicitationCostYen"], build.yen(c["R"]))
            self.assertEqual(e["primaryBalanceYen"], e["receiptAmountYen"] - e["residentTaxDeductionYen"])
            self.assertEqual(e["referenceBalanceYen"], e["primaryBalanceYen"] - e["solicitationCostYen"])


class V2FailureTests(unittest.TestCase):
    def population_fixture(self):
        official = {
            "010006": {"kind": "prefecture", "prefName": "北海道", "name": "北海道"},
            "011002": {"kind": "municipality", "prefName": "北海道", "name": "札幌市"},
        }
        rows = {8: {"A": "010006", "B": "北海道", "F": "10"}, 9: {"A": "011002", "B": "北海道", "F": "10"}, 10: {"A": "011011", "B": "北海道", "F": "10"}}
        return official, rows

    def test_population_missing_duplicate_and_wrong_sum_fail(self):
        official, rows = self.population_fixture()
        values, _ = build.population_values(rows, official)
        self.assertEqual(values, {"010006": 10, "011002": 10})
        for mode in ("missing", "duplicate", "sum", "null"):
            changed = deepcopy(rows)
            if mode == "missing": del changed[9]
            elif mode == "duplicate": changed[11] = changed[9]
            elif mode == "sum": changed[8]["F"] = "11"
            else: changed[9]["F"] = ""
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                build.population_values(changed, official)

    def test_grant_only_explicit_aliases_and_no_unknown_default(self):
        official = {"023213": {"kind": "municipality", "prefName": "青森県", "name": "鰺ヶ沢町"}}
        rows = {7: {"B": "青森県", "C": "鰺ケ沢町", "D": "1"}}
        values, _ = build.ordinary_grant_statuses(rows, official)
        self.assertEqual(values["023213"], "receiving")
        rows[7]["D"] = "0"
        self.assertEqual(build.ordinary_grant_statuses(rows, official)[0]["023213"], "non_receiving")
        for name in ("鯵ヶ沢町", "未知町"):
            changed = deepcopy(rows); changed[7]["C"] = name
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "名称が不一致"):
                build.ordinary_grant_statuses(changed, official)
        with self.assertRaisesRegex(ValueError, "結合欠落"):
            build.ordinary_grant_statuses({}, official)
        with self.assertRaisesRegex(ValueError, "大綱に県の状態がない"):
            build.ordinary_grant_statuses({}, {"990000": {"kind": "prefecture", "prefName": "未知県"}})

    def test_grant_duplicate_and_missing_amount_fail(self):
        official = {"023213": {"kind": "municipality", "prefName": "青森県", "name": "鰺ヶ沢町"}}
        row = {"B": "青森県", "C": "鰺ケ沢町", "D": "1"}
        with self.assertRaisesRegex(ValueError, "コード重複"):
            build.ordinary_grant_statuses({7: row, 8: row}, official)
        with self.assertRaisesRegex(ValueError, "欠測"):
            build.ordinary_grant_statuses({7: {**row, "D": ""}}, official)

    def test_cost_excess_and_y_mismatch_fail(self):
        identity = {"code": "011002", "kind": "municipality", "prefName": "北海道", "name": "札幌市"}
        cells = {column: "0" for column in "DEKLMNOPQRSTUV WXY".replace(" ", "")}
        cells.update(B="北海道", C="札幌市", L="1", R="1", S="2", Y="2")
        entity = build.make_entity(identity, cells, 0)
        with self.assertRaisesRegex(ValueError, "内数が費用を超える"):
            build.add_cost_breakdowns([entity], {"011002": (15, cells)})
        cells.update(S="0", Y="1")
        with self.assertRaisesRegex(ValueError, "内訳とYが不一致"):
            build.add_cost_breakdowns([entity], {"011002": (15, cells)})


if __name__ == "__main__":
    unittest.main()
