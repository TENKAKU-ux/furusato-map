from copy import deepcopy
from decimal import Decimal
import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

import build
from schema_check import validate


class ConversionTests(unittest.TestCase):
    def test_decimal_round_half_up_and_zero(self):
        self.assertEqual(build.yen("409469861.5"), 409469862)
        self.assertEqual(build.yen("0.5"), 1)
        self.assertEqual(build.yen("0"), 0)
        self.assertEqual(build.yen("4090638.7880000002", 1000), 4090638788)
        self.assertEqual(build.whole_integer("0"), 0)

    def test_null_does_not_become_zero(self):
        for value in (None, "", "  "):
            self.assertIsNone(build.yen(value))
            self.assertIsNone(build.whole_integer(value))
        self.assertEqual(build.balances(0, 0, 0), (0, 0))
        for received, cost, tax in [(None, 0, 0), (1, 0, None)]:
            self.assertEqual(build.balances(received, cost, tax), (None, None))
        self.assertEqual(build.balances(10, None, 3), (7, None))

    def test_unknown_missing_markers_and_invalid_numbers_fail(self):
        for value in ("-", "—", "NaN", "Infinity", "-1", "?", "1,000"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                build.yen(value)
        for value in ("1.5", "9007199254740992"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                build.whole_integer(value)
        with self.assertRaises(ValueError):
            build.yen("9007199254740992")

    def test_prefecture_sums_rounded_rows_and_preserves_missing(self):
        self.assertEqual(build.sum_nullable(build.yen(v) for v in ["0.5", "0.5"]), 2)
        self.assertEqual(build.yen(str(Decimal("0.5") + Decimal("0.5"))), 1)
        self.assertIsNone(build.sum_nullable([1, None]))
        self.assertIsNone(build.sum_nullable([]))

    def test_code_zero_padding_and_check_digit(self):
        self.assertEqual(build.code_string("11002"), "011002")
        self.assertEqual(build.code_string("010006"), "010006")
        for value in ("11002.0", "011003", "011002\n", "1002", "1e5"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                build.code_string(value)

    def test_missing_and_duplicate_codes_fail_but_named_totals_are_excluded(self):
        rows = {19: {"A": "11002", "BE": "10"}, 198: {"B": "北海道集計", "BE": "999"}}
        self.assertEqual(list(build.index_rows(rows, 19, ("BE",), {"北海道集計"})), ["011002"])
        with self.assertRaises(ValueError):
            build.index_rows(rows, 19, ("BE",))
        with self.assertRaises(ValueError):
            build.index_rows({19: rows[19], 20: rows[19]}, 19, ("BE",))

    def test_proxy_cost_columns_and_integer_balances(self):
        identity = {"code": "011002", "kind": "municipality", "prefName": "北海道", "name": "札幌市"}
        cells = {"B": "北海道", "C": "札幌市", "D": "0", "E": "149999999", "K": "100", "R": "0.5", "S": "99999999", "Y": "99999999"}
        entity = build.make_entity(identity, cells, 50000000)
        self.assertEqual(entity["proxyReceiptAmountYen"], 100)
        self.assertEqual(entity["receiptAmountYen"], 149999999)
        self.assertEqual(entity["solicitationCostYen"], 1)
        self.assertEqual(entity["primaryBalanceYen"], 99999999)
        self.assertEqual(entity["referenceBalanceYen"], 99999998)
        self.assertEqual(build.balances(1, 2, 3), (-2, -4))
        cells["K"] = ""
        self.assertEqual(build.make_entity(identity, cells, 50000000)["primaryBalanceYen"], 99999999)


class XlsxTests(unittest.TestCase):
    def workbook(self, folder, cell):
        path = Path(folder) / "fixture.xlsx"
        ns = build.NS
        with ZipFile(path, "w") as archive:
            archive.writestr("xl/workbook.xml", f'<workbook xmlns="{ns}" xmlns:r="{build.REL}"><sheets><sheet name="試験" sheetId="1" r:id="rId1"/></sheets></workbook>')
            archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="/xl/worksheets/custom.xml"/></Relationships>')
            archive.writestr("xl/sharedStrings.xml", f'<sst xmlns="{ns}"><si><t>東</t><rPh sb="0" eb="1"><t>トウ</t></rPh><r><t>京都</t></r></si></sst>')
            archive.writestr("xl/worksheets/custom.xml", f'<worksheet xmlns="{ns}"><sheetData><row r="1">{cell}</row></sheetData></worksheet>')
        return path

    def test_shared_and_inline_strings_exclude_rph_in_document_order(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.workbook(folder, '<c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><r><t>世田</t></r><rPh><t>セタ</t></rPh><r><t>谷区</t></r></is></c><c r="C1"><v>0.4999999999999999</v></c>')
            self.assertEqual(build.read_sheet(path, "試験")[1], {"A": "東京都", "B": "世田谷区", "C": "0.4999999999999999"})

    def test_formula_requires_cached_value(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.workbook(folder, '<c r="A1"><f>1+1</f><v>2.00</v></c>')
            self.assertEqual(build.read_sheet(path, "試験")[1]["A"], "2.00")
            path = self.workbook(folder, '<c r="A1"><f>1+1</f></c>')
            with self.assertRaisesRegex(ValueError, "保存済み計算結果"):
                build.read_sheet(path, "試験")

    def test_excel_errors_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.workbook(folder, '<c r="A1" t="e"><v>#REF!</v></c>')
            with self.assertRaisesRegex(ValueError, "Excelエラー"):
                build.read_sheet(path, "試験")


class HistoryTests(unittest.TestCase):
    def entity(self, code="011002", pref="北海道", name="札幌市"):
        return {"code": code, "kind": "municipality", "prefName": pref, "name": name, "history": None}

    def test_same_prefecture_same_name_is_ambiguous(self):
        entities = [self.entity("011002"), self.entity("012025")]
        report = build.assign_histories(entities, {5: {"A": "北海道", "B": "札幌市", "AK": "1"}})
        self.assertTrue(all(e["history"] is None for e in entities))
        self.assertEqual(len(report["ambiguousKeys"]), 1)

    def test_duplicate_source_rows_are_not_added(self):
        entities = [self.entity()]
        row = {"A": "北海道", "B": "札幌市", "AK": "1"}
        report = build.assign_histories(entities, {5: row, 6: row})
        self.assertIsNone(entities[0]["history"])
        self.assertEqual(report["ambiguousKeys"][0]["rows"], [5, 6])

    def test_yearly_missing_and_totals(self):
        entities = [self.entity()]
        report = build.assign_histories(entities, {5: {"A": " 北海道 ", "B": "札幌市\n", "AK": "1.25"}, 6: {"A": "市町村合計", "AK": "999"}, 7: {"A": "全国合計", "AK": "999"}})
        self.assertEqual(len(entities[0]["history"]), 18)
        self.assertIsNone(entities[0]["history"][0]["receiptAmountYen"])
        self.assertEqual(entities[0]["history"][-1], {"fiscalYear": 2025, "receiptAmountYen": 1250})
        self.assertEqual(report["extraRows"], [])

    def test_missing_extra_and_all_missing_are_reported(self):
        entities = [self.entity()]
        report = build.assign_histories(entities, {5: {"A": "北海道", "B": "旧団体", "AK": "1"}})
        self.assertEqual(report["missingCodes"], ["011002"])
        self.assertEqual(len(report["extraRows"]), 1)
        self.assertIsNone(entities[0]["history"])
        report = build.assign_histories(entities, {5: {"A": "北海道", "B": "札幌市"}})
        self.assertEqual(report["nullHistories"][0]["reason"], "全年度欠測")

    def test_same_name_in_different_prefectures_remains_separate(self):
        entities = [self.entity(name="同名市"), self.entity("022012", "青森県", "同名市")]
        build.assign_histories(entities, {5: {"A": "北海道", "B": "同名市", "AK": "1"}, 6: {"A": "青森県", "B": "同名市", "AK": "2"}})
        self.assertEqual([e["history"][-1]["receiptAmountYen"] for e in entities], [1000, 2000])


class RealDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data, cls.report = build.build_dataset()
        cls.by_code = {e["code"]: e for e in cls.data["entities"]}
        cls.schema = json.loads((build.ROOT / "schema/furusato.schema.json").read_text())

    def test_counts_joins_names_and_history(self):
        self.assertEqual(self.report["counts"], {"entities": 1788, "prefecture": 47, "municipality": 1741, "deductions": 1741})
        self.assertEqual(len(self.by_code), 1788)
        self.assertTrue(all(not codes for codes in self.report["joins"].values()))
        self.assertTrue(all(not rows for rows in self.report["history"].values()))
        for entity in self.data["entities"]:
            self.assertEqual([p["fiscalYear"] for p in entity["history"]], list(range(2008, 2026)))
            self.assertEqual(entity["history"][-1]["receiptAmountYen"], entity["receiptAmountYen"])
            if entity["kind"] == "prefecture":
                self.assertEqual(entity["name"], entity["prefName"])

    def test_representatives_from_source_cells(self):
        for code, expected in {
            "131121": (797244869, 290266013, 13442226763, -12644981894, -12935247907),
            "272132": (23038604299, 10859274841, 409469862, 22629134437, 11769859596),
            "010006": (1990433199, 910469829, 7414381580, -5423948381, -6334418210),
            "011002": (4090638788, 1948772045, 10968059673, -6877420885, -8826192930),
        }.items():
            with self.subTest(code=code):
                self.assertEqual(tuple(self.by_code[code][f] for f in ("receiptAmountYen", "solicitationCostYen", "residentTaxDeductionYen", "primaryBalanceYen", "referenceBalanceYen")), expected)

    def test_independent_source_totals_and_rounding(self):
        self.assertEqual(self.report["sums"], {"receiptAmountYen": 1331428336499, "receiptCount": 59630027, "proxyReceiptAmountYen": 105655632, "solicitationCostYen": 638213754459, "residentTaxDeductionYen": 952441869261})
        self.assertEqual(self.report["rounding"]["municipalTax"]["rawSumYen"], "623304362273.6242464690")
        self.assertEqual(self.report["rounding"]["prefecturalTax"]["rawSumYen"], "329137506976.2053336004")
        self.assertEqual(len(self.report["fractionalCosts"]), 17)
        self.assertEqual(len(self.report["excludedDeductionAggregates"]), 48)
        for item in self.report["rounding"].values():
            self.assertLessEqual(abs(Decimal(item["deltaYen"])), Decimal(item["toleranceYen"]))

    def test_each_prefecture_uses_its_municipal_bh_after_rounding(self):
        rows = build.read_sheet(build.RAW / "001085012.xlsx", "集計表")
        for entity in self.data["entities"]:
            if entity["kind"] == "prefecture":
                values = [build.yen(c["BH"]) for c in rows.values() if c.get("A", "").isdigit() and c["A"].zfill(6)[:2] == entity["code"][:2]]
                self.assertEqual(entity["residentTaxDeductionYen"], sum(values))

    def test_schema_metadata_and_size(self):
        validate(self.data, self.schema)
        for source in self.data["metadata"]["sources"].values():
            self.assertEqual(source["retrievedOn"], "2026-10-18")
        content = build.compact_json(self.data)
        self.assertLess(len(content), 3200000)
        self.assertLess(len(gzip.compress(content, mtime=0)), 500000)

    def test_schema_rejects_bad_codes_fractions_dates_and_shapes(self):
        cases = [
            (("entities", 0, "code"), "11002"), (("entities", 0, "code"), "010006\n"),
            (("entities", 0, "receiptAmountYen"), 0.5), (("entities", 0, "receiptAmountYen"), -1),
            (("entities", 0, "receiptAmountYen"), 9007199254740992),
            (("metadata", "sources", "receipts", "retrievedOn"), "2026-02-30"),
            (("metadata", "sources", "receipts", "sha256"), "a" * 64 + "\n"),
            (("metadata", "sources", "receipts", "url"), "https://"),
            (("entities", 0, "kind"), "city"), (("metadata", "rounding"), "ROUND_HALF_EVEN"),
        ]
        for keys, value in cases:
            with self.subTest(keys=keys, value=value):
                data = deepcopy(self.data)
                target = data
                for key in keys[:-1]:
                    target = target[key]
                target[keys[-1]] = value
                with self.assertRaises(ValueError):
                    validate(data, self.schema)
        data = deepcopy(self.data)
        del data["entities"][0]["history"]
        with self.assertRaises(ValueError):
            validate(data, self.schema)
        with self.assertRaisesRegex(ValueError, "未対応"):
            validate(1, {"oneOf": []})

    def test_source_mutation_and_r7_mismatch_fail(self):
        original = build.read_sheet

        def changed(path, name):
            rows = original(path, name)
            if name == "各団体一覧":
                rows[5]["AK"] = "1"
            return rows

        with patch.object(build, "read_sheet", side_effect=changed), self.assertRaisesRegex(ValueError, "R7推移照合未達"):
            build.build_dataset()
        with tempfile.TemporaryDirectory() as folder:
            raw = Path(folder)
            (raw / "SHA256SUMS").write_text((build.RAW / "SHA256SUMS").read_text())
            (raw / "001084989.xlsx").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "SHA-256不一致"):
                build.build_dataset(raw)

    def test_missing_and_extra_joins_fail(self):
        original = build.read_sheet
        for mode in ("missing", "extra"):
            def changed(path, name):
                rows = original(path, name)
                if mode == "missing" and name == "Sheet1":
                    del rows[15]
                elif mode == "extra" and name == "集計表":
                    rows[4000] = {**rows[19], "A": "010006"}
                return rows

            with self.subTest(mode=mode), patch.object(build, "read_sheet", side_effect=changed), self.assertRaisesRegex(ValueError, "結合の欠落/余剰"):
                build.build_dataset()

    def test_source_unit_change_fails(self):
        original = build.read_sheet

        def changed(path, name):
            rows = original(path, name)
            if name == "各団体一覧":
                rows[1]["AL"] = "（単位：円、件）"
            return rows

        with patch.object(build, "read_sheet", side_effect=changed), self.assertRaisesRegex(ValueError, "推移の単位変更"):
            build.build_dataset()


if __name__ == "__main__":
    unittest.main()
