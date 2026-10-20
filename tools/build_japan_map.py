"""都道府県の大まかな形を、クリックできる SVG の path にして src/japan-map.json に書き出す。

元データ: jpn-atlas 1.0.2（BSD-3-Clause）の japan.json。もとは国土地理院「地球地図日本」（2016年・国土地理院コンテンツ利用規約）。
すでに投影・簡略化された TopoJSON（850×680 の画面座標）を、さらに大まかにする:
  - 線を間引く（Douglas–Peucker）
  - 小さな島を落とす（各都道府県のいちばん大きな形は必ず残す）
  - 沖縄県は左上の枠に寄せる
使い方: python3 tools/build_japan_map.py（標準ライブラリだけ）
"""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "tools/raw/jpn-atlas-1.0.2-japan.json"
OUT = ROOT / "src/japan-map.json"
MUNI_DIR = ROOT / "public/map"  # 都道府県ごとの市区町村の形（県のページで読み込む）
DATA = ROOT / "public/data/furusato.json"
# 県の地図の外に名前で並べる、本土から大きく離れた島の市町村（5桁コード: 名前）
FAR_ISLANDS = {
    "13361": "大島町", "13362": "利島村", "13363": "新島村", "13364": "神津島村", "13381": "三宅村",
    "13382": "御蔵島村", "13401": "八丈町", "13402": "青ヶ島村", "13421": "小笠原村",
    "47207": "石垣市", "47214": "宮古島市", "47357": "南大東村", "47358": "北大東村", "47375": "多良間村",
    "47381": "竹富町", "47382": "与那国町",
    "46222": "奄美市", "46304": "十島村", "46523": "大和村", "46524": "宇検村", "46525": "瀬戸内町",
    "46527": "龍郷町", "46529": "喜界町", "46530": "徳之島町", "46531": "天城町", "46532": "伊仙町",
    "46533": "和泊町", "46534": "知名町", "46535": "与論町",
}
# 地図（2016年）の後に市制施行・コード変更した団体の読み替え（地図のコード → 今のコード5桁）
RECODE = {"03305": "03216", "04423": "04216", "11445": "11246", "12402": "12239",
          "17344": "17212", "23304": "23238", "40305": "40231", "43201": "43100"}

PREFS = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
    "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
    "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
    "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
]
TOLERANCE = 1.1  # 線を間引く許容幅（画面座標の px）
MIN_ISLAND = 18.0  # これより小さい島（px²）は落とす
OKINAWA_SHIFT = (172.5, -326.0)  # 沖縄県を石川県の西（日本海の空き）の枠へ動かす量
OKINAWA_SCALE = 3.0
OKINAWA_NEAR = 25.0  # 本島からこの距離（px）より遠い島は全国地図では描かない


def decode_arcs(topo):
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)
    return arcs


def ring(arcs, indexes):
    pts = []
    for i in indexes:
        a = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts.extend(a if not pts else a[1:])
    return pts


def area(pts):
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]))) / 2


def simplify(pts, tol):
    if len(pts) < 4:
        return pts

    def dp(seg):
        (x1, y1), (x2, y2) = seg[0], seg[-1]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-9
        far, idx = 0.0, 0
        for i in range(1, len(seg) - 1):
            x0, y0 = seg[i]
            d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / norm
            if d > far:
                far, idx = d, i
        if far <= tol:
            return [seg[0], seg[-1]]
        return dp(seg[: idx + 1])[:-1] + dp(seg[idx:])

    # 閉じた形は、いちばん離れた2点で分けてから間引く
    far_i = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
    out = dp(pts[: far_i + 1])[:-1] + dp(pts[far_i:] + [pts[0]])[:-1]
    return out if len(out) >= 3 else pts


def centroid(pts):
    return sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts)


def path_d(rings):
    return "".join("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in r) + "Z" for r in rings)


def municipalities(topo, arcs):
    """都道府県ごとに、市区町村の形と今の6桁コードを書き出す。今のデータにない区域（北方領土など）は code なしで灰色に描く。"""
    entities = json.loads(DATA.read_text())["entities"]
    current = {e["code"][:5]: e for e in entities if e["kind"] == "municipality"}
    groups = {}
    for g in topo["objects"]["municipalities"]["geometries"]:
        groups.setdefault(g["id"], []).append(g)
    by_pref = {}
    matched = set()
    for atlas_id, geoms in groups.items():
        code5 = RECODE.get(atlas_id, atlas_id)
        e = current.get(code5)
        if e:
            matched.add(code5)
        polys = []
        for g in geoms:
            polys.extend(g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]])
        by_pref.setdefault(int(atlas_id[:2]), []).append((e, [ring(arcs, p[0]) for p in polys]))
    wrong = {c: n for c, n in FAR_ISLANDS.items() if current.get(c, {}).get("name") != n}
    assert not wrong, f"離れた島の一覧とデータの名前が合わない: {wrong}"
    missing = sorted(set(current) - matched)
    assert not missing, f"地図に形のない市区町村: {missing}"
    MUNI_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    for pref_code, items in sorted(by_pref.items()):
        # 本土から大きく離れた島（東京の島しょ部・沖縄の先島など）は地図の外に出し、名前のボタンで並べる。
        # 距離で自動判定すると本土の市町村まで外れる（京都府北部など）ので、決めた一覧で外す
        far = [bool(e) and e["code"][:5] in FAR_ISLANDS for e, _ in items]
        core = [it for it, f in zip(items, far) if not f]
        xs = [x for _, rings in core for r in rings for x, _ in r]
        ys = [y for _, rings in core for r in rings for _, y in r]
        size = max(max(xs) - min(xs), max(ys) - min(ys))
        tol = size / 700  # 県の大きさに合わせて間引く
        min_island = (size / 140) ** 2
        shapes = []
        outside = [{"code": e["code"], "name": e["name"]} for (e, _), f in zip(items, far) if f and e]
        for e, rings in core:
            rings.sort(key=area, reverse=True)
            keep = [rings[0]] + [r for r in rings[1:] if area(r) >= min_island]
            shapes.append({"code": e["code"] if e else None, "name": e["name"] if e else None,
                           "d": path_d([simplify(r, tol) for r in keep])})
        pad = size * 0.02
        view = [round(min(xs) - pad, 1), round(min(ys) - pad, 1), round(max(xs) - min(xs) + pad * 2, 1), round(max(ys) - min(ys) + pad * 2, 1)]
        out = MUNI_DIR / f"{pref_code:02d}.json"
        out.write_text(json.dumps({"viewBox": view, "shapes": shapes, "outside": outside}, ensure_ascii=False, separators=(",", ":")) + "\n")
        total += out.stat().st_size
    print(f"public/map/: 47ファイル {total:,} bytes、今のデータの市区町村 {len(matched)} / {len(current)} を地図に対応")


def main():
    topo = json.loads(RAW.read_text())
    arcs = decode_arcs(topo)
    municipalities(topo, arcs)
    prefs = []
    for g in topo["objects"]["prefectures"]["geometries"]:
        code = int(g["id"])
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        outer = [ring(arcs, p[0]) for p in polys]  # 穴（湖など）は大まかな地図では描かない
        outer.sort(key=area, reverse=True)
        keep = [outer[0]] + [r for r in outer[1:] if area(r) >= MIN_ISLAND]
        rings = [simplify(r, TOLERANCE) for r in keep]
        if code == 47:
            # 沖縄県は石川県の西の枠へ動かし、小さすぎて見えないので本島のまわりだけ残して拡大する
            # （先島・大東の島々は県のページの地図で見られる）
            ox, oy = centroid(rings[0])
            rings = [r for r in rings if ((centroid(r)[0] - ox) ** 2 + (centroid(r)[1] - oy) ** 2) ** 0.5 < OKINAWA_NEAR]
            rings = [[((x - ox) * OKINAWA_SCALE + ox + OKINAWA_SHIFT[0], (y - oy) * OKINAWA_SCALE + oy + OKINAWA_SHIFT[1]) for x, y in r] for r in rings]
        xs = [x for r in rings for x, _ in r]
        ys = [y for r in rings for _, y in r]
        main_ring = rings[0]
        cx = sum(x for x, _ in main_ring) / len(main_ring)
        cy = sum(y for _, y in main_ring) / len(main_ring)
        prefs.append({"code": code, "name": PREFS[code - 1], "d": path_d(rings), "cx": round(cx, 1), "cy": round(cy, 1),
                      "bbox": [round(min(xs), 1), round(min(ys), 1), round(max(xs), 1), round(max(ys), 1)]})
    assert sorted(p["code"] for p in prefs) == list(range(1, 48)), "都道府県が47そろっていない"
    prefs.sort(key=lambda p: p["code"])
    allx = [v for p in prefs for v in (p["bbox"][0], p["bbox"][2])]
    ally = [v for p in prefs for v in (p["bbox"][1], p["bbox"][3])]
    pad = 6
    view = [round(min(allx) - pad), round(min(ally) - pad), round(max(allx) - min(allx) + pad * 2), round(max(ally) - min(ally) + pad * 2)]
    ok = prefs[46]["bbox"]
    frame = [ok[0] - 8, ok[1] - 8, ok[2] - ok[0] + 16, ok[3] - ok[1] + 16]
    # 沖縄の枠も画面に入るよう広げる
    x0, y0 = min(view[0], frame[0] - pad), min(view[1], frame[1] - pad)
    view = [round(x0), round(y0), round(view[0] + view[2] - x0), round(view[1] + view[3] - y0)]
    data = {
        "viewBox": view,
        "okinawaFrame": [round(v, 1) for v in frame],
        "source": {
            "file": RAW.name,
            "sha256": hashlib.sha256(RAW.read_bytes()).hexdigest(),
            "credit": "地図: 国土地理院「地球地図日本」（2016年）を jpn-atlas（BSD-3-Clause）経由で加工して作成",
        },
        "prefectures": prefs,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size:,} bytes, viewBox {view}")


if __name__ == "__main__":
    main()
