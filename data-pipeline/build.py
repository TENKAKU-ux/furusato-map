"""保存済み原票から契約v2のJSONと検証記録を生成する（外部依存・通信なし）。"""

from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
import gzip
import hashlib
import json
from pathlib import Path
import posixpath
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile

from schema_check import validate


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data-pipeline/raw"
SAFE_INTEGER = 9007199254740991
NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
HISTORY_COLUMNS = "C E G I K M O Q S U W Y AA AC AE AG AI AK".split()
SOURCES = {
    "receipts": "001084989.xlsx", "history": "001084990.xlsx", "deductions": "001085012.xlsx",
    "population": "population_26-03_2026.xlsx", "ordinaryGrant": "ordinary_grant_001083404.xlsx",
    "ordinaryGrantSummary": "ordinary_grant_summary_001083397.pdf",
}
SOURCE_URLS = {
    "receipts": "https://www.soumu.go.jp/main_content/001084989.xlsx",
    "history": "https://www.soumu.go.jp/main_content/001084990.xlsx",
    "deductions": "https://www.soumu.go.jp/main_content/001085012.xlsx",
    "population": "https://www.e-stat.go.jp/stat-search/file-download?fileKind=0&statInfId=000040479049",
    "ordinaryGrant": "https://www.soumu.go.jp/main_content/001083404.xlsx",
    "ordinaryGrantSummary": "https://www.soumu.go.jp/main_content/001083397.pdf",
}
PRESS_FILE = "press_001085011.pdf"
POPULATION_SHEET = "人口、世帯数、人口動態（市区町村別）【総計】"
COST_KEYS = "procurementYen shippingYen advertisingYen settlementYen administrationYen otherYen".split()
GRANT_NAME_ALIASES = {
    ("青森県", "鰺ケ沢町"): ("023213", "鰺ヶ沢町"),
    ("青森県", "六ケ所村"): ("024112", "六ヶ所村"),
    ("兵庫県", "宝塚市"): ("282146", "宝塚市"),
    ("高知県", "檮原町"): ("394050", "梼原町"),
}
# 普通交付税大綱の印字p.4の道府県分とp.5～6。PDF抽出は実行時には行わない。
PREFECTURAL_GRANT_STATUSES = {name: "receiving" for name in (
    "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 "
    "神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 "
    "滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 "
    "徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県"
).split()}
PREFECTURAL_GRANT_STATUSES["東京都"] = "non_receiving"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text_body(element):
    """本文のt/r/tだけを文書順に読み、rPhを除外する。"""
    parts = []
    for child in element:
        if child.tag == f"{{{NS}}}t":
            parts.append(child.text or "")
        elif child.tag == f"{{{NS}}}r":
            parts.extend(t.text or "" for t in child.findall(f"{{{NS}}}t"))
    return "".join(parts)


def read_sheet(path, name):
    """セル値は数値文字列のまま保持。数式は保存済みの計算結果を使う。"""
    with ZipFile(path) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        links = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {r.attrib["Id"]: r.attrib["Target"] for r in links}
        sheets = {s.attrib["name"]: s.attrib[f"{{{REL}}}id"] for s in workbook.find(f"{{{NS}}}sheets")}
        target = targets[sheets[name]]
        target = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = [text_body(si) for si in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
        rows = {}
        for row in ET.fromstring(archive.read(target)).findall(f"{{{NS}}}sheetData/{{{NS}}}row"):
            cells = {}
            for cell in row:
                address = cell.attrib["r"]
                column = re.fullmatch(r"([A-Z]+)[0-9]+", address).group(1)
                kind = cell.attrib.get("t")
                require(kind != "e", f"{path.name}!{address}: Excelエラー")
                value = cell.find(f"{{{NS}}}v")
                if kind == "inlineStr":
                    value = cell.find(f"{{{NS}}}is")
                    cells[column] = text_body(value) if value is not None else ""
                elif value is not None and value.text is not None:
                    cells[column] = strings[int(value.text)] if kind == "s" else value.text
                else:
                    require(cell.find(f"{{{NS}}}f") is None, f"{path.name}!{address}: 数式の保存済み計算結果がない")
            rows[int(row.attrib["r"])] = cells
        return rows


def decimal_value(value):
    if value is None or value.strip() == "":
        return None
    try:
        number = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"未知の数値/欠測記号: {value!r}") from exc
    require(number.is_finite() and number >= 0, f"不正な非負数: {value!r}")
    return number


def yen(value, scale=1):
    number = decimal_value(value)
    if number is None:
        return None
    number *= scale
    require(number <= SAFE_INTEGER, f"安全な整数範囲を超える金額: {value}")
    return int(number.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def whole_integer(value):
    number = decimal_value(value)
    if number is None:
        return None
    require(number == number.to_integral_value() and number <= SAFE_INTEGER, f"整数ではない/範囲外: {value}")
    return int(number)


def code_string(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9]{5,6}", value) is not None, f"不正なコード: {value!r}")
    code = value.zfill(6)
    check = (11 - sum(int(d) * w for d, w in zip(code[:5], (6, 5, 4, 3, 2))) % 11) % 10
    require(int(code[-1]) == check, f"チェックディジット不一致: {code}")
    return code


def index_rows(rows, first, amount_columns, aggregate_labels=()):
    result = {}
    for row_number, cells in rows.items():
        if row_number < first:
            continue
        if not cells.get("A"):
            if cells.get("B") in aggregate_labels and not cells.get("C"):
                continue
            require(not any(cells.get(c) for c in amount_columns), f"コード欠落行: {row_number}")
            continue
        code = code_string(cells["A"])
        require(code not in result, f"コード重複: {code}")
        result[code] = (row_number, cells)
    return result


def official_entities(rows):
    result = {}
    for code, (_, cells) in index_rows(rows, 2, ("B", "C")).items():
        kind = "prefecture" if code[2:5] == "000" else "municipality"
        require(bool(cells.get("B")), f"公式コード表に県名なし: {code}")
        require(bool(cells.get("C")) == (kind == "municipality"), f"公式コード表の県分類不一致: {code}")
        result[code] = {"code": code, "kind": kind, "prefName": cells["B"], "name": cells.get("C") or cells["B"]}
    prefectures = {code[:2]: e["prefName"] for code, e in result.items() if e["kind"] == "prefecture"}
    require(len(prefectures) == 47, "県コードが47ではない")
    require(all(prefectures.get(code[:2]) == e["prefName"] for code, e in result.items()), "公式コード表の所属県不一致")
    return result


def sum_nullable(values):
    values = list(values)
    return None if not values or any(v is None for v in values) else sum(values)


def balances(received, cost, deduction):
    primary = None if received is None or deduction is None else received - deduction
    reference = None if primary is None or cost is None else primary - cost
    return primary, reference


def make_entity(identity, cells, deduction):
    require(cells.get("B") == identity["prefName"], f"受入の所属県不一致: {identity['code']}")
    if identity["kind"] == "municipality":
        require(cells.get("C") == identity["name"], f"受入の名称不一致: {identity['code']}")
    received = whole_integer(cells.get("E"))
    cost = yen(cells.get("R"))
    primary, reference = balances(received, cost, deduction)
    return {
        **identity, "receiptAmountYen": received, "receiptCount": whole_integer(cells.get("D")),
        "proxyReceiptAmountYen": whole_integer(cells.get("K")), "solicitationCostYen": cost,
        "residentTaxDeductionYen": deduction, "primaryBalanceYen": primary,
        "referenceBalanceYen": reference, "history": None,
    }


def assign_histories(entities, rows):
    targets = defaultdict(list)
    sources = defaultdict(list)
    for entity in entities:
        targets[(entity["kind"], entity["prefName"], entity["name"])].append(entity)
    for row_number, cells in rows.items():
        if row_number < 5:
            continue
        pref = (cells.get("A") or "").strip()
        name = (cells.get("B") or "").strip()
        if not pref and not name:
            continue
        if pref in ("市町村合計", "合計", "全国合計"):
            continue
        require(bool(pref), f"推移の県名欠落: {row_number}")
        key = ("municipality" if name else "prefecture", pref, name or pref)
        sources[key].append((row_number, cells))
    nulls, missing, ambiguous = [], [], []
    for key, group in targets.items():
        candidates = sources.get(key, [])
        reason = None
        if not candidates:
            reason = "対応する推移行なし"
            missing.extend(e["code"] for e in group)
        elif len(group) != 1 or len(candidates) != 1:
            reason = "同県同名などにより対応が一意でない"
            ambiguous.append({"key": list(key), "codes": [e["code"] for e in group], "rows": [r for r, _ in candidates]})
        if reason is None:
            cells = candidates[0][1]
            points = [{"fiscalYear": year, "receiptAmountYen": yen(cells.get(column), 1000)} for year, column in zip(range(2008, 2026), HISTORY_COLUMNS)]
            if all(p["receiptAmountYen"] is None for p in points):
                reason = "全年度欠測"
            else:
                group[0]["history"] = points
        if reason:
            for entity in group:
                entity["history"] = None
                nulls.append({"code": entity["code"], "reason": reason})
    extra = [{"key": list(key), "rows": [r for r, _ in candidates]} for key, candidates in sources.items() if key not in targets]
    return {"missingCodes": missing, "extraRows": extra, "ambiguousKeys": ambiguous, "nullHistories": nulls}


def verify_headers(receipts, history, deductions):
    for cells, column, expected in [
        (receipts[13], "D", "件数"), (receipts[13], "E", "金額"),
        (receipts[13], "K", "金額"), (receipts[12], "R", "合計"),
        (deductions[14], "BC", "市町村民税"), (deductions[14], "BF", "道府県民税"),
    ]:
        require(cells.get(column) == expected, f"列見出し変更: {column} != {expected}")
    require("単位：千円、件" in history[1].get("AL", ""), "推移の単位変更")
    require("金額：円" in receipts[6].get("A", ""), "受入の単位変更")
    for column in ("BE", "BH"):
        require("控除額" in deductions[16].get(column, "") and "円" in deductions[16][column] and "推計値含む" in deductions[16][column], f"控除列の定義変更: {column}")
    for columns in ("LMNOPQ", "STUVWX"):
        for column, expected in zip(columns, ("返礼品等の調達に係る費用", "返礼品等の送付に係る費用", "広報に係る費用", "決済等に係る費用", "事務に係る費用", "その他")):
            require(receipts[12].get(column) == expected, f"費用内訳列の定義変更: {column}")
    require(receipts[12].get("Y") == "合計", "ポータル合計列の定義変更")
    for column, label in (("BC", "人数"), ("BD", "寄附金額")):
        require(label in deductions[16].get(column, ""), f"控除の人数/寄附金額列の定義変更: {column}")
    years = ["平成20年度", "平成21年度", "平成22年度", "平成23年度", "平成24年度", "平成25年度", "平成26年度", "平成27年度", "平成28年度", "平成29年度", "平成30年度", "令和元年度", "令和２年度", "令和３年度", "令和４年度", "令和５年度", "令和６年度", "令和７年度"]
    for column, year in zip(HISTORY_COLUMNS, years):
        require(history[2].get(column) == year and history[4].get(column) == "金額", f"推移の年度/金額列変更: {column}")


def population_values(rows, official):
    values, excluded = {}, []
    seen = set()
    for row, cells in rows.items():
        if row < 8 or not cells.get("A"):
            continue
        if cells["A"].startswith(("注1：", "注2：")) and not cells.get("F"):
            continue
        code = code_string(cells["A"])
        require(code not in seen, f"人口コード重複: {code}")
        seen.add(code)
        if code not in official:
            excluded.append({"row": row, "code": code, "name": cells.get("C")})
            continue
        require(cells.get("B") == official[code]["prefName"], f"人口の所属県不一致: {code}")
        values[code] = whole_integer(cells.get("F"))
    missing = sorted(set(official) - set(values))
    require(not missing, f"人口の結合欠落: {missing}")
    require(all(value is not None for value in values.values()), "人口が欠測")
    prefectures = []
    for code, identity in official.items():
        if identity["kind"] != "prefecture":
            continue
        municipal_sum = sum(values[c] for c, e in official.items() if e["kind"] == "municipality" and c[:2] == code[:2])
        require(values[code] == municipal_sum, f"県人口と市区町村和が不一致: {code}")
        prefectures.append({"code": code, "population": values[code], "municipalSum": municipal_sum})
    return values, {"matched": len(values), "missingCodes": missing, "excludedRows": excluded, "prefectureSums": prefectures}


def ordinary_grant_statuses(rows, official):
    by_name = defaultdict(list)
    statuses, aliases, excluded = {}, [], []
    for code, identity in official.items():
        if identity["kind"] == "prefecture":
            require(identity["prefName"] in PREFECTURAL_GRANT_STATUSES, f"大綱に県の状態がない: {code}")
            statuses[code] = PREFECTURAL_GRANT_STATUSES[identity["prefName"]]
        elif identity["prefName"] == "東京都" and code.startswith("131") and identity["name"].endswith("区"):
            statuses[code] = "tokyo_special_ward"
        else:
            by_name[(identity["prefName"], identity["name"])].append(code)
    pref = None
    for row, cells in rows.items():
        if row < 7:
            continue
        if cells.get("B"):
            pref = cells["B"].strip()
        name = (cells.get("C") or "").strip()
        if not name:
            require(not cells.get("D"), f"交付税の団体名欠落: {row}")
            continue
        require(pref in PREFECTURAL_GRANT_STATUSES, f"交付税の未知県: {pref}")
        if (pref, name) == ("東京都", "特別区"):
            excluded.append(row)
            continue
        original = name
        alias = GRANT_NAME_ALIASES.get((pref, name))
        if alias:
            code, name = alias
            require(code in official and official[code]["name"] == name, f"字体差対応表の不一致: {alias}")
            aliases.append({"row": row, "prefName": pref, "sourceName": original, "name": name, "code": code})
        matches = by_name.get((pref, name), [])
        require(len(matches) == 1, f"交付税の名称が不一致/曖昧: {pref} {original}")
        code = matches[0]
        require(code not in statuses, f"交付税のコード重複: {code}")
        amount = whole_integer(cells.get("D"))
        require(amount is not None, f"普通交付税額が欠測: {code}")
        statuses[code] = "receiving" if amount > 0 else "non_receiving"
    missing = sorted(set(official) - set(statuses))
    require(not missing, f"交付税の結合欠落: {missing}")
    counts = {key: sum(s == key for s in statuses.values()) for key in ("receiving", "non_receiving", "tokyo_special_ward", "unknown")}
    return statuses, {"counts": counts, "aliases": aliases, "missingCodes": missing, "excludedSpecialWardRows": excluded,
                      "nonReceivingCodes": sorted(c for c, s in statuses.items() if s == "non_receiving")}


def add_cost_breakdowns(entities, receipts):
    missing_cells, incomplete, differences = [], [], []
    comparison_count = 0
    unknown_comparisons = []
    for entity in entities:
        code = entity["code"]
        row, cells = receipts[code]
        for field, columns, total_field in [
            ("solicitationCostBreakdown", "LMNOPQ", "solicitationCostYen"),
            ("portalCostBreakdown", "STUVWX", "portalCostYen"),
        ]:
            entity[field] = {key: yen(cells.get(col)) for key, col in zip(COST_KEYS, columns)}
            for key, col in zip(COST_KEYS, columns):
                if entity[field][key] is None:
                    missing_cells.append({"code": code, "cell": f"{col}{row}", "field": field, "key": key})
            if field == "portalCostBreakdown":
                entity["portalCostYen"] = yen(cells.get("Y"))
            total = entity[total_field]
            values = list(entity[field].values())
            if total is None or any(value is None for value in values):
                incomplete.append({"code": code, "field": field, "knownSumYen": sum(v for v in values if v is not None),
                                   "sourceTotalYen": total, "residualYen": None if total is None else total - sum(v for v in values if v is not None)})
            else:
                delta = sum(values) - total
                if field == "portalCostBreakdown":
                    require(delta == 0, f"ポータル内訳とYが不一致: {code} {delta}")
                elif delta:
                    differences.append({"code": code, "sumYen": sum(values), "sourceRYen": total, "deltaYen": delta})
        for key in COST_KEYS:
            total = entity["solicitationCostBreakdown"][key]
            portal = entity["portalCostBreakdown"][key]
            if total is None or portal is None:
                unknown_comparisons.append({"code": code, "key": key})
            else:
                require(portal <= total, f"ポータル内数が費用を超える: {code} {key}")
                comparison_count += 1
        if entity["portalCostYen"] is not None and entity["solicitationCostYen"] is not None:
            require(entity["portalCostYen"] <= entity["solicitationCostYen"], f"YがRを超える: {code}")
    return {"status": "incomplete" if incomplete or unknown_comparisons else "passed", "missingCells": missing_cells,
            "incompleteSums": incomplete, "unknownComparisons": unknown_comparisons,
            "verifiedComparisons": comparison_count, "roundingDifferences": differences}


def enrich_v2(entities, official, receipts, deductions, raw_dir):
    pop_rows = read_sheet(raw_dir / SOURCES["population"], POPULATION_SHEET)
    require("令和8年1月1日" in pop_rows[1].get("A", "") and "総計" in pop_rows[1]["A"], "人口の時点/総計が不一致")
    require(pop_rows[5].get("F") == "計" and pop_rows[6].get("F") == "人", "人口F列の定義変更")
    populations, pop_report = population_values(pop_rows, official)
    grant_rows = read_sheet(raw_dir / SOURCES["ordinaryGrant"], "R８")
    require("令和８年度" in grant_rows[2].get("A", "") and grant_rows[6].get("D") == "R８", "交付税の年度変更")
    require(grant_rows[5].get("D") == "普通交付税" and "千円" in grant_rows[4].get("E", ""), "交付税の列/単位変更")
    statuses, grant_report = ordinary_grant_statuses(grant_rows, official)
    require(grant_report["counts"] == {"receiving": 1678, "non_receiving": 87, "tokyo_special_ward": 23, "unknown": 0}, f"交付税の状態件数不一致: {grant_report['counts']}")
    require(len(grant_report["aliases"]) == 4 and len(grant_report["excludedSpecialWardRows"]) == 1, "交付税の字体差/特別区行の件数変更")
    users = {code: whole_integer(cells.get("BC")) for code, (_, cells) in deductions.items()}
    donations = {code: whole_integer(cells.get("BD")) for code, (_, cells) in deductions.items()}
    for entity in entities:
        code = entity["code"]
        entity["population"] = populations[code]
        entity["ordinaryGrantStatus"] = statuses[code]
        codes = [code] if entity["kind"] == "municipality" else [c for c in users if c[:2] == code[:2]]
        entity["deductionUserCount"] = sum_nullable(users[c] for c in codes)
        entity["deductionDonationAmountYen"] = sum_nullable(donations[c] for c in codes)
    costs = add_cost_breakdowns(entities, receipts)
    require({r["code"]: r["deltaYen"] for r in costs["roundingDifferences"]} == {"222151": 1, "272141": 1, "303411": 1}, "費用丸め差の対象/差額変更")
    user_total = sum_nullable(users.values())
    require(user_total == 11514115, f"BC全国合計が不一致: {user_total}")
    return {"population": pop_report, "ordinaryGrant": grant_report, "costs": costs,
            "deductions": {"municipalUserCount": user_total, "municipalDonationAmountYen": sum_nullable(donations.values())}}


def build_dataset(raw_dir=RAW):
    with localcontext() as context:
        context.prec = 50
        return _build_dataset(Path(raw_dir))


def _build_dataset(raw_dir):
    manifest = {}
    for line in (raw_dir / "SHA256SUMS").read_text().splitlines():
        digest, filename = line.split()
        require(filename not in manifest, f"SHA256SUMSの重複: {filename}")
        manifest[filename] = digest
    require(set(manifest) == set(SOURCES.values()) | {PRESS_FILE}, "SHA256SUMSの対象ファイル不一致")
    for filename, expected in manifest.items():
        digest = hashlib.sha256((raw_dir / filename).read_bytes()).hexdigest()
        require(digest == expected, f"SHA-256不一致: {filename}")
    sources = {}
    for key, filename in SOURCES.items():
        sources[key] = {"url": SOURCE_URLS[key], "retrievedOn": "2026-10-18", "sha256": manifest[filename]}
    receipt_rows = read_sheet(raw_dir / SOURCES["receipts"], "Sheet1")
    history_rows = read_sheet(raw_dir / SOURCES["history"], "各団体一覧")
    deduction_rows = read_sheet(raw_dir / SOURCES["deductions"], "集計表")
    official = official_entities(read_sheet(raw_dir / SOURCES["deductions"], "全国地方公共団体コード"))
    verify_headers(receipt_rows, history_rows, deduction_rows)
    receipts = index_rows(receipt_rows, 14, ("D", "E", "K", "R"))
    aggregate_labels = {e["prefName"] + "集計" for e in official.values() if e["kind"] == "prefecture"} | {"総計"}
    deductions = index_rows(deduction_rows, 19, ("BE", "BH"), aggregate_labels)
    excluded_aggregates = [{"row": row, "label": cells["B"]} for row, cells in deduction_rows.items() if not cells.get("A") and cells.get("B") in aggregate_labels and not cells.get("C")]
    require(len(excluded_aggregates) == 48 and {r["label"] for r in excluded_aggregates} == aggregate_labels, "控除集計行の欠落/重複")
    municipal_codes = {c for c, e in official.items() if e["kind"] == "municipality"}
    joins = {
        "receiptMissingCodes": sorted(set(official) - set(receipts)),
        "receiptExtraCodes": sorted(set(receipts) - set(official)),
        "deductionMissingCodes": sorted(municipal_codes - set(deductions)),
        "deductionExtraCodes": sorted(set(deductions) - municipal_codes),
    }
    require(not any(joins.values()), f"結合の欠落/余剰: {joins}")
    counts = dict(Counter(e["kind"] for e in official.values()))
    require(counts == {"prefecture": 47, "municipality": 1741}, f"団体数不一致: {counts}")
    be, bh = {}, {}
    for code, (_, cells) in deductions.items():
        require(cells.get("B") == official[code]["prefName"] and cells.get("C") == official[code]["name"], f"控除の名称/所属不一致: {code}")
        be[code], bh[code] = yen(cells.get("BE")), yen(cells.get("BH"))
    entities = []
    for code, identity in sorted(official.items()):
        deduction = be[code] if identity["kind"] == "municipality" else sum_nullable(bh[c] for c in sorted(bh) if c[:2] == code[:2])
        entities.append(make_entity(identity, receipts[code][1], deduction))
    history_report = assign_histories(entities, history_rows)
    mismatches, incomplete = [], []
    for entity in entities:
        if entity["history"] is None:
            continue
        last = entity["history"][-1]["receiptAmountYen"]
        if last is None or entity["receiptAmountYen"] is None:
            incomplete.append(entity["code"])
        elif last != entity["receiptAmountYen"]:
            mismatches.append({"code": entity["code"], "historyYen": last, "receiptYen": entity["receiptAmountYen"]})
    history_report.update({"r7Mismatches": mismatches, "r7IncompleteCodes": incomplete})
    require(not mismatches and not incomplete, f"R7推移照合未達: {history_report}")
    v2_report = enrich_v2(entities, official, receipts, deductions, raw_dir)
    data = {"metadata": {
        "schemaVersion": 2,
        "sources": sources, "units": {"money": "JPY", "count": "件", "population": "人", "taxpayer": "人"},
        "periods": {"receipts": "令和7年度（2025-04-01～2026-03-31）の決算見込", "history": "平成20～令和7年度（2008～2025年度）", "deductions": "令和8年度課税（2026-06-01時点、推計値含む）", "population": "令和8年1月1日（2026-01-01）現在の住民基本台帳人口（総計）", "ordinaryGrant": "令和8年度当初の普通交付税（2026-07-24決定）"},
        "rounding": "ROUND_HALF_UP",
        "notes": {
            "periodMismatch": "受入額・募集費用は令和7年度決算見込、住民税控除額は令和8年度課税（推計値含む）で、対象期間が異なります。",
            "excludedAdjustments": "差額には地方交付税・所得税控除を含みません。実際の損益を示すものではありません。",
            "attribution": "出典：総務省「ふるさと納税に関する現況調査結果」（2026年7月31日公表、公共データ利用規約1.0）。掲載Excelを加工し、円単位への換算・丸め・県別控除集計・差額計算を行っています。人口：e-Stat「住民基本台帳に基づく人口、人口動態及び世帯数」26-03【総計】市区町村別（2026年1月1日現在、政府標準利用規約2.0）を加工。普通交付税の状態：総務省「令和８年度 市町村別普通交付税決定額」「令和８年度普通交付税大綱」（公共データ利用規約1.0）を加工し、字体差の対応と都区の分類を行っています。",
        },
    }, "entities": entities}
    rounding = {}
    for label, column, table, rounded in [
        ("municipalTax", "BE", deductions, sum_nullable(be.values())),
        ("prefecturalTax", "BH", deductions, sum_nullable(e["residentTaxDeductionYen"] for e in entities if e["kind"] == "prefecture")),
        ("solicitationCost", "R", receipts, sum_nullable(e["solicitationCostYen"] for e in entities)),
    ]:
        original = [decimal_value(cells.get(column)) for _, cells in table.values()]
        total = sum_nullable(original)
        delta = None if total is None or rounded is None else Decimal(rounded) - total
        limit = Decimal(len(table)) / 2
        require(delta is None or abs(delta) <= limit, f"丸め差が許容範囲外: {label}")
        rounding[label] = {"rawSumYen": str(total) if total is not None else None, "jsonSumYen": rounded, "deltaYen": str(delta) if delta is not None else None, "toleranceYen": str(limit)}
    fractional_costs = [{"code": code, "cell": f"R{row}", "rawYen": cells["R"], "jsonYen": yen(cells["R"])} for code, (row, cells) in sorted(receipts.items()) if decimal_value(cells.get("R")) is not None and Decimal(cells["R"]) != Decimal(cells["R"]).to_integral_value()]
    sums = {field: sum_nullable(e[field] for e in entities) for field in ("receiptAmountYen", "receiptCount", "proxyReceiptAmountYen", "solicitationCostYen", "residentTaxDeductionYen")}
    report = {
        "v2": v2_report,
        "counts": {"entities": len(entities), **counts, "deductions": len(deductions)},
        "joins": joins, "history": history_report, "rounding": rounding,
        "excludedDeductionAggregates": excluded_aggregates,
        "fractionalCosts": fractional_costs, "sums": sums,
        "missingValues": {field: sum(e[field] is None for e in entities) for field in ("receiptAmountYen", "receiptCount", "proxyReceiptAmountYen", "solicitationCostYen", "residentTaxDeductionYen", "primaryBalanceYen", "referenceBalanceYen", "history")},
        "proxyReceiptPositiveCodes": [e["code"] for e in entities if e["proxyReceiptAmountYen"] is not None and e["proxyReceiptAmountYen"] > 0],
        "trendNationalR7Yen": yen(history_rows[1887]["AK"], 1000),
        "representatives": [e for e in entities if e["code"] in ("010006", "011002", "131121", "272132")],
    }
    require(report["trendNationalR7Yen"] == sums["receiptAmountYen"], "推移Excel全国合計との不一致")
    schema = json.loads((ROOT / "schema/furusato.schema.json").read_text())
    validate(data, schema)
    return data, report


def compact_json(data):
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def main():
    data, report = build_dataset()
    content = compact_json(data)
    report["outputBytes"] = len(content)
    report["gzipBytes"] = len(gzip.compress(content, mtime=0))
    output = ROOT / "public/data/furusato.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(content)
    (ROOT / "data-pipeline/validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(data['entities'])}団体、{len(content):,} bytes（gzip {report['gzipBytes']:,} bytes）、Schema検証成功。全国の報道資料照合はdocs/data.mdを参照。")
    if report["v2"]["costs"]["status"] == "incomplete":
        print("費用の全件受入は未達：原票の空欄をnullで保持。検算不能の一覧はvalidation.jsonとdocs/data.mdを参照。")


if __name__ == "__main__":
    main()
