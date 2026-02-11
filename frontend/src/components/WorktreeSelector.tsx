import { useState, useEffect } from "react";
import { api, type WorktreeInfo } from "../lib/api";
import "./WorktreeSelector.css";

interface WorktreeSelectorProps {
  repoId: string;
  onSelect: (worktreePath: string | null) => void;
  onCancel: () => void;
  selectedWorktreePath?: string | null;
}

export function WorktreeSelector({
  repoId,
  onSelect,
  onCancel,
  selectedWorktreePath,
}: WorktreeSelectorProps) {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [localPath, setLocalPath] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(selectedWorktreePath ?? null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.getWorktreesByRepo(repoId)
      .then((data) => {
        setWorktrees(data.worktrees);
        setLocalPath(data.localPath);
        // Default to first worktree if none selected
        if (!selectedWorktreePath && data.worktrees.length > 0) {
          setSelected(data.worktrees[0].path);
        }
      })
      .catch((err) => {
        setError(err.message || "Failed to load worktrees");
      })
      .finally(() => setLoading(false));
  }, [repoId, selectedWorktreePath]);

  const handleSelect = () => {
    onSelect(selected);
  };

  const handleUseDefault = () => {
    onSelect(null);
  };

  if (loading) {
    return (
      <div className="worktree-selector">
        <div className="worktree-selector__overlay" onClick={onCancel} />
        <div className="worktree-selector__dialog">
          <div className="worktree-selector__loading">Loading worktrees...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="worktree-selector">
        <div className="worktree-selector__overlay" onClick={onCancel} />
        <div className="worktree-selector__dialog">
          <div className="worktree-selector__header">
            <h3>Select Worktree</h3>
            <button className="worktree-selector__close" onClick={onCancel}>
              &times;
            </button>
          </div>
          <div className="worktree-selector__error">{error}</div>
          <div className="worktree-selector__actions">
            <button className="worktree-selector__btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="worktree-selector">
      <div className="worktree-selector__overlay" onClick={onCancel} />
      <div className="worktree-selector__dialog">
        <div className="worktree-selector__header">
          <h3>Select Worktree</h3>
          <button className="worktree-selector__close" onClick={onCancel}>
            &times;
          </button>
        </div>

        <div className="worktree-selector__description">
          Choose which worktree to use for this Execute session. Claude CLI will run in the selected directory.
        </div>

        <div className="worktree-selector__list">
          {worktrees.length === 0 ? (
            <div className="worktree-selector__empty">
              No worktrees found. Using default repository path.
            </div>
          ) : (
            worktrees.map((wt) => (
              <div
                key={wt.path}
                className={`worktree-selector__item ${selected === wt.path ? "worktree-selector__item--selected" : ""} ${wt.isActive ? "worktree-selector__item--active" : ""}`}
                onClick={() => setSelected(wt.path)}
              >
                <div className="worktree-selector__item-radio">
                  <input
                    type="radio"
                    name="worktree"
                    checked={selected === wt.path}
                    onChange={() => setSelected(wt.path)}
                  />
                </div>
                <div className="worktree-selector__item-content">
                  <div className="worktree-selector__item-directory">
                    {wt.path.split("/").pop() || wt.path}
                    {wt.dirty && <span className="worktree-selector__badge worktree-selector__badge--dirty">dirty</span>}
                    {wt.isActive && <span className="worktree-selector__badge worktree-selector__badge--active">in use</span>}
                  </div>
                  <div className="worktree-selector__item-branch">{wt.branch || "(detached)"}</div>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="worktree-selector__actions">
          <button
            className="worktree-selector__btn worktree-selector__btn--secondary"
            onClick={handleUseDefault}
          >
            Use Default ({localPath.split("/").pop()})
          </button>
          <button
            className="worktree-selector__btn worktree-selector__btn--primary"
            onClick={handleSelect}
            disabled={!selected && worktrees.length > 0}
          >
            Select
          </button>
        </div>
      </div>
    </div>
  );
}

export default WorktreeSelector;
