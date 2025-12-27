# (1/4) Vibe Tree 実装指示 v3 — 全体方針（DB最小 / Plan強制 / Restart Prompt）

## ゴール（MVP）
ローカルWebアプリ「Vibe Tree」を実装する。Git/PR/worktreeの状態は常にCLIで観測し、DBには「人間とAIの意志（Plan/Rules/指示ログ）」だけを保存する。Plan強制ゲートで計画を固めた後、Executeダッシュボードで状況を俯瞰し、Directorが警告と次アクションを提示する。

## コア体験
1) 起動→必ず Plan Mode（強制ゲート）
2) Plan確定（commit）すると GitHub Issue に最小要約だけ転記し、Executeへ
3) Executeは1画面ダッシュボード（Tree中心）
4) Git/PR/worktreeは毎回CLIで取得（DBに保持しない）
5) セッションは「プロセスに再アタッチ」ではなく、同じworktreeで“状態を再開”する
   - Vibe Treeが常に RESTART PROMPT（再開用プロンプト）と「入るためのターミナルコマンド」を生成して表示
   - ユーザーはターミナルで `cd <worktree>` してClaude Codeを起動し直し、RESTART PROMPTで継続

## Project Rules（憲法）
Project（Repo）ごとに永続ルールを保持し、すべてのPlan/指示生成で必ず参照する。
- Branch Naming Rule は Project Settings でのみ編集可能（Bで確定）
- Plan/Executeでは read-only 表示
- 作業ブランチ作成は必ず Rule から生成（branch名手入力禁止）

## スタック（固定）
- Runtime: Bun
- Backend: Hono + REST + WebSocket
- ORM: Drizzle
- DB: SQLite（`.vibetree/vibetree.sqlite`）
- Frontend: React + TypeScript（Vite）
- Git: git CLI中心（必要ならsimple-git補助）
- GitHub: gh CLI

## DB最小主義（重要）
DBに保存するのは：
- repos
- project_rules
- plans
- plan_tasks（※Claudeタスクではなく計画のチェックポイント）
- instructions_log（Web UIで出した指示をひたすら蓄積）
（任意：memoriesは後で抽出用に追加できるがMVPではinstructions_logだけでもOK）

DBに保存しない（毎回CLI観測）：
- branches / commit / merge-base 推定 / ahead-behind
- worktrees / dirty
- PR / CI（gh）
- diagnostics（scanごとに計算してWSで流す。保存は不要）

チェックポイント：
CP0 起動
CP1 DB migrate（最小テーブル）
CP2 Project Settings（branch naming）
CP3 Plan Mode（強制ゲート）→ commit（GitHub最小転記）
CP4 Execute（scan→tree表示→warnings→restart prompt生成）
