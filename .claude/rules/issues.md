# Issue 運用ルール（必須）

TODO はすべて GitHub Issue に置く。TASKS.md・プラン・会話・Notion に TODO を溜めない。

## 必須ルール

1. **コードに触る作業は必ず Issue 番号を持つ。** 無ければ作業前に `/issue` で起票する。
2. **1 Issue = 1 ブランチ = 1 worktree = 1 PR。** main（master）・develop へ直接 commit しない（Claude Code のフック `~/.claude/hooks/require-issue-branch.py` が止める）。
   - ブランチ名: `<type>/<N>-<slug>`（例: `feat/42-invoice-csv`）。Orca が付ける `<ユーザー名>/` 接頭辞は可。
   - type: `feat` / `fix` / `chore` / `docs` / `refactor` / `test` / `perf` / `epic`
   - **作業ブランチは `develop` から切り、PR は `develop` に向ける**（2026-09-24〜）。既定ブランチを `develop` にしておく
3. **PR 本文に `Closes #N`。** コミット件名の末尾に `(#N)`。マージ（squash）は人間だけが行う。エージェントはマージしない（本人が明示的に任せた場合を除く）。
   - **`main`（`master`）は本番。常にきれいに保つ。** 入るのは `develop` → `main` のリリース PR だけで、そのマージは本人だけ。CI で「main への PR は develop からだけ」を強制し、ブランチ保護で直接 push を禁止する
   - PR には **Playwright の E2E を本番と同じ実行環境に対して流した結果**と「**確認できていないこと**」を書く。後者が空でない PR はマージしない（詳細は `~/.claude/CLAUDE.md`「テストと検証」）
4. **コード以外の TODO も Issue。** 顧客確認・判断待ち（要件定義書の【要確認】など）は `needs-human` を付けて起票する。
5. **Issue は必ず Dev Board に載せる。期限がある Issue（タイトルや本文に日付がある、`p1` など）は `Due` を必ず入れる。**
   **状態は Dev Board（GitHub Projects）の Status 列だけで管理する**（Todo / In Progress / In Review / Done）。状態ラベルは作らない。期限は `Due`、誰が球を持っているかは `Ball`（自分 / 先方）に入れる（`~/bin/board-set`）。
6. **並列で走らせる Issue は同じファイルを触らない。** 共有型・DB スキーマの変更は先に単独の Issue で済ませ、他は blocked-by でつなぐ。同時起動は 3 件まで。
7. **作業中に見つけた範囲外の作業は、その場で直さず別 Issue にする。**

## 粒度

| 大きさ | 扱い |
|---|---|
| 半日〜1 日、触るファイルを列挙できる | 通常 Issue（1 PR） |
| それより大きい | 親 Issue（`type:epic`）+ 子 Issue。順序は blocked-by |
| 数分で済む（typo・文言） | 月ごとの「細かい修正 YYYY-MM」chore Issue にまとめる |
| 受け入れ条件を機械で確認できる形で書けない | 要件未確定。`needs-human` で起票し、決めるべきことを書く |

## ラベル

| ラベル | 意味 |
|---|---|
| `type:feat` `type:bug` `type:chore` `type:docs` `type:epic` | 種別（どれか 1 つ必須） |
| `agent-ready` | 受け入れ条件と触るファイルが揃い、エージェントに渡せる。**付けるのは人間** |
| `needs-human` | **決まっていないこと**がある（本人の判断待ち・先方の回答待ち）。決まったら外す。「人が手を動かす作業」には付けない（それは `agent-ready` が付かないことで表す） |
| `p1` | 今週中に必須。無印は通常優先度 |

## 流れ

```
/issue（起票・Dev Board: Todo）
  → /start <N>（Orca worktree + エージェント起動・In Progress）
  → /kickoff（Issue ゲート → Gate 1）→ /implement
  → /wrapup（Gate 2: commit + push + PR → develop・In Review）
  → CI（型検査・単体・Playwright E2E）が緑 → squash マージで develop へ（Issue 自動 close・Done）
  → develop をデモ／ステージングへデプロイ（版の一致と E2E まで確認）
  → develop → main のリリース PR（CI が緑）→ 本人がマージ → 本番へ
```

TASKS.md は引き継ぎメモ専用（作業中の Issue 番号・詰まり・次に触るファイル・却下案）。
