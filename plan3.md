# (3/4) Vibe Tree 実装指示 v3 — Backend（Hono/WS）+ scan（CLI観測）+ Restart Prompt生成

## REST API（MVP）
- GET /api/health
- GET /api/repos
- POST /api/repos { path, name? }  # repo登録 + project_rules初期化
- GET /api/project-rules/branch-naming?repoId=...
- POST /api/project-rules/branch-naming { repoId, pattern, description, examples }

- GET /api/plan/current?repoId=...
- POST /api/plan/start { repoId, title }  # draft plan作成
- POST /api/plan/update { planId, content_md }  # まるごと上書きでOK
- POST /api/plan/commit { planId }  # GitHub Issueへ最小要約転記 + committed

- POST /api/scan { repoId }  # CLI観測→ツリー/警告/提案を計算して返す（DB保存しない）
- GET /api/restart-prompt?repoId=...&planId=...&worktreePath=...  # 再開用プロンプト生成
- POST /api/instructions/log { repoId, planId?, worktreePath?, branchName?, kind, content_md }  # 指示ログ蓄積

## WebSocket
/ws?repoId=...
イベント（最低限）：
- projectRules.updated
- plan.updated
- scan.updated { snapshot }  # scan結果（ツリー/警告/PR/dirty等を含む）
- instructions.logged

## scan の内容（DBに保存しない）
scanは repoPath を使って以下を取得・計算し、JSONで返す：
1) branches（git for-each-ref / show-ref）
2) merge-base推定で親子関係（inferred tree）
3) ahead/behind（parent...child）
4) worktrees（git worktree list --porcelain）
5) dirty（各worktreeで git -C path status --porcelain）
6) PR/CI（gh pr list/view） ※後付け表示。ツリー推定には使わない

出力 snapshot の形（例）：
- nodes: [{ branchName, badges, pr?, worktree?, lastCommitAt }]
- edges: [{ parent, child, confidence }]
- warnings: [{ severity, code, message, meta }]
- worktrees: [...]
- rules: { branchNaming: ... }（DBから読んで同梱）
- restart: { worktreePath, cdCommand, restartPromptMd }

## Restart Prompt（A方式：同じworktreeで再開）
/api/restart-prompt で生成する内容（markdown）：
- Project Rules（branch namingを必ず明記）
- Planの要約（Goal/Constraints/Risks）
- 現在の状態（git status要約、未マージ、behind、dirty）
- 次にやること（Director提案トップ3）
- 実行するコマンド候補（必要なら）
- 「このプロンプトをそのままClaude Codeに貼って再開せよ」

加えて UIに表示する “入場コマンド”：
- `cd <worktreePath>`

## Director（保存しないルールベース診断）
MVPの警告（計算結果として返す）：
- BEHIND_PARENT（behind>=1 warn、>=5 error）
- DIRTY（dirty warn）
- CI_FAIL（ghからfailureなら error）
- ORDER_BROKEN（親がerror/warnなら子へ連鎖warnでもOK）
- BRANCH_NAMING_VIOLATION（pattern違反はwarn）

## GitHub転記（最小要約 / Issue 1本）
plan commit時に gh で Issue を1つ作成し本文は最小：
- Title
- Goal（短文）
- Project Rules（branch naming + examples）
- Risks（数個）
- ローカル参照（planId、Vibe Treeで開く方法）

CP3完了条件：
- Plan開始→編集→commit→Issue作成（最小要約）→Executeへ進める
CP4完了条件：
- scanでsnapshotが返り、wsでpushできる
- restart promptが生成される
- instructions_logへ保存できる
