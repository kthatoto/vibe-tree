# セッション独立コンポーネント化 計画書

## 概要

現在のPlanningPanelは、選択されたセッションに対してのみコンテンツをレンダリングしている。
セッション切り替え時にコンポーネントが再マウントされ、すべての状態（チャット履歴、ローディング状態、Thinkingインジケータなど）がリセットされる。

**目標**: 各セッションが独立したコンポーネントインスタンスを持ち、タブ切り替え時も状態が保持されるようにする。

---

## 現状の問題

### 1. 単一コンポーネントの使い回し
```
現在の構造:
┌─ PlanningPanel ─────────────────────────────────┐
│  [Tab A] [Tab B] [Tab C]                        │
│  ┌─────────────────────────────────────────┐    │
│  │ selectedSession のコンテンツのみレンダリング │    │
│  │ (ChatPanel, Sidebar, etc.)              │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘

問題:
- Tab A → Tab B 切り替え時、ChatPanelが再マウント
- メッセージ、ストリーミング状態、ローディング状態がリセット
- 前のセッションのデータが一瞬表示される（非同期API競合）
```

### 2. 目標の構造
```
目標の構造:
┌─ PlanningPanel ─────────────────────────────────┐
│  [Tab A] [Tab B] [Tab C]                        │
│  ┌─────────────────────────────────────────┐    │
│  │ Session A (display: none)               │    │
│  │   └─ ChatPanel A (状態保持)              │    │
│  │ Session B (display: block) ← 選択中     │    │
│  │   └─ ChatPanel B (状態保持)              │    │
│  │ Session C (display: none)               │    │
│  │   └─ ChatPanel C (状態保持)              │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘

利点:
- 各セッションが独立したコンポーネントインスタンス
- タブ切り替え時も状態が保持される
- 複数セッションを同時に表示することも可能（将来）
```

---

## 影響範囲

### 変更が必要なファイル

| ファイル | 変更内容 | 規模 |
|---------|---------|------|
| `frontend/src/components/PlanningPanel.tsx` | 根本的な構造変更 | 大 |
| `frontend/src/components/SessionDetail.tsx` | 新規作成 | 大 |
| `frontend/src/components/SessionDetail.css` | 新規作成 | 中 |
| `frontend/src/components/PlanningPanel.css` | 調整 | 小 |

### PlanningPanelから移動する状態

以下の状態を`SessionDetail`コンポーネントに移動:

```typescript
// Execute Session用
- executeCurrentTaskInstruction
- executeAllTasksInstructions
- executeEditMode, executeEditTitle, executeEditBranches

// Planning Session用
- planningSelectedBranches
- planningCurrentBranchIndex
- userViewBranchIndex
- currentInstruction, currentInstructionData
- planningAllBranchLinks
- planningExternalLinks, planningBranchFiles
- branchTodoCounts, branchQuestionCounts

// 共通
- claudeWorking (セッションごとに独立)
- messages (ChatPanel内で管理)
- streamingChunks (ChatPanel内で管理)
```

---

## 実装計画

### Phase 1: SessionDetailコンポーネントの作成

**目標**: 各セッションのコンテンツを独立したコンポーネントにカプセル化

#### 1.1 SessionDetail.tsx の作成

```typescript
interface SessionDetailProps {
  session: PlanningSession;
  repoId: string;
  isActive: boolean;  // display: none/block を制御
  sidebarWidth: number;
  sidebarFullscreen: boolean;
  onSidebarWidthChange: (width: number) => void;
  onSidebarFullscreenChange: (fullscreen: boolean) => void;
  // 各種ハンドラー
  onSessionUpdate: (session: Partial<PlanningSession>) => void;
  onSessionDelete: () => void;
  onTaskSuggested: (suggestion: TaskSuggestion) => void;
}

function SessionDetail({ session, repoId, isActive, ... }: SessionDetailProps) {
  // セッション固有の状態をここで管理
  const [claudeWorking, setClaudeWorking] = useState(false);
  const [currentInstruction, setCurrentInstruction] = useState("");
  // ... 他のセッション固有の状態

  // セッションタイプに応じたレンダリング
  if (session.type === "execute") {
    return <ExecuteSessionView session={session} ... />;
  }
  if (session.type === "planning") {
    return <PlanningSessionView session={session} ... />;
  }
  return <RefinementSessionView session={session} ... />;
}
```

#### 1.2 セッションタイプ別のビューコンポーネント

```
frontend/src/components/
├── SessionDetail.tsx          # メインコンポーネント
├── SessionDetail.css
├── sessions/
│   ├── ExecuteSessionView.tsx    # Execute用
│   ├── PlanningSessionView.tsx   # Planning用
│   └── RefinementSessionView.tsx # Refinement用
```

### Phase 2: PlanningPanelの構造変更

**目標**: すべてのセッションをレンダリングし、選択されたセッションのみ表示

#### 2.1 return文の変更

```typescript
// Before
return (
  <div className="planning-panel">
    {renderTabBar()}
    <div className="planning-panel__content">
      {selectedSession ? renderSessionDetail() : renderSessionList()}
    </div>
  </div>
);

// After
return (
  <div className="planning-panel">
    {renderTabBar()}
    <div className="planning-panel__content">
      {/* すべてのセッションをレンダリング */}
      {sessions.map(session => (
        <SessionDetail
          key={session.id}
          session={session}
          repoId={repoId}
          isActive={session.id === activeTabId}
          sidebarWidth={sidebarWidth}
          sidebarFullscreen={sidebarFullscreen}
          onSidebarWidthChange={setSidebarWidth}
          onSidebarFullscreenChange={setSidebarFullscreen}
          onSessionUpdate={(updates) => handleSessionUpdate(session.id, updates)}
          onSessionDelete={() => handleSessionDelete(session.id)}
          onTaskSuggested={handleTaskSuggested}
        />
      ))}
      {/* セッションが選択されていない場合はリストを表示 */}
      {!activeTabId && renderSessionList()}
    </div>
  </div>
);
```

#### 2.2 renderSessionDetail()の削除

- `renderSessionDetail()` 関数を完全に削除
- 関連するローカル状態も削除（SessionDetailに移動するため）

### Phase 3: 状態の移行

**目標**: PlanningPanelのセッション固有の状態をSessionDetailに移動

#### 3.1 移行する状態一覧

| 状態 | 移行先 | 備考 |
|-----|-------|------|
| `executeCurrentTaskInstruction` | SessionDetail | Execute用 |
| `executeAllTasksInstructions` | SessionDetail | Execute用 |
| `executeEditMode` | SessionDetail | Execute用 |
| `executeEditTitle` | SessionDetail | Execute用 |
| `executeEditBranches` | SessionDetail | Execute用 |
| `planningSelectedBranches` | SessionDetail | Planning用 |
| `planningCurrentBranchIndex` | SessionDetail | Planning用 |
| `userViewBranchIndex` | SessionDetail | Planning用 |
| `currentInstruction` | SessionDetail | Planning用 |
| `currentInstructionData` | SessionDetail | Planning用 |
| `planningAllBranchLinks` | SessionDetail | Planning用 |
| `claudeWorking` | SessionDetail | 共通 |
| `branchTodoCounts` | SessionDetail | Planning用 |
| `branchQuestionCounts` | SessionDetail | Planning用 |

#### 3.2 PlanningPanelに残す状態

| 状態 | 理由 |
|-----|------|
| `sessions` | セッション一覧（複数セッションに共通） |
| `activeTabId` | 選択状態（PlanningPanel全体で管理） |
| `showNewForm` | 新規作成フォーム |
| `sidebarWidth` | サイドバー幅（共有設定） |
| `sidebarFullscreen` | フルスクリーン状態（共有設定） |
| `error` | エラー表示 |

### Phase 4: WebSocketリスナーの整理

**目標**: 各セッションが独自のWebSocketリスナーを持ち、適切にクリーンアップ

#### 4.1 SessionDetail内でのリスナー管理

```typescript
useEffect(() => {
  // このセッションに関連するイベントのみ購読
  const unsubStart = wsClient.on("chat.streaming.start", (msg) => {
    if (msg.data.sessionId === session.chatSessionId) {
      setClaudeWorking(true);
    }
  });

  const unsubEnd = wsClient.on("chat.streaming.end", (msg) => {
    if (msg.data.sessionId === session.chatSessionId) {
      setClaudeWorking(false);
    }
  });

  return () => {
    unsubStart();
    unsubEnd();
  };
}, [session.chatSessionId]);
```

### Phase 5: テストと検証

#### 5.1 手動テスト項目

- [ ] セッション切り替え時にチャットメッセージが保持される
- [ ] セッション切り替え時にThinkingインジケータが正しく表示される
- [ ] セッション切り替え時にインストラクションが即座に切り替わる
- [ ] 複数セッションで同時にストリーミングが動作する
- [ ] サイドバーの状態が各セッションで独立している
- [ ] ブランチ切り替えが正しく動作する

---

## ファイル作成・変更の詳細

### 新規作成ファイル

```
frontend/src/components/
├── SessionDetail.tsx           # 400行程度
├── SessionDetail.css           # 100行程度
├── sessions/
│   ├── ExecuteSessionView.tsx  # 300行程度
│   ├── PlanningSessionView.tsx # 400行程度
│   └── RefinementSessionView.tsx # 200行程度
```

### 変更ファイル

```
frontend/src/components/
├── PlanningPanel.tsx           # 2600行 → 1000行程度（大幅削減）
├── PlanningPanel.css           # 微調整
```

---

## 実装順序

1. **SessionDetail.tsx** を作成（基本構造のみ）
2. **RefinementSessionView.tsx** を作成（最もシンプル）
3. PlanningPanelでRefinementセッションをSessionDetailに移行
4. 動作確認
5. **ExecuteSessionView.tsx** を作成
6. PlanningPanelでExecuteセッションをSessionDetailに移行
7. 動作確認
8. **PlanningSessionView.tsx** を作成
9. PlanningPanelでPlanningセッションをSessionDetailに移行
10. 動作確認
11. PlanningPanelから不要なコードを削除
12. 最終テスト

---

## リスクと対策

| リスク | 対策 |
|-------|------|
| 大規模な変更で既存機能が壊れる | 段階的に移行、各フェーズで動作確認 |
| propsのバケツリレーが増える | 必要に応じてContextを使用 |
| パフォーマンス低下（全セッションをレンダリング） | React.memoで最適化、display:noneで描画コスト削減 |

---

## 追加修正: UX改善

### 問題1: Thinkingインジケーターの状態が不明確

**現象**: AIが動いているのか完了したのかわからない

**原因**:
- claudeWorking状態がセッション切り替え時にリセットされる
- ストリーミング状態の同期が不完全

**修正**:
- SessionDetail内でclaudeWorkingを独立管理
- 初期ロード時にAPI（getStreamingState）で状態確認
- WebSocketで継続的に同期

### 問題2: 追加メッセージ送信で動かなくなる

**現象**: AIに追加で質問を投げると動かなくなる

**原因**:
- セッション切り替え時にChatPanelが再マウント
- ストリーミング中にコンポーネントがアンマウントされ、状態が消失

**修正**:
- ChatPanelをセッションごとに独立させる（display:noneで保持）
- アンマウントせずに状態を保持

### 問題3: ローディング状態の視覚的フィードバック不足

**修正**:
- Thinkingインジケーターを常に表示（ストリーミング中）
- 「Working...」「Completed」など状態を明示
- タブにもストリーミング中を示すバッジ表示

---

## 備考

- バックアップブランチ: `backup/session-independent-components-20260212-111125`
- 作業開始前に必ず `git status` で状態確認
- 各フェーズ完了後にコミット
