import { useState, useEffect, useMemo } from "react";
import { api, RequirementsNote, Plan } from "../lib/api";

interface RequirementsPanelProps {
  repoId: string;
  plan: Plan | null;
  onPlanUpdate?: (plan: Plan) => void;
  onTasksExtracted?: (tasks: { title: string; description?: string }[]) => void;
}

export function RequirementsPanel({
  repoId,
  plan,
  onPlanUpdate,
  onTasksExtracted,
}: RequirementsPanelProps) {
  const [notes, setNotes] = useState<RequirementsNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Plan editing state
  const [planTitle, setPlanTitle] = useState(plan?.title || "");
  const [planContent, setPlanContent] = useState(plan?.contentMd || "");
  const [planDirty, setPlanDirty] = useState(false);

  // Quick link add
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [newLinkTitle, setNewLinkTitle] = useState("");

  // Quick task input
  const [quickTasks, setQuickTasks] = useState("");

  // Collapsed sections
  const [sectionsOpen, setSectionsOpen] = useState({
    plan: true,
    links: true,
    tasks: true,
    notes: false,
  });

  useEffect(() => {
    loadNotes();
  }, [repoId]);

  useEffect(() => {
    if (plan) {
      setPlanTitle(plan.title);
      setPlanContent(plan.contentMd);
      setPlanDirty(false);
    }
  }, [plan?.id]);

  const loadNotes = async () => {
    try {
      setLoading(true);
      const data = await api.getRequirements(repoId);
      setNotes(data);
    } catch (err) {
      console.error("Failed to load requirements:", err);
    } finally {
      setLoading(false);
    }
  };

  // Extract all links from notes
  const allLinks = useMemo(() => {
    return notes
      .filter((n) => n.notionUrl)
      .map((n) => ({
        id: n.id,
        url: n.notionUrl!,
        title: n.title || new URL(n.notionUrl!).hostname,
        type: n.noteType,
      }));
  }, [notes]);

  const handleSavePlan = async () => {
    if (!plan) return;
    try {
      setSaving(true);
      const updated = await api.updatePlan(plan.id, planContent);
      onPlanUpdate?.(updated);
      setPlanDirty(false);
    } catch (err) {
      console.error("Failed to save plan:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleAddLink = async () => {
    if (!newLinkUrl.trim()) return;
    try {
      setSaving(true);
      const created = await api.createRequirement({
        repoId,
        planId: plan?.id,
        noteType: "notion",
        title: newLinkTitle || undefined,
        notionUrl: newLinkUrl,
      });
      setNotes((prev) => [created, ...prev]);
      setNewLinkUrl("");
      setNewLinkTitle("");
    } catch (err) {
      console.error("Failed to add link:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteLink = async (noteId: number) => {
    try {
      await api.deleteRequirement(noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
    } catch (err) {
      console.error("Failed to delete:", err);
    }
  };

  const handleAddTasksToBacklog = () => {
    const lines = quickTasks
      .split("\n")
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) return;

    const tasks = lines.map((line) => {
      // Check if line has description after ":"
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        return {
          title: line.substring(0, colonIndex).trim(),
          description: line.substring(colonIndex + 1).trim(),
        };
      }
      return { title: line };
    });

    onTasksExtracted?.(tasks);
    setQuickTasks("");
  };

  const toggleSection = (section: keyof typeof sectionsOpen) => {
    setSectionsOpen((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  return (
    <div className="requirements-panel">
      <div className="requirements-panel__header">
        <h2>Requirements</h2>
        <span className="requirements-panel__subtitle">
          要件を整理してからタスク化へ進みましょう
        </span>
      </div>

      <div className="requirements-panel__content">
        {/* Plan Section */}
        <section className="req-section">
          <button
            className="req-section__toggle"
            onClick={() => toggleSection("plan")}
          >
            <span className="req-section__icon">{sectionsOpen.plan ? "▼" : "▶"}</span>
            <span className="req-section__title">Plan / PRD</span>
            {planDirty && <span className="req-section__badge">未保存</span>}
          </button>
          {sectionsOpen.plan && (
            <div className="req-section__body">
              {plan ? (
                <>
                  <input
                    type="text"
                    className="req-input req-input--title"
                    value={planTitle}
                    onChange={(e) => {
                      setPlanTitle(e.target.value);
                      setPlanDirty(true);
                    }}
                    placeholder="Plan title..."
                  />
                  <textarea
                    className="req-textarea"
                    value={planContent}
                    onChange={(e) => {
                      setPlanContent(e.target.value);
                      setPlanDirty(true);
                    }}
                    placeholder="要件・仕様・背景などをMarkdownで記述..."
                    rows={8}
                  />
                  <div className="req-actions">
                    <button
                      className="req-btn req-btn--primary"
                      onClick={handleSavePlan}
                      disabled={saving || !planDirty}
                    >
                      {saving ? "Saving..." : "Save Plan"}
                    </button>
                  </div>
                </>
              ) : (
                <div className="req-empty">
                  Planを作成してください（サイドバーの「New Plan」）
                </div>
              )}
            </div>
          )}
        </section>

        {/* Links Section */}
        <section className="req-section">
          <button
            className="req-section__toggle"
            onClick={() => toggleSection("links")}
          >
            <span className="req-section__icon">{sectionsOpen.links ? "▼" : "▶"}</span>
            <span className="req-section__title">Links</span>
            <span className="req-section__count">{allLinks.length}</span>
          </button>
          {sectionsOpen.links && (
            <div className="req-section__body">
              {allLinks.length > 0 && (
                <ul className="req-links">
                  {allLinks.map((link) => (
                    <li key={link.id} className="req-link">
                      <a href={link.url} target="_blank" rel="noopener noreferrer">
                        🔗 {link.title}
                      </a>
                      <button
                        className="req-link__delete"
                        onClick={() => handleDeleteLink(link.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="req-link-form">
                <input
                  type="text"
                  className="req-input"
                  value={newLinkUrl}
                  onChange={(e) => setNewLinkUrl(e.target.value)}
                  placeholder="https://notion.so/... or any URL"
                />
                <input
                  type="text"
                  className="req-input req-input--small"
                  value={newLinkTitle}
                  onChange={(e) => setNewLinkTitle(e.target.value)}
                  placeholder="Title (optional)"
                />
                <button
                  className="req-btn"
                  onClick={handleAddLink}
                  disabled={!newLinkUrl.trim() || saving}
                >
                  Add Link
                </button>
              </div>
              <p className="req-hint">
                💡 リンクはGitHub Issue作成時に自動で含まれます
              </p>
            </div>
          )}
        </section>

        {/* Quick Tasks Section */}
        <section className="req-section">
          <button
            className="req-section__toggle"
            onClick={() => toggleSection("tasks")}
          >
            <span className="req-section__icon">{sectionsOpen.tasks ? "▼" : "▶"}</span>
            <span className="req-section__title">Quick Tasks → Backlog</span>
          </button>
          {sectionsOpen.tasks && (
            <div className="req-section__body">
              <textarea
                className="req-textarea req-textarea--tasks"
                value={quickTasks}
                onChange={(e) => setQuickTasks(e.target.value)}
                placeholder={`1行 = 1タスク で入力
例:
- ログイン機能実装
- ユーザー登録画面: バリデーション含む
- API設計`}
                rows={5}
              />
              <div className="req-actions">
                <button
                  className="req-btn req-btn--secondary"
                  onClick={handleAddTasksToBacklog}
                  disabled={!quickTasks.trim()}
                >
                  → Backlogに追加
                </button>
              </div>
              <p className="req-hint">
                💡 要件からタスクを洗い出してここに書き出し、Backlogに追加できます
              </p>
            </div>
          )}
        </section>

        {/* Notes Section (collapsed by default) */}
        <section className="req-section">
          <button
            className="req-section__toggle"
            onClick={() => toggleSection("notes")}
          >
            <span className="req-section__icon">{sectionsOpen.notes ? "▼" : "▶"}</span>
            <span className="req-section__title">Memo / Notes</span>
            <span className="req-section__count">
              {notes.filter((n) => n.noteType === "memo").length}
            </span>
          </button>
          {sectionsOpen.notes && (
            <div className="req-section__body">
              {loading ? (
                <div className="req-empty">Loading...</div>
              ) : notes.filter((n) => n.noteType === "memo").length === 0 ? (
                <div className="req-empty">メモはまだありません</div>
              ) : (
                <div className="req-notes">
                  {notes
                    .filter((n) => n.noteType === "memo")
                    .map((note) => (
                      <div key={note.id} className="req-note">
                        {note.title && <strong>{note.title}</strong>}
                        <pre>{note.content}</pre>
                        <button
                          className="req-note__delete"
                          onClick={() => handleDeleteLink(note.id)}
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <style>{`
        .requirements-panel {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: #0f172a;
          overflow: hidden;
        }
        .requirements-panel__header {
          padding: 16px 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
        }
        .requirements-panel__header h2 {
          margin: 0 0 4px 0;
          font-size: 18px;
          font-weight: 600;
        }
        .requirements-panel__subtitle {
          font-size: 12px;
          opacity: 0.9;
        }
        .requirements-panel__content {
          flex: 1;
          overflow-y: auto;
          padding: 12px;
        }

        .req-section {
          background: #1f2937;
          border-radius: 8px;
          margin-bottom: 12px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        .req-section__toggle {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 16px;
          background: none;
          border: none;
          cursor: pointer;
          text-align: left;
          font-size: 14px;
          font-weight: 500;
          color: #e5e7eb;
        }
        .req-section__toggle:hover {
          background: #374151;
        }
        .req-section__icon {
          font-size: 10px;
          color: #6b7280;
        }
        .req-section__title {
          flex: 1;
        }
        .req-section__count {
          background: #374151;
          color: #9ca3af;
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 10px;
        }
        .req-section__badge {
          background: #422006;
          color: #fbbf24;
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 4px;
        }
        .req-section__body {
          padding: 0 16px 16px 16px;
        }

        .req-input {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #374151;
          border-radius: 6px;
          font-size: 13px;
          margin-bottom: 8px;
        }
        .req-input:focus {
          outline: none;
          border-color: #818cf8;
          box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.2);
        }
        .req-input--title {
          font-size: 15px;
          font-weight: 500;
        }
        .req-input--small {
          width: auto;
          flex: 1;
        }

        .req-textarea {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #374151;
          border-radius: 6px;
          font-size: 13px;
          font-family: inherit;
          resize: vertical;
          min-height: 100px;
        }
        .req-textarea:focus {
          outline: none;
          border-color: #818cf8;
          box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.2);
        }
        .req-textarea--tasks {
          font-family: monospace;
          font-size: 12px;
        }

        .req-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          margin-top: 12px;
        }

        .req-btn {
          padding: 8px 16px;
          border: none;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          background: #374151;
          color: #d1d5db;
        }
        .req-btn:hover:not(:disabled) {
          background: #4b5563;
        }
        .req-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .req-btn--primary {
          background: #667eea;
          color: white;
        }
        .req-btn--primary:hover:not(:disabled) {
          background: #4f46e5;
        }
        .req-btn--secondary {
          background: #10b981;
          color: white;
        }
        .req-btn--secondary:hover:not(:disabled) {
          background: #047857;
        }

        .req-empty {
          text-align: center;
          padding: 20px;
          color: #6b7280;
          font-size: 13px;
        }

        .req-hint {
          margin: 12px 0 0 0;
          font-size: 11px;
          color: #6b7280;
        }

        .req-links {
          list-style: none;
          margin: 0 0 12px 0;
          padding: 0;
        }
        .req-link {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 0;
          border-bottom: 1px solid #374151;
        }
        .req-link:last-child {
          border-bottom: none;
        }
        .req-link a {
          flex: 1;
          color: #818cf8;
          text-decoration: none;
          font-size: 13px;
        }
        .req-link a:hover {
          text-decoration: underline;
        }
        .req-link__delete {
          background: none;
          border: none;
          color: #6b7280;
          cursor: pointer;
          font-size: 14px;
          padding: 4px;
        }
        .req-link__delete:hover {
          color: #f87171;
        }

        .req-link-form {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .req-link-form .req-input:first-child {
          flex: 2;
          min-width: 200px;
        }

        .req-notes {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .req-note {
          padding: 12px;
          background: #0f172a;
          border-radius: 6px;
          font-size: 13px;
        }
        .req-note strong {
          display: block;
          margin-bottom: 4px;
        }
        .req-note pre {
          margin: 0;
          white-space: pre-wrap;
          font-family: inherit;
        }
        .req-note__delete {
          margin-top: 8px;
          font-size: 11px;
          color: #f87171;
          background: none;
          border: none;
          cursor: pointer;
        }
      `}</style>
    </div>
  );
}
