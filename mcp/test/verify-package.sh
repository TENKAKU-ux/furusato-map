#!/usr/bin/env bash
# 公開前の確認: npm pack の tgz をリポの外に展開し、そこから stdio サーバーを起動して e2e を通す。
#   1. 普通に起動（cwd を変えて）
#   2. bwrap でファイルシステム全体を読み取り専用にし、ネットワークを切って起動
#   3. strace でサーバーと子プロセスの書き込み・プロセス起動・通信の syscall を追跡
# 使い方: mcp/test/verify-package.sh <tgz> <作業ディレクトリ（空）>
# 依存の取得（npm install）だけはネットワークを使う。Linux（bwrap・strace）が要る。
set -euo pipefail
TGZ=$(realpath "$1")
WORK=$(realpath "$2")
HERE=$(cd "$(dirname "$0")" && pwd)
E2E="$HERE/e2e.mjs"

echo "== tgz: $TGZ"
sha256sum "$TGZ"
mkdir -p "$WORK/extract"
tar -xzf "$TGZ" -C "$WORK/extract"
PKG="$WORK/extract/package"
(cd "$PKG" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
(cd "$PKG" && npm ls --all --omit=dev)
SERVER="$PKG/dist/server.mjs"

echo "== 1. 普通に起動（cwd=/）"
node "$E2E" "$SERVER" /

echo "== 2. bwrap: ファイルシステム全体を読み取り専用・ネットワークなし"
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-net --unshare-pid --die-with-parent \
  --setenv HOME /nonexistent-home --chdir / \
  node "$E2E" "$SERVER" /

echo "== 3. strace: 書き込み・プロセス起動・通信の syscall"
LOG="$WORK/strace"
mkdir -p "$LOG"
E2E_WRAP="[\"strace\",\"-f\",\"-qq\",\"-ff\",\"-s\",\"512\",\"-o\",\"$LOG/s\",\"-e\",\"trace=execve,execveat,fork,vfork,clone,clone3,socket,connect,bind,sendto,openat,open,creat,rename,renameat,renameat2,unlink,unlinkat,mkdir,mkdirat,rmdir,truncate,ftruncate,chmod,fchmod,fchmodat,symlink,symlinkat,link,linkat\"]" \
  node "$E2E" "$SERVER" /
node - "$LOG" "$SERVER" <<'EOF'
const fs = require("node:fs");
const [dir, server] = process.argv.slice(2);
const lines = fs.readdirSync(dir).flatMap((f) => fs.readFileSync(`${dir}/${f}`, "utf8").split("\n").filter(Boolean).map((l) => `${f}: ${l}`));
const bad = [];
for (const l of lines) {
  // サーバーを起動する最初の execve（strace → node server.mjs）だけは許す
  if (/execve\(/.test(l) && l.includes(server) && /= 0$/.test(l)) continue;
  if (/execve\(|execveat\(|vfork\(|fork\(/.test(l)) bad.push(l);
  // clone はスレッド（CLONE_THREAD）だけ許す
  else if (/clone3?\(/.test(l) && !/CLONE_THREAD/.test(l)) bad.push(l);
  else if (/socket\(|connect\(|bind\(|sendto\(/.test(l)) bad.push(l);
  else if (/open(at)?\(/.test(l) && /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/.test(l)) bad.push(l);
  else if (/(creat|rename|renameat2?|unlink|unlinkat|mkdir|mkdirat|rmdir|truncate|ftruncate|chmod|fchmod|fchmodat|symlink|symlinkat|link|linkat)\(/.test(l)) bad.push(l);
}
console.log(`strace: ${lines.length} 行を調べた`);
if (bad.length) {
  console.log("許していない syscall:");
  for (const l of bad) console.log("  " + l);
  process.exit(1);
}
console.log("strace: 書き込み・プロセス起動・通信の試行なし");
EOF
echo "== すべて合格"
