"""保存した配信JSONを報道資料の固定値と照合する。PDF抽出・通信は行わない。"""

from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
import unittest

from build import PRESS_FILE, RAW, ROOT


# 総務省「ふるさと納税に関する現況調査結果（令和8年度実施）」2026-07-31
# https://www.soumu.go.jp/main_content/001085011.pdf
# Claudeが2026-10-18に取得。ページ番号は資料の印字ページ（PDF物理ページは+1）。
# p.1留意事項: 表示単位未満を四捨五入。控除額は道府県民税と市町村民税の合計。
PRESS_SHA256 = "1914ba1ba0f6b6171810e4ff4feab26115ebc4dd71b6d54070604cb27f9e0ed5"
P2_RECEIPTS_OKU = Decimal("13314.3")
P2_RECEIPT_COUNT_MAN = Decimal("5963.0")
P8_TAX_OKU = Decimal("9524.4")
P9_NATIONAL_TAX_MILLION = 952442
# p.9「ふるさと納税に係る住民税控除の適用状況」都道府県分と市区町村分の合計。
# 単位: 百万円。丸められた内訳を足して全国合計を作らず、それぞれ元の円合計から照合する。
P9_PREFECTURAL_TAX_MILLION = {
    "北海道": 25378, "青森県": 3273, "岩手県": 3209, "宮城県": 11640,
    "秋田県": 2463, "山形県": 3280, "福島県": 5673, "茨城県": 14837,
    "栃木県": 9577, "群馬県": 9267, "埼玉県": 55932, "千葉県": 52829,
    "東京都": 235057, "神奈川県": 98542, "新潟県": 7962, "富山県": 4595,
    "石川県": 5906, "福井県": 3491, "山梨県": 4178, "長野県": 8705,
    "岐阜県": 11259, "静岡県": 20727, "愛知県": 67916, "三重県": 10480,
    "滋賀県": 9769, "京都府": 19007, "大阪府": 74908, "兵庫県": 44621,
    "奈良県": 9177, "和歌山県": 4327, "鳥取県": 1828, "島根県": 2045,
    "岡山県": 9675, "広島県": 15983, "山口県": 5602, "徳島県": 3004,
    "香川県": 4803, "愛媛県": 5262, "高知県": 2284, "福岡県": 31686,
    "佐賀県": 3079, "長崎県": 4572, "熊本県": 6603, "大分県": 4135,
    "宮崎県": 3566, "鹿児島県": 5407, "沖縄県": 4921,
}
# p.11「上位20団体（市区町村別）」単位: 百万円。
P11_SETAGAYA_TAX_MILLION = 13442
P11_IZUMISANO_RECEIPTS_MILLION = 23039


def displayed(value, unit, places=0):
    return (Decimal(value) / Decimal(unit)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)


class PressComparisonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entities = json.loads((ROOT / "public/data/furusato.json").read_text())["entities"]

    def test_archived_pdf_sha256(self):
        pdf = (RAW / PRESS_FILE).read_bytes()
        self.assertTrue(pdf.startswith(b"%PDF-"))
        self.assertEqual(hashlib.sha256(pdf).hexdigest(), PRESS_SHA256)
        manifest = {filename: digest for digest, filename in (line.split() for line in (RAW / "SHA256SUMS").read_text().splitlines())}
        self.assertEqual(manifest[PRESS_FILE], PRESS_SHA256)

    def test_national_receipts_and_count_p2(self):
        self.assertEqual(displayed(sum(e["receiptAmountYen"] for e in self.entities), 100000000, 1), P2_RECEIPTS_OKU)
        self.assertEqual(displayed(sum(e["receiptCount"] for e in self.entities), 10000, 1), P2_RECEIPT_COUNT_MAN)

    def test_national_receipts_include_proxy_p2(self):
        without_proxy = sum(e["receiptAmountYen"] - e["proxyReceiptAmountYen"] for e in self.entities)
        self.assertEqual(displayed(without_proxy, 100000000, 1), Decimal("13313.2"))
        self.assertNotEqual(displayed(without_proxy, 100000000, 1), P2_RECEIPTS_OKU)

    def test_national_tax_p8_and_p9(self):
        total = sum(e["residentTaxDeductionYen"] for e in self.entities)
        self.assertEqual(displayed(total, 100000000, 1), P8_TAX_OKU)
        self.assertEqual(displayed(total, 1000000), P9_NATIONAL_TAX_MILLION)

    def test_all_47_prefectures_tax_p9(self):
        totals = defaultdict(int)
        for entity in self.entities:
            # 県自身のBH集計と各市区町村のBEを一度ずつ。県単独の額とは区別する。
            totals[entity["prefName"]] += entity["residentTaxDeductionYen"]
        self.assertEqual(len(P9_PREFECTURAL_TAX_MILLION), 47)
        self.assertEqual(set(totals), set(P9_PREFECTURAL_TAX_MILLION))
        for pref, expected in P9_PREFECTURAL_TAX_MILLION.items():
            with self.subTest(pref=pref, page=9):
                self.assertEqual(displayed(totals[pref], 1000000), expected)

    def test_representatives_p11(self):
        by_code = {e["code"]: e for e in self.entities}
        self.assertEqual(displayed(by_code["131121"]["residentTaxDeductionYen"], 1000000), P11_SETAGAYA_TAX_MILLION)
        self.assertEqual(displayed(by_code["272132"]["receiptAmountYen"], 1000000), P11_IZUMISANO_RECEIPTS_MILLION)


if __name__ == "__main__":
    unittest.main()
