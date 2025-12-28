# (2/4) Vibe Tree 実装指示 v3 — DB（最小テーブル）+ Project Settings

## DB（Drizzle/SQLite）
DBファイル：`.vibetree/vibetree.sqlite`

## 必須テーブル（MVP最小）
### repos
- id
- path (unique)
- name
- created_at, updated_at

### project_rules
- id
- repo_id
- rule_type: 'branch_naming'
- rule_json（JSON文字列）
  - { pattern, description, examples[] }
- is_active（branch_namingは常に1件true）
- created_at, updated_at

初期化：
- repo登録時に branch_naming を自動作成
- 初期値：
  - pattern: `vt/{planId}/{taskSlug}`
  - examples: 数件
  - description: 簡単に

### plans
- id
- repo_id
- title
- content_md
- status: draft|committed
- github_issue_url（最小転記のIssue）
- created_at, updated_at

### plan_tasks
※ Claudeの実行タスクではない。「計画の分解・チェックポイント」用途。
- id
- plan_id
- title
- description
- status: todo|doing|done|blocked
- order_index
- created_at, updated_at

### instructions_log
Web UI上で出した指示を“ひたすら蓄積”する生ログ。
- id
- repo_id
- plan_id（nullable）
- worktree_path（nullable）
- branch_name（nullable）
- kind: 'director_suggestion'|'user_instruction'|'system_note'
- content_md
- created_at

## Project Settings（branch naming editor）
- 編集できるのは /settings だけ
- Plan/Execute からは read-only 表示 + settingsへリンク

CP1完了条件：
- migrateが通る
- repo登録でproject_rulesが初期化される
CP2完了条件：
- settingsでpattern/examplesを更新でき、全画面に反映される
