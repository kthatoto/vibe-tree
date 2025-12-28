## v3からの増分（必須）
1) 推定ツリー（Git）だけでなく、設計ツリー（意図）を保持する
2) 1画面Treeダッシュボードで、branch/PR/Issue/CI/review/変更量/assignee/labels/worktree/稼働を表示する
3) 設計ツリー vs Git実態（merge-base等）の乖離を検知して警告する
4) 初期ツリー生成を Pattern A/B/C で実現する

## DB（最小主義維持しつつ追加）
既存: repos, project_rules, plans, plan_tasks, instructions_log
追加:
- tree_specs（設計ツリー）
  - spec_jsonに nodes/edges と、nodeごとの意図的紐付け（branch/issue/pr想定）を保持
- worktree_activity（観測結果のキャッシュ。事実は保存しないが“直近観測値”はOK）
  - worktree_path, last_seen_at, active_agent(enum: claude), note?
※ “誰が対応中か”は当面 claude 1種類で良い。将来拡張できる形に。

## 稼働観測（tmux無しで成立させるための方法：worktree heartbeat方式）
- Claude Codeを起動するとき、そのworktree配下に heartbeat ファイルを更新する仕組みを用意する
- 例：<worktree>/.vibetree/heartbeat.json を一定間隔で更新
  - { "agent": "claude", "pid": 123, "cwd": "...", "updatedAt": "..." }
- Vibe Tree は scan のたびに全worktreeの heartbeat を読んで「稼働中」を判定
- これを成立させるために、Vibe Tree側は「Claude起動コマンド」を生成し、そのコマンドに heartbeat 更新を組み込む
  - 例（概念）: `cd <worktree> && (heartbeat-writer & ) && claude ...`
- heartbeat-writer は Bun の小さなスクリプトとしてリポジトリ共通で持つか、Vibe Tree が生成してworktreeに配置する

## scan強化（Treeノードに載せる情報）
- git: branches, merge-base推定親子, ahead/behind, dirty, worktrees
- gh issue: parent/child/dependencyを取得してnodeに紐付け（tree_specs作成にも使用）
- gh pr: pr view/list のjsonから以下を取得してnodeバッジ化
  - labels, assignees, reviewDecision, statusCheckRollup, additions, deletions, changedFiles, state, url, isDraft
- worktree heartbeat: active/inactive を付与（稼働ステータス）
- warnings: 設計ツリー vs 実態の乖離、behind、dirty、CI fail、命名規則違反など

## UI（1画面固定）
- 中央：Tree（ノード=branch）
  - ノードにバッジ：Issue/PR/CI/Review/変更量/assignee/labels/worktree/稼働
- 右ペイン：選択ノード詳細（同画面内）
  - Issue詳細/PR詳細、Restart Prompt、cdコマンド、指示ログ追加
- Settings以外は基本Tree画面で完結

## 乖離警告（必須）
- tree_specsで「意図した親子」がある
- git merge-base推定の親子とズレたら warn/error
- 修正手段は
  - 設計ツリーの更新（UI操作）
