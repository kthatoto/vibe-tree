# (4/4) Vibe Tree 実装指示 v3 — Frontend（React）Plan/Execute/Settings と 指示ログ蓄積

## ルーティング
- `/` : Plan Mode（強制ゲート）
- `/execute?repoId=...` : Execute（plan committed必須）
- `/settings?repoId=...` : Project Settings（repo登録済みなら可）

## Plan Mode（強制ゲート）
- Plan editor（markdownでOK）
- Read-only で Branch Naming Rule 表示
- 「Settings」リンク
- 「Commit」ボタン（/api/plan/commit）
- commit成功で /execute へ

## Project Settings（branch naming editor）※編集はここだけ
- pattern / description / examples
- preview（planId, taskSlug を入れて生成結果を見る）
- save（POST /api/project-rules/branch-naming）
- 保存後はWSで全画面に反映

## Execute Mode（1画面ダッシュボード）
- 中央：Tree（nodes/edgesを表示。最初は簡易レイアウトでOK）
- 右：warnings（Director）
- 下 or 右：Restart Panel
  - cdコマンド表示（copy）
  - restart prompt markdown表示（copy）
- 右下：Reload（scan）
- 上部：Repo選択 / Settings / Plan参照

## 指示ログ（memoriesの前段）
UIから「指示を出す」操作を作り、必ず instructions_log に保存する：
- 入力欄：ユーザー指示（markdown）
- 保存：POST /api/instructions/log（kind=user_instruction）
- Director提案をUIに表示した際も、必要なら log（kind=director_suggestion）
MVPでは“蓄積だけ”で良い（抽出・要約は後で）

## 重要：Claude実行の場
- Vibe TreeはClaudeプロセスに再アタッチしない
- ターミナルで `cd <worktree>` して Claude Code を起動し、Restart Prompt を貼って再開する
- UIは「どのworktreeで」「何を」「どの順で」やるかの司令塔

CP4 UI完了条件：
- Plan→commit→execute導線が動く
- Executeでscan結果が見える
- Restart Promptがコピーできる
- 指示ログが蓄積される
