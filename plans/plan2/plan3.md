## 実装チェックポイント
CP0: v3が動く（plan/execute/scan）
CP1: tree_specs追加（CRUD API + 保存/読込）
CP2: gh issue/gh pr 取得をscanに統合（snapshot強化）
CP3: 1画面Tree UI（ノードバッジ + 右ペイン + Restart統合）
CP4: Pattern A（既存Issue構造→tree_specs生成フロー）
CP5: Pattern B/C（Notion/口頭→分割→必要ならIssue作成→tree_specs生成）
CP6: 乖離警告（設計ツリー vs merge-base推定）をwarningsに追加
CP7: 稼働観測（worktree heartbeat）
  - Claude起動コマンド生成（copy）
  - heartbeat writer script（Bun）を用意
  - scanでheartbeat読み→稼働バッジ表示

## 受け入れ条件（理想が動くかの判定）
- Settings以外は基本Tree画面で完結
- Tree上に branch/PR/issue/CI/review/変更量/assignee/labels/worktree/稼働 が見える
- 既存Issue親子/依存からツリー計画を作れる（Pattern A）
- Plan/Treeは後から編集できる
- 設計ツリーとGit実態がズレたら警告が出る
- Claude起動コマンドを使えば、稼働中worktreeが自動で“active”になる
- Restart Promptでターミナル再開できる
