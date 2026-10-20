# furusato-map-mcp

日本の自治体ごとのふるさと納税（受入額・募集費用・住民税控除額・差額・人口・普通交付税の状態・受入額の推移など）を、AI エージェントから調べられる MCP サーバーです。[ふるさと納税マップ](https://tenkaku-ux.github.io/furusato-map/)と同じデータ（都道府県47・市区町村1,741）を同梱しています。

個人が作成した非公式のもので、総務省とは関係ありません。差額は地方交付税・所得税の控除を含まず、実際の損益を示すものではありません。

## 入れ方

Node.js 20 以上と git が要ります。今は npm には公開していないので、GitHub から取ってきて、自分の PC でビルドします。

```sh
git clone https://github.com/TENKAKU-ux/furusato-map.git
cd furusato-map/mcp
npm ci
npm run build
```

できた `dist/server.mjs` を、使うエージェントに登録します。下の例の `/path/to/furusato-map` は、clone した場所の絶対パスに置き換えてください。

**Claude Code**（`furusato-map/mcp` の中で）

```sh
claude mcp add --scope user furusato-map -- node "$PWD/dist/server.mjs"
```

**Codex**（`~/.codex/config.toml`）

```toml
[mcp_servers.furusato-map]
command = "node"
args = ["/path/to/furusato-map/mcp/dist/server.mjs"]
```

**Claude Desktop・Cursor など**（設定の JSON）

```json
{
  "mcpServers": {
    "furusato-map": { "command": "node", "args": ["/path/to/furusato-map/mcp/dist/server.mjs"] }
  }
}
```

ビルドのときだけ、npm から依存（MCP の SDK とビルド用の道具）を取ってきます。起動したあとのサーバーは、同梱のデータを読むだけで、ネットワークへの接続・ファイルの書き込み・ほかのプログラムの起動をしません。新しい版が出たら、`git pull` してから `npm ci` と `npm run build` をやり直してください。

## できること

ツールはすべて読み取り専用です。

| ツール | 使いどころ |
| --- | --- |
| `furusato_get_overview` | 最初に呼ぶ入口。使い分け・指標の意味と単位・時点・全国計・データの版 |
| `furusato_search_entities` | 名前（「世田谷」など）から団体コードを探す |
| `furusato_get_entity` | 1つの自治体の数値と推移（人口1人あたりなどの計算値つき） |
| `furusato_compare_entities` | 2〜10の自治体を並べて比べる（同じ区分どうし） |
| `furusato_get_ranking` | 受入額・住民税控除額・差額・参考差額の順位（総額か人口1人あたり、全国か県内） |
| `furusato_list_entities` | 全国または県内の自治体を全部、ページに分けて取る |
| `furusato_explain_term` | 用語（差額・募集費用・普通交付税など）の意味と見方 |

読み物（resources）として `furusato://guide`（データの説明）・`furusato://glossary`（用語集）・`furusato://metadata`（時点・出典・注記）もあります。

結果は `{ok: true, data, metadata}` か `{ok: false, error: {code, message}}` の JSON です（入力の形が入力スキーマに合わないときは、MCP の SDK の検証エラーが `isError: true` で返ります）。`metadata` に単位・時点・注記・出典が毎回付きます。金額は円の整数で、欠測は `null`（0 ではありません）です。

聞き方の例:

- 「泉佐野市のふるさと納税の受入額と募集費用を教えて」
- 「東京都の市区町村で、住民税控除額が大きい順に5つ」
- 「北海道の市町村を人口1人あたりの受入額で並べて」

## データ

受入額・募集費用は令和7年度の決算見込、住民税控除額は令和8年度課税（推計値を含む）で、期間が異なります。公表資料から作った固定のデータで、自動では更新されません（新しい資料が出たら、版を上げて出し直します）。

出典と利用条件は [DATA-LICENSE.md](DATA-LICENSE.md) にあります。結果を人に示すときは、出典と加工したことを書いてください。

## ライセンス

コードは MIT（[LICENSE](LICENSE)）です。同梱データは出典の利用条件に従います（[DATA-LICENSE.md](DATA-LICENSE.md)）。

ソース: <https://github.com/TENKAKU-ux/furusato-map>（`mcp/`）
