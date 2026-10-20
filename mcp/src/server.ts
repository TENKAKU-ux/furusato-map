#!/usr/bin/env node
// ふるさと納税マップの stdio MCP サーバー。ツールの中身はサイトの WebMCP と同じ（src/agent-tools.ts）。
// 同梱のデータを読むだけで、実行中にネットワークへ出ない・ファイルを書かない・子プロセスを起動しない。
// stdout はプロトコル専用なので、ここから console.log を使わない。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { FurusatoData } from "../../src/data-contract";
import { createAgentTools, type ToolResult } from "../../src/agent-tools";
import { GLOSSARY } from "../../src/glossary";

const SITE_URL = "https://tenkaku-ux.github.io/furusato-map/";

const raw = readFileSync(new URL("../data/furusato.json", import.meta.url));
const data = JSON.parse(raw.toString("utf8")) as FurusatoData;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const tools = createAgentTools(data, SITE_URL, { datasetSha256: createHash("sha256").update(raw).digest("hex"), serverVersion: version });

const INSTRUCTIONS = [
  "日本の自治体ごとのふるさと納税（受入額・募集費用・住民税控除額・差額・人口・普通交付税の状態など）を、総務省などの公表値を加工したデータで返す読み取り専用のサーバーです。個人が作成した非公式のもので、総務省とは関係ありません。",
  "最初に furusato_get_overview で使い分けと時点を確かめ、名前から団体コードを furusato_search_entities で探してから、furusato_get_entity・furusato_compare_entities で数値を取ってください。順位は furusato_get_ranking、全件は furusato_list_entities、用語は furusato_explain_term です。",
  "差額は地方交付税・所得税の控除を含まず、受入と控除で年度も違うので、損益を示すものではありません。結果を人に示すときは、metadata.attribution の出典と、加工したことを書いてください。",
].join("\n");

const guide = (): string => {
  const m = data.metadata;
  return [
    "# ふるさと納税マップのデータ",
    "",
    `サイト: ${SITE_URL}`,
    "",
    "自治体ごとのふるさと納税の受入額・募集費用・住民税控除額などを、総務省などの公表値を加工してまとめたデータです。個人が作成した非公式のもので、総務省・国土地理院とは関係ありません。",
    "",
    "## 時点",
    ...Object.entries(m.periods).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## 読み方",
    "- 金額は円の整数、人数・件数は整数です。null は元の表で空欄・欠測であることを表し、0 ではありません。",
    "- 差額（primaryBalanceYen）＝受入額−住民税控除額、参考差額（referenceBalanceYen）＝さらに募集費用も引いた額です。",
    `- ${m.notes.periodMismatch}`,
    `- ${m.notes.excludedAdjustments}`,
    "- 都道府県の値は、都道府県自身への寄附の受入額と、県内の市区町村から集計した道府県民税の控除額です。県内の市区町村への寄附は含みません。",
    "- 団体コードは先頭の0を含む6桁の文字列です。",
    "",
    "## ツール",
    ...tools.map((t) => `- ${t.name}: ${t.description}`),
    "",
    "## 出典",
    m.notes.attribution,
    "",
    "使うときは、出典と加工したことを書いてください（総務省のデータは公共データ利用規約 第1.0版、e-Stat の人口は政府標準利用規約 第2.0版）。",
    "",
  ].join("\n");
};

const toCallResult = (r: ToolResult) => ({
  content: [{ type: "text" as const, text: JSON.stringify(r) }],
  structuredContent: r as unknown as Record<string, unknown>,
  isError: !r.ok,
});

function createServer(): McpServer {
  const server = new McpServer({ name: "furusato-map", title: "ふるさと納税マップ", version }, { instructions: INSTRUCTIONS });
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: fromJsonSchema(t.inputSchema as never), annotations: { title: t.title, ...t.annotations, openWorldHint: false } },
      async (input: unknown) => toCallResult(t.execute(input ?? {})),
    );
  }
  const text = (uri: URL, mimeType: string, body: string) => ({ contents: [{ uri: uri.href, mimeType, text: body }] });
  server.registerResource("guide", "furusato://guide", { title: "データの説明", description: "時点・読み方・ツール・出典", mimeType: "text/markdown" }, (uri: URL) =>
    text(uri, "text/markdown", guide()),
  );
  server.registerResource("glossary", "furusato://glossary", { title: "用語集", description: "用語の意味と見方", mimeType: "application/json" }, (uri: URL) =>
    text(uri, "application/json", JSON.stringify(GLOSSARY)),
  );
  server.registerResource("metadata", "furusato://metadata", { title: "時点・出典・注記", description: "結果に毎回付く metadata と同じもの", mimeType: "application/json" }, (uri: URL) => {
    const r = tools.find((t) => t.name === "furusato_get_overview")!.execute({});
    return text(uri, "application/json", JSON.stringify(r.ok ? r.metadata : null));
  });
  return server;
}

// エラーの本文は問い合わせの中身を含みうるので、種類だけを stderr に出す。
serveStdio(createServer, { onerror: (e) => console.error(`furusato-map-mcp: ${e.name}`) });
