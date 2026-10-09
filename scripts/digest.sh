#!/bin/zsh
# 蓄積したブックマークから AI ダイジェストを生成する。launchd から週次で呼ばれる。
#   使い方: digest.sh [--dry-run]
#
# 設計上の約束:
#   - claude にツールを1つも与えない (--tools "")。ツイート本文は他人が書いた任意の
#     テキストで、指示文が仕込まれている可能性がある。「注入された指示に従える能力そのもの」
#     を消すのが唯一確実な防御であり、プロンプトの文言は補助にすぎない
#   - データはファイルではなく stdin で渡す。ファイルを読ませる必要をなくすため
#   - --safe-mode で ECC プラグインのフック・MCP・CLAUDE.md 自動探索を切る。
#     無人ジョブで毎回ロードするのは遅く、故障面が広い。認証とモデル選択は通常どおり動く
#     (--bare は OAuth を読まないのでサブスク認証では使えない)
#   - Markdown は LLM に書かせない。JSON で返させ、ID の実在を照合してから
#     Node が決定論的にレンダリングし、atomic rename で保存する

set -u

BASE="${0:A:h:h}"
cd "$BASE" || exit 1

LOG="/tmp/x-digest-digest.log"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

MODEL="${X_DIGEST_MODEL:-claude-sonnet-5}"
FALLBACK_MODEL="${X_DIGEST_FALLBACK_MODEL:-claude-haiku-4-5-20251001}"
MAX_BUDGET="${X_DIGEST_MAX_BUDGET_USD:-0.50}"

NODE=""
for c in "$HOME/.local/share/mise/installs/node/24.19.0/bin/node" \
         "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [[ -x "$c" ]] && { NODE="$c"; break; }
done
[[ -z "$NODE" ]] && { print -r -- "$(date '+%F %T') node が見つからない" >> "$LOG"; exit 1; }

CLAUDE=""
for c in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
  [[ -x "$c" ]] && { CLAUDE="$c"; break; }
done
[[ -z "$CLAUDE" ]] && { print -r -- "$(date '+%F %T') claude が見つからない" >> "$LOG"; exit 1; }

export PATH="${NODE:h}:/opt/homebrew/bin:/usr/local/bin:$PATH"
export NODE_OPTIONS="--dns-result-order=ipv4first"

# --- 認証を先に確かめる。ここで落ちれば前回のダイジェストは無傷のまま残る。
#     auth status は未ログインでも終了コード 0 を返すので、JSON の loggedIn を見る ---
if ! "$CLAUDE" auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  print -r -- "$(date '+%F %T') claude の認証が切れている" >> "$LOG"
  /usr/bin/osascript -e 'display notification "claude auth login が必要です" with title "x-digest" subtitle "Claude の認証が切れました"' 2>/dev/null
  exit 1
fi

WORK=$(mktemp -d) || exit 1
trap 'rm -rf "$WORK"' EXIT

# --- 窓を切って payload を作る。対象が無ければ静かに終わる ---
if ! "$NODE" src/build-payload.mjs > "$WORK/payload.json" 2> "$WORK/payload.err"; then
  print -r -- "$(date '+%F %T') payload なし（対象のブックマークがない）" >> "$LOG"
  exit 0
fi

if [[ $DRY_RUN -eq 1 ]]; then
  print -r -- "payload: $(wc -c < "$WORK/payload.json") bytes"
fi

# --- ツール権限ゼロで判断だけさせる ---
if ! "$CLAUDE" -p \
    --safe-mode \
    --tools "" \
    --strict-mcp-config \
    --model "$MODEL" \
    --fallback-model "$FALLBACK_MODEL" \
    --output-format json \
    --json-schema "$(cat prompts/digest.schema.json)" \
    --no-session-persistence \
    --max-budget-usd "$MAX_BUDGET" \
    --system-prompt "$(cat prompts/digest.system.md)" \
    < "$WORK/payload.json" > "$WORK/result.json" 2> "$WORK/claude.err"; then
  rc=$?
  print -r -- "$(date '+%F %T') claude failed rc=$rc" >> "$LOG"
  exit $rc
fi

# --- ID を照合してから Markdown を書く。検証に落ちれば既存のダイジェストは変更されない ---
if ! target=$("$NODE" src/render-digest.mjs "$WORK/payload.json" "$WORK/result.json" 2>> "$LOG"); then
  rc=$?
  print -r -- "$(date '+%F %T') render failed rc=$rc" >> "$LOG"
  exit $rc
fi

print -r -- "$(date '+%F %T') ok :: $target" >> "$LOG"
print -r -- "$target"
