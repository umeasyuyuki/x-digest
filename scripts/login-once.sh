#!/bin/zsh
# X への初回ログイン。ブラウザが開くので手動でログインする。
#   使い方: ./scripts/login-once.sh
#
# 資格情報は X_DIGEST_DATA_DIR/profile/ に焼き付き、以降のヘッドレス実行で再利用される。
# Cookie はいずれ切れる。切れたら fetch が rc=3 で落ちて通知が出るので、これを再実行する。

set -u

BASE="${0:A:h:h}"
cd "$BASE" || exit 1

NODE=""
for c in "$HOME/.local/share/mise/installs/node/24.19.0/bin/node" \
         "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [[ -x "$c" ]] && { NODE="$c"; break; }
done
[[ -z "$NODE" ]] && { print -r -- "node が見つからない"; exit 1; }

export NODE_OPTIONS="--dns-result-order=ipv4first"

exec "$NODE" src/fetch-bookmarks.mjs --login
