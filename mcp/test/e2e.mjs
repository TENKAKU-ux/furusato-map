// stdio サーバーの e2e。公式クライアント SDK で 2026-07-28 と 2025-11-25、生の JSON-RPC で 2025-06-18 を確かめる。
// 使い方: node test/e2e.mjs [サーバーの server.mjs] [起動に使う cwd]
// 環境変数 E2E_WRAP に JSON の配列（例: ["strace","-f","-o","log"]）を渡すと、サーバーをそのコマンド越しに起動する。
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const server = process.argv[2] ?? fileURLToPath(new URL("../dist/server.mjs", import.meta.url));
const cwd = process.argv[3] ?? process.cwd();
const wrap = JSON.parse(process.env.E2E_WRAP ?? "[]");
const command = wrap[0] ?? process.execPath;
const args = [...wrap.slice(1), ...(wrap.length ? [process.execPath] : []), server];
const NAMES = [
  "furusato_get_overview",
  "furusato_search_entities",
  "furusato_get_entity",
  "furusato_compare_entities",
  "furusato_list_entities",
  "furusato_get_ranking",
  "furusato_explain_term",
];
const CALLS = [
  ["furusato_get_overview", {}],
  ["furusato_search_entities", { query: "泉佐野" }],
  ["furusato_get_entity", { code: "272132" }],
  ["furusato_compare_entities", { codes: ["272132", "131121"] }],
  ["furusato_list_entities", { kind: "municipality", prefName: "北海道", offset: 100, limit: 100 }],
  ["furusato_get_ranking", { kind: "municipality", metric: "receiptAmountYen", order: "desc", mode: "total", limit: 3 }],
  ["furusato_explain_term", { term: "balance" }],
];
const BAD_CALLS = [
  ["furusato_get_entity", { code: "999999" }],
  ["furusato_get_entity", { code: "abc" }],
  ["furusato_compare_entities", { codes: ["272132", "130001"] }],
];
let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

function checkData(name, sc) {
  const d = sc.data;
  if (name === "furusato_get_overview") {
    const v = Object.fromEntries(d.nationalTotals.values.map((x) => [x.key, x.value]));
    ok(v.receiptAmountYen === 1331428336499 && v.residentTaxDeductionYen === 952441869261, "全国計");
    ok(/^[0-9a-f]{64}$/.test(d.dataset.sha256) && typeof d.dataset.serverVersion === "string", "データの識別子");
  }
  if (name === "furusato_search_entities") ok(d.results[0].code === "272132", "検索");
  if (name === "furusato_get_entity") ok(d.entity.receiptAmountYen === 23038604299 && d.url === "https://tenkaku-ux.github.io/furusato-map/#272132", "取得");
  if (name === "furusato_compare_entities") ok(d.items.length === 2 && !("history" in d.items[0].entity), "比較");
  if (name === "furusato_list_entities") ok(d.total === 179 && d.rows.length === 79 && d.hasMore === false, "一覧");
  if (name === "furusato_get_ranking") ok(d.rows[0].code === "272132" && d.rows.length === 3, "順位");
  if (name === "furusato_explain_term") ok(d.title === "差額", "用語");
  ok(sc.metadata.notes.join("").includes("損益を示すものではありません") && Object.keys(sc.metadata.sources).length === 6, `${name}: 注記と出典`);
}

async function viaClient(label, options) {
  const client = new Client({ name: "furusato-e2e", version: "0.0.0" }, options);
  const transport = new StdioClientTransport({ command, args, cwd, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (b) => (stderr += b));
  await client.connect(transport);
  const version = client.getNegotiatedProtocolVersion?.() ?? null;
  ok(client.getInstructions()?.includes("損益を示すものではありません"), `${label}: instructions`);
  const { tools } = await client.listTools();
  ok(JSON.stringify(tools.map((t) => t.name)) === JSON.stringify(NAMES), `${label}: ツール一覧`);
  ok(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.openWorldHint === false), `${label}: readOnlyHint`);
  for (const [name, args] of CALLS) {
    const r = await client.callTool({ name, arguments: args });
    ok(r.isError !== true && r.structuredContent?.ok === true, `${label}: ${name} が成功`);
    ok(JSON.stringify(JSON.parse(r.content[0].text)) === JSON.stringify(r.structuredContent), `${label}: ${name} の content と structuredContent が同じ`);
    checkData(name, r.structuredContent);
  }
  for (const [name, args] of BAD_CALLS) {
    let r;
    try {
      r = await client.callTool({ name, arguments: args });
    } catch (e) {
      r = { thrown: e };
    }
    ok(r.thrown !== undefined || r.isError === true, `${label}: ${name} ${JSON.stringify(args)} は誤り`);
  }
  const { resources } = await client.listResources();
  ok(JSON.stringify(resources.map((r) => r.uri).sort()) === JSON.stringify(["furusato://glossary", "furusato://guide", "furusato://metadata"]), `${label}: resources`);
  for (const r of resources) {
    const { contents } = await client.readResource({ uri: r.uri });
    ok(contents[0].text.length > 100, `${label}: ${r.uri} を読める`);
  }
  await client.close();
  ok(stderr === "", `${label}: stderr に何も出ない（${JSON.stringify(stderr.slice(0, 200))}）`);
  return version;
}

/** 生の JSON-RPC で、initialize を使う旧い版を確かめる。stdout の全行が JSON-RPC であることも見る。 */
function viaRaw(protocolVersion) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    const pending = new Map();
    child.stderr.on("data", (b) => (stderr += b));
    child.stdout.on("data", (b) => {
      buf += b;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          reject(new Error(`stdout に JSON でない行: ${line.slice(0, 200)}`));
          return;
        }
        ok(msg.jsonrpc === "2.0", "stdout は JSON-RPC だけ");
        pending.get(msg.id)?.(msg);
      }
    });
    let id = 0;
    const call = (method, params) =>
      new Promise((res) => {
        const myId = ++id;
        pending.set(myId, res);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      });
    (async () => {
      const init = await call("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "raw", version: "0" } });
      ok(init.result?.protocolVersion === protocolVersion, `raw ${protocolVersion}: initialize（${init.result?.protocolVersion}）`);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const list = await call("tools/list", {});
      ok(list.result.tools.length === NAMES.length, `raw ${protocolVersion}: tools/list`);
      const got = await call("tools/call", { name: "furusato_get_entity", arguments: { code: "272132" } });
      ok(got.result.structuredContent.data.entity.code === "272132", `raw ${protocolVersion}: tools/call`);
      const res = await call("resources/read", { uri: "furusato://guide" });
      ok(res.result.contents[0].text.includes("ふるさと納税マップ"), `raw ${protocolVersion}: resources/read`);
      child.stdin.end();
      child.on("close", () => {
        ok(stderr === "", `raw ${protocolVersion}: stderr に何も出ない`);
        resolve();
      });
    })().catch(reject);
  });
}

const modern = await viaClient("2026-07-28", { versionNegotiation: { mode: { pin: "2026-07-28" } } });
ok(modern === "2026-07-28", `現行版で話した（${modern}）`);
const legacy = await viaClient("legacy", undefined);
ok(legacy === "2025-11-25", `旧い版（initialize）で話した（${legacy}）`);
await viaRaw("2025-06-18");
console.log(`e2e: ${checks} 項目すべて合格（server=${server}, cwd=${cwd}, node=${process.version}）`);
