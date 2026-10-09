# x-digest

X のブックマークを毎日ローカルに蓄積し、週次で AI がダイジェストを書く。

X 公式 API は使わない。2026-04-20 以降は自分のブックマークを読むだけでも従量課金
(1件 $0.001 + 最低 $5 のクレジットチャージ) が必要になったため、ログイン済みブラウザで
`x.com/i/bookmarks` を直接読む。

> [!WARNING]
> **使う前に必ず読むこと。** 自動ブラウザで x.com を読むことは X の利用規約に反する。
> このツールは「自分のアカウントで、自分のブックマークを、1日1回だけ読む」使い方を想定して作っているが、
> それでも規約上は違反であり、アカウントの制限・凍結のリスクをゼロにはできない。
>
> - 使うかどうかは利用者自身の判断と責任で決めること
> - 他人のアカウントや、ブックマーク以外のデータの取得には使わないこと
> - 取得の頻度を上げないこと（詳しくは下の「既知のリスク」）
>
> このソフトウェアは無保証で提供する（[LICENSE](LICENSE)）。利用によって生じた損害について、作者は責任を負わない。

## 仕組み

```
launchd
  ├─ 毎日 7:00  fetch.sh  → playwright-core で x.com/i/bookmarks を開き、
  │                         X 自身の GraphQL レスポンスを傍受して蓄積 (LLM 不使用)
  └─ 毎週月 8:00 digest.sh → 蓄積を claude -p に渡してダイジェストを生成
```

DOM をスクレイピングせず GraphQL レスポンスを**傍受**しているのが要点。リクエストを自作せず
ブラウザが投げたものの応答を横で見るだけなので、URL に埋まる queryId が 2〜4 週ごとに
変わっても影響を受けない (照合は operation 名 `/Bookmarks` で行う)。

傍受した生 JSON は `raw/` に gzip でそのまま残す。X の構造が変わってパーサが壊れても、
データは失われず、修正版で過去分を再パースできる。

## セットアップ

### 1. 依存

```bash
npm install
```

ブラウザは `~/Library/Caches/ms-playwright/chromium-1234` を共有するので追加取得はない。
システムの Google Chrome は使わない (自動更新で黙って上がり、無人ジョブがサイレントに壊れるため)。

### 2. X にログイン (手作業。1回だけ)

```bash
./scripts/login-once.sh
```

ブラウザが開くので手動でログインする。資格情報は
`~/Library/Application Support/x-digest/profile/` に焼き付き、以降のヘッドレス実行で再利用される。

### 3. Claude CLI にログイン (手作業。1回だけ)

```bash
claude auth login
```

Claude Code の GUI セッションの認証は**スタンドアロンの `claude` CLI には引き継がれない**。
`claude auth status` の `loggedIn` が `true` になっていることを確認する。

### 4. 前景で動作確認 (自動化する前に必ず1回成功させる)

```bash
./scripts/fetch.sh --headed --max-pages 2
./scripts/digest.sh --dry-run
```

### 5. launchd に登録

```bash
sed "s|YOUR-HOME|$HOME|g" launchd/io.github.umeasyuyuki.xdigest.fetch.plist.example \
  > ~/Library/LaunchAgents/io.github.umeasyuyuki.xdigest.fetch.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.umeasyuyuki.xdigest.fetch.plist
```

digest 側も同様。即時発火テストは `launchctl kickstart -k gui/$(id -u)/io.github.umeasyuyuki.xdigest.fetch`。

## データの置き場

リポジトリの外 (既定 `~/Library/Application Support/x-digest/`、`X_DIGEST_DATA_DIR` で変更可、700)。
`profile/` には生きた X セッションの資格情報が入るため、`.gitignore` の1行ミスで漏れる場所に置かない。

| パス | 中身 |
|---|---|
| `profile/` | Chromium のユーザーデータ (ログインセッション) |
| `raw/YYYY-MM-DD/NNN.json.gz` | GraphQL の生レスポンス。真実の正本 |
| `bookmarks.jsonl` | 正規化済み・追記専用 |
| `digests/YYYY-MM-DD.md` | 生成されたダイジェスト |
| `state/last-error.txt` | 直近の失敗のコードと時刻のみ (本文もCookieも書かない) |

## 終了コード (fetch)

「静かに間違った成功をしない」ための分類。とくに**応答が1件も来ていない状態の0件を
成功と誤認しない**ことが重要。

| コード | 意味 | 対応 |
|---|---|---|
| 0 | 成功 (新着なしを含む) | — |
| 2 | GraphQL 応答が1件も来ない | ネットワーク/レンダリング失敗。自動で3回リトライ |
| 3 | X のログイン切れ | `./scripts/login-once.sh` を再実行。通知が出る |
| 4 | entry はあるが正規化0件 | X の構造変更の可能性。`raw/` を見てパーサを直す |
| 5 | 想定外 | ログを見る |

## 設計上の約束

- **重複排除は水位マークではなく ID 集合。** ブックマークはツイートID順ではなく
  「ブックマークした時刻」順に返るので、古い投稿を今日ブックマークすると水位より下に来る。
  水位で足切りすると永久に取りこぼす。副産物として、途中で失敗しても冪等に安全になる
- **失敗しても `bookmarks.jsonl` に触らない。** 追記専用なので既存データは常に無傷
- **ダイジェストは検証を通ってから atomic rename。** 失敗時は前回のものがそのまま残る
- **`claude -p` はエラー時も終了コード 0 を返す。** 失敗は JSON の `is_error` に出るので、
  終了コードではなくそちらを見る。見落とすとエラー文字列をダイジェストとして書いてしまう
- **ツイート本文は信頼できない入力。** Stage 2 は `--tools ""` でツール権限をゼロにしてある。
  「注入された指示に従える能力そのものを消す」のが防御の本体で、プロンプトの文言は補助
- **Markdown を LLM に書かせない。** JSON で返させ、ツイートIDが入力に実在するかを照合してから
  Node が決定論的にレンダリングする。幻覚した項目は照合で落ちる

## テスト

```bash
npm test
```

## 既知のリスク

自動ブラウザでの x.com へのアクセスは X の利用規約に反する。自分のアカウントで自分のデータを
読むだけでも規約上の区別はない。リスクをゼロにはできない。

実運用上ほぼ無視できる水準にするための条件は **1日1回・GraphQL 呼び出し1〜3回/日**。これは
人間が朝ブックマークを開いて少しスクロールしたのと統計的に区別できない。時間単位のポーリングに
した瞬間に別物になる。スクロール間隔のゆらぎと起動時刻の最大15分ジッターも同じ理由。
