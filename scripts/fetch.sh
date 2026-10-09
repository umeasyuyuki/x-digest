#!/bin/zsh
# X のブックマークを取得して蓄積する。launchd から毎日呼ばれる。
#   使い方: fetch.sh [--headed] [--max-pages N]
#   時刻の変更は ~/Library/LaunchAgents/io.github.umeasyuyuki.xdigest.fetch.plist の
#   StartCalendarInterval を編集して launchctl kickstart し直す。
#
# 設計上の約束:
#   - 失敗しても bookmarks.jsonl に触らない。追記専用なので既存データは常に無傷
#   - ログイン切れ(rc=3)だけは人間の介入が要るので通知を出す。他の失敗は静かに記録するだけ
#   - エラーはコードと時刻だけ残す。本文もCookieも書かない

set -u

BASE="${0:A:h:h}"          # scripts/ の1つ上 = リポジトリのルート
cd "$BASE" || exit 1

LOG="/tmp/x-digest-fetch.log"
LOCK="/tmp/x-digest-fetch.lock"

# 対話実行(--headed 等の引数あり)ではジッターもロックも邪魔なので省く
INTERACTIVE=0
[[ $# -gt 0 ]] && INTERACTIVE=1

# --- 単一実行ガード。前回がクラッシュするとプロファイルの SingletonLock が残り、
#     翌日の起動が失敗する。二重起動そのものを防ぐ ---
if [[ $INTERACTIVE -eq 0 ]]; then
  if [[ -e "$LOCK" ]] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
    print -r -- "$(date '+%F %T') 前回の実行がまだ動いている。スキップ" >> "$LOG"
    exit 0
  fi
  print -r -- $$ > "$LOCK"
  trap 'rm -f "$LOCK"' EXIT
fi

# --- node を絶対パスで探す。launchd は PATH が最小。
#     ホーム CLAUDE.md §4.5 の node 二重管理があるので mise 版 v24 を優先する ---
NODE=""
for c in "$HOME/.local/share/mise/installs/node/24.19.0/bin/node" \
         "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [[ -x "$c" ]] && { NODE="$c"; break; }
done
[[ -z "$NODE" ]] && { print -r -- "$(date '+%F %T') node が見つからない" >> "$LOG"; exit 1; }

export PATH="${NODE:h}:/opt/homebrew/bin:/usr/local/bin:$PATH"
export NODE_OPTIONS="--dns-result-order=ipv4first"   # 回線が細い環境向け(ホーム CLAUDE.md §6)

# --- 起動時刻のジッター。StartCalendarInterval は秒単位で正確なので、
#     毎日きっかり同時刻のアクセスは機械的な信号になる ---
if [[ $INTERACTIVE -eq 0 ]]; then
  sleep $(( RANDOM % 900 ))
fi

# --- 実行。起床直後は Wi-Fi が未接続のことがあるので 60 秒間隔で 3 回試す ---
rc=0
for attempt in 1 2 3; do
  if out=$("$NODE" src/fetch-bookmarks.mjs "$@" 2>&1); then
    print -r -- "$(date '+%F %T') ok :: ${out##*$'\n'}" >> "$LOG"
    exit 0
  fi
  rc=$?

  # ログイン切れとパーサ破損はリトライしても直らない。即座に抜ける
  [[ $rc -eq 3 || $rc -eq 4 ]] && break
  [[ $attempt -lt 3 ]] && sleep 60
done

print -r -- "$(date '+%F %T') fetch failed rc=$rc" >> "$LOG"

# ログイン切れだけは人間が動かないと直らないので目立たせる
if [[ $rc -eq 3 ]]; then
  /usr/bin/osascript -e 'display notification "npm run login で再ログインしてください" with title "x-digest" subtitle "X のログインが切れました" sound name "Submarine"' 2>/dev/null
fi

exit $rc
