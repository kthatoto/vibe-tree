# Claude Code 指示：Vibe Tree vNext（ツリー設計＋1画面ダッシュボード＋稼働観測）

## 目的
ローカルWeb UIで、Git/PR/Issue/worktree/稼働状況をツリー表示し、AI×人間の並行開発の認知負荷を下げる。
UIはリッチにしすぎず、基本は1画面のTreeダッシュボード。

## Stack（固定）
- Runtime: Bun
- Backend: Hono (REST + WebSocket)
- ORM: Drizzle
- DB: SQLite
- Front: React + TS
- GitHub: gh CLI
- Git: git CLI

## 初期ツリー生成：複数パターン対応
- Pattern A: 既存GitHub Issue（親/子/依存が既にある）→それを読んでPlanとブランチツリー設計
- Pattern B: Notion（MCPでClaudeが読む）→分割→必要ならIssue作成→ツリー設計
- Pattern C: 口頭＋コード読解→分割→必要ならIssue作成→ツリー設計

## 分割戦略（学習対象）
- 原則：1 branch = 1 PR（細かく分ける。CRUD/画面単位/検索UI単位など）
- 分割しすぎOK（PR 10本/20本OK）
- 例外でまとめる判断もOK。例外も学習対象としてログに残す

## Plan/Tree設計は後から変更可能
Plan Modeで確定しても柔軟に編集できる（PlanもTreeも）

## Issue親子/依存
ghで取得できる前提。fallback不要。

## 稼働ステータス（重要）
稼働ステータスは手動入力しない。
「Claude Codeが動いているディレクトリ（= worktree）」を観測して判定する仕組みにする。
