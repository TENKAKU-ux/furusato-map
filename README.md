# ふるさと納税マップ

自治体ごとのふるさと納税の受入額・募集費用・住民税控除額を、総務省の公表値で確かめられる静的な Web サイトです。

https://tenkaku-ux.github.io/furusato-map/

個人が作成した非公式のサイトで、総務省・国土地理院とは関係ありません。差額は地方交付税や所得税の控除を含まないため、実際の損益を示すものではありません。

## 出典

- 総務省「ふるさと納税に関する現況調査結果」（2026年7月31日公表）を加工して作成（公共データ利用規約 第1.0版）
- 政府統計の総合窓口（e-Stat）「住民基本台帳に基づく人口、人口動態及び世帯数」（令和8年1月1日現在）を加工して作成（政府標準利用規約 第2.0版）
- 総務省「令和8年度 市町村別普通交付税決定額」「令和8年度普通交付税大綱」を加工して作成
- 国土地理院「地球地図日本」を、[jpn-atlas](https://github.com/biskwikman/jpn-atlas)（BSD 3-Clause License）経由で加工して作成（`public/licenses/`）
- フォント BIZ UDPGothic（SIL Open Font License 1.1、`tools/fonts/OFL.txt`）

列の対応・丸め・検証の記録は [docs/data.md](docs/data.md) にあります。

## エージェントから使う

- **WebMCP**: [WebMCP](https://webmachinelearning.github.io/webmcp/)（`document.modelContext`）に対応したブラウザでは、ページを開くと読み取り専用のツール `furusato_search_entities`・`furusato_get_entity`・`furusato_get_ranking` が登録されます（`src/agent-tools.ts`）。WebMCP はまだドラフトの実験的な API です。Chrome 154 で `--enable-features=WebMCP` を付けて、登録・発見・実行まで確かめています。
- **静的なデータ**: ブラウザの外からは `data/furusato.json` をそのまま読めます。項目の意味と注記は [`llms.txt`](public/llms.txt) にあります。

## 動かす

```sh
npm ci
npm run dev      # 開発用サーバー
npm test         # テスト
npm run build    # dist/ に出力（SITE_URL を付けると共有カードも作る）
```

`main` に push すると、GitHub Actions がビルドして GitHub Pages に公開します（`.github/workflows/pages.yml`）。

データを作り直す手順は [data-pipeline/README.md](data-pipeline/README.md) と [data-pipeline/raw/README.md](data-pipeline/raw/README.md) にあります（Python 3.10 以上、標準ライブラリのみ）。
