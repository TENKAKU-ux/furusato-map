// WebMCP（document.modelContext）にツールを登録する。対応していないブラウザでは何もしない。
// 仕様はまだドラフトなので、登録に失敗しても画面には影響させず、警告だけ残す。
import type { AgentTool } from "./agent-tools";

interface ModelContextLike {
  registerTool(tool: object, options?: { signal?: AbortSignal }): unknown;
}

const registered = new WeakMap<object, AbortController>();

/**
 * ツールをまとめて登録する。途中で失敗したら、それまでに登録した分も外す。
 * mc は document.modelContext。同じ modelContext に2回呼んでも、2回目は何もしない。登録できたら解除用の AbortController を返す。
 */
export async function registerAgentTools(tools: AgentTool[], mc: unknown): Promise<AbortController | null> {
  if (typeof mc !== "object" || mc === null || typeof (mc as ModelContextLike).registerTool !== "function") return null;
  if (registered.has(mc)) return null;
  const ac = new AbortController();
  registered.set(mc, ac);
  ac.signal.addEventListener("abort", () => registered.delete(mc));
  try {
    for (const t of tools) {
      await (mc as ModelContextLike).registerTool(
        {
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
          execute: async (input: unknown, options?: { signal?: AbortSignal }) => {
            if (options?.signal?.aborted) throw new DOMException("中断されました。", "AbortError");
            return t.execute(input);
          },
        },
        { signal: ac.signal },
      );
    }
    return ac;
  } catch (err) {
    ac.abort();
    console.warn("WebMCP のツールを登録できませんでした。", err);
    return null;
  }
}
