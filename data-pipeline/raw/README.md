# 元データ（原本）

原本はこのリポジトリに含めていません。データを作り直すときは、次の公開元から取得してこのフォルダに置き、`sha256sum -c SHA256SUMS` で取得時と同じファイルか確かめてから `python3 data-pipeline/build.py` を実行してください。

| ファイル名 | 取得元 |
| --- | --- |
| 001084989.xlsx | https://www.soumu.go.jp/main_content/001084989.xlsx |
| 001084990.xlsx | https://www.soumu.go.jp/main_content/001084990.xlsx |
| 001085012.xlsx | https://www.soumu.go.jp/main_content/001085012.xlsx |
| press_001085011.pdf | https://www.soumu.go.jp/main_content/001085011.pdf |
| ordinary_grant_001083404.xlsx | https://www.soumu.go.jp/main_content/001083404.xlsx |
| ordinary_grant_summary_001083397.pdf | https://www.soumu.go.jp/main_content/001083397.pdf |
| population_26-03_2026.xlsx | https://www.e-stat.go.jp/stat-search/file-download?fileKind=0&statInfId=000040479049 |

公開元がファイルを差し替えた場合は、ハッシュが一致しません。
