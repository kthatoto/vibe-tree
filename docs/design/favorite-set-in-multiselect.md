# お気に入りセット（PR Shortcut）をブランチ一括選択画面に出す — 設計

## 0. 最終実装（確定・実装済み）

以下の3〜6章は検討経緯。**最終的に実装したUIは「ドロップダウン」ではなく「インライン1クリック一覧」**になった（ユーザー要望でドロップダウンの開閉=2クリックを廃止）。

- `MultiSelectPanel` の PR operations 内に、`prShortcuts` を**インラインの縦並びリスト**で常時表示（フロート/ドロップダウンなし）。
- 各行 = `⇧N キーキャップ + セット名 + labels/reviewers チップ`。**行を1クリックで即適用**（`handleApplyShortcut`、add-only、`branchesWithPRs` の open PR へ並行適用、既存 `progress`/✓✗ フィードバック流用、`progress.status==="running"` でガード）。
- 見出しに `Apply shortcut → N PRs` を表示。空セットは `(empty)` で disabled。`prShortcuts` が0件なら「Define them in Settings → PR → Shortcuts」を表示。
- `TreeDashboard` の **Shift 押下中フロート overlay は削除**（パネルにインライン表示されるため冗長）。`shiftHeld` state とキーリスナー effect も削除。`Shift+1..9` キー適用（`applyPrShortcut`）は別 effect なので存続。
- 検証: `localhost:9001/projects/2` で複数ブランチ選択→ショートカット行を1クリック→対象PRに✓が出ることを確認。tsc/eslint は MultiSelectPanel エラーなし（TreeDashboard は既存エラーのみ）。

## 1. 背景・要望
お気に入りセット（= `PrShortcut`：labels + reviewers の名前付きセット）を、**ブランチ一括選択画面（`MultiSelectPanel`）**からも適用できるようにする。

ユーザーの意図:
- 一括選択画面で個別にラベル/レビュアーを足すことはほぼ無い。Remove もほぼ使わない。
- お気に入りセットをサッと適用できれば十分。
- 横並びボタンは「主張が激しい」ので避け、**控えめなドロップダウン1つ**にしたい。
- 「選んだら即適用」。ステージ→Apply の2度手間はしない。

## 2. 用語
UI 表記は **「Shortcut」** に統一する（既存の Shift+N ヒントオーバーレイ・Settings の "Shortcuts" と一致させる）。「お気に入りセット」「PrShortcut」「set」は内部呼称。

## 3. 現状把握（実コード）

### PrShortcut 型
```ts
// frontend/src/lib/api.ts
export interface PrShortcut {
  name: string;
  labels: string[];
  reviewers: string[];
}
```
- 最大9個。repo 単位で永続化（`api.getPrShortcuts` / `api.updatePrShortcuts`）。
- `prShortcuts` state は `TreeDashboard.tsx` に既にある（Settings > PR > Shortcuts で編集）。

### 既存の適用手段（一括選択画面の外）
| 手段 | 場所 | 挙動 |
|---|---|---|
| `Shift+1..9` キー | `TreeDashboard.tsx` の `applyPrShortcut` | 選択ブランチの open PR にセットを即適用（**追加のみ・並行 `Promise.all`・上限なし**）。エラーは `console.error` で握り潰し、進捗表示なし |
| Shift 押下中のヒント | `TreeDashboard.tsx` のオーバーレイ | 右上にセット一覧を chip 付きで表示するだけ（`pointerEvents: none`、クリック不可） |

> 注: 当初メモの「Shift+1..9 は順次」は**誤り**。実際は並行。実差異は「同時実行上限の有無・進捗表示の有無・エラー可視性」。

### MultiSelectPanel.tsx の関連資産（シンボルで参照すること。行番号は変動する）
- `forEachWithConcurrency`（並行ユーティリティ、`BULK_CONCURRENCY` 上限あり）
- `runBulkPerItem`（bulk 実行 + `progress` 更新の共通基盤）
- `progress` state（total/completed/current/results/status）と ✓/✗・件数・エラー tooltip の表示 UI
- `handleApply`（pending labels/reviewers を add/remove 両対応で bulk 適用。`forEachWithConcurrency` + `progress` + `onRefreshBranches`）
- `branchesWithPRs` / `getPRLinkId`（open PR を持つブランチと linkId）
- `isOperationRunning`（= `progress.status === "running"`、他の操作ボタンの disabled 条件）
- 既存の `± Labels` / `± Reviewers` ドロップダウンは `Dropdown` atom と `LabelChip`/`UserChip`/`TeamChip` を使用

## 4. UI/UX 決定事項
- 既存の `± Labels` / `± Reviewers` ドロップダウン（add/remove ステージ → 結合 Apply）は**削除**。
- 代わりに `⚡ Apply shortcut ▾` ドロップダウン**1つ**を PR operations 見出しの下に置く。
- 開くと `prShortcuts` 一覧。各項目は **Shift ヒントと同じ chip プレビュー**（labels/reviewers）。
- 見出しに「**→ applies to N PRs**」を常時表示（誤爆抑止）。
- **1つ選んだ瞬間に即適用（確認モーダルなし）**。Shift+N と一貫し、「控えめ」意図にも沿う。
- 適用は選択中ブランチの **open PR のみ・追加のみ（Remove なし）**。
- **取り消しUIは作らない**（即適用のみ。誤適用は GitHub 側で手動 revoke）。← ユーザー確定。
- 空/エラー状態:
  - セット0件 → ドロップダウン disabled ＋「Define in Settings」誘導。
  - 中身が空のセット → `(empty)` 表示・選んでも no-op。
  - 適用中（`isOperationRunning`）→ ドロップダウン disabled（レース防止）。
  - open PR 無しブランチ → セクション自体が `branchesWithPRs.length > 0` で gate 済み、混在時は静かにスキップ（既存 record で「No PR found」）。

## 5. 確定実装計画

### MultiSelectPanel.tsx
**削除**
- state: `showLabelDropdown` / `showReviewerDropdown` / `labelMode` / `reviewerMode` / `pendingLabels` / `pendingReviewers`
- useMemo: `labelCounts` / `reviewerCounts`
- `handleApply` → `handleApplyShortcut(shortcut)` に置換
- JSX: `± Labels` / `± Reviewers` ドロップダウン＋結合 Apply ボタン
- props: `quickLabels` / `quickReviewers`（interface + 分割代入 + 呼び出し側の3箇所すべて）

**追加**
- import `PrShortcut`、props `prShortcuts: PrShortcut[]`
- state `showShortcutDropdown`
- `handleApplyShortcut(shortcut)`:
  - `progress.status === "running"` なら return（ガード）
  - 対象 = `branchesWithPRs`、`totalOps = 対象数 * (labels.length + reviewers.length)`、0 なら return
  - `forEachWithConcurrency(targetBranches, BULK_CONCURRENCY, ...)` で各ブランチの linkId に `api.addPrLabel` / `api.addPrReviewer`（**追加のみ**）
  - 既存 `handleApply` と同じ `progress` 更新・`record`・✓/✗ 表示を流用。`console.error` は使わない
  - 完了後 `onRefreshBranches?.()`
- JSX: `⚡ Apply shortcut ▾` ドロップダウン（`Dropdown` atom 流用、chip プレビュー、applies to N PRs、空/disabled 対応）

**残す（当初メモの誤りを訂正）**
- `repoLabels` / `repoCollaborators`、`RepoLabel` / `RepoCollaborator` 型 import、`LabelChip` / `UserChip` / `TeamChip`、`Dropdown` atom — chip プレビューに使うため**削除しない**。

### TreeDashboard.tsx
- `MultiSelectPanel` 呼び出しで `quickLabels` / `quickReviewers` を外し `prShortcuts={prShortcuts}` を渡す（`repoLabels` / `repoCollaborators` はそのまま）。
- `applyPrShortcut`（Shift+N 用）は存続。`TaskDetailPanel` への `prQuickLabels` 等の受け渡しは独立なので**触らない**。

### 編集順序
依存の末端から: JSX 使用箇所 → 関数 → state/memo → props 分割代入 → props 定義 →（型 import は残すので触らない）。

## 6. 設計レビュー要点（3観点 / plan-eng-review）
- **アーキ**: 適用ロジックを新規に書き起こすと `applyPrShortcut` と重複しドリフトする。MultiSelectPanel 内は**既存 `handleApply` 系の bulk/progress 基盤を再利用**して一本化。完全共通化（`lib/prBulkApply.ts` 抽出）は3箇所目が出るまで YAGNI。
- **安全性/エッジ**: `tsc -b` は `noUnusedLocals:false` で未使用 import を見逃すが、**`eslint .`（`@typescript-eslint/no-unused-vars`）は落ちる** → 削除は網羅的に、完了前に `npm run lint`。prop 名は interface/分割代入/呼び出し側で整合（`quickLabels` vs `prQuickLabels`）。`isOperationRunning` ガード必須。空セット/stale ラベル(422/404)は per-item ✗ で可視化（`console.error` 禁止 = no-console ルール）。
- **UX**: `applyPrShortcut` 直呼びは進捗退化＝NG。即適用は可だが「applies to N PRs」を常時露出。用語を「Shortcut」に統一。確認モーダルは不要（Shift+N と不整合・主張過多）。

## 7. 完了条件
- `npm run lint`（frontend）でエラーなし（未使用 import/var 検出）。
- 実機 `http://localhost:9001/projects/2` でスクリーンショット確認（CLAUDE.local.md 必須）。

## 8. 教訓
- 過去の Read/grep 出力にノイズが混じり、行番号・一部シンボル（`handleApply` 位置、`labelCounts` が useMemo か、`showShortcutMenu` の有無）を誤認した。
- **実装は行番号でなくシンボル grep で確定すること。**
