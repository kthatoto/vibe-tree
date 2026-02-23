import { useMemo } from "react";

interface MultiSelectPanelProps {
  selectedBranches: Set<string>;
  checkedBranches: Set<string>;
  onCheckAll: () => void;
  onUncheckAll: () => void;
  onClearSelection: () => void;
}

export default function MultiSelectPanel({
  selectedBranches,
  checkedBranches,
  onCheckAll,
  onUncheckAll,
  onClearSelection,
}: MultiSelectPanelProps) {
  const selectedList = useMemo(() => [...selectedBranches], [selectedBranches]);
  const displayLimit = 10;
  const displayedBranches = selectedList.slice(0, displayLimit);
  const remainingCount = selectedList.length - displayLimit;

  // Check if all selected branches are checked/unchecked
  const allChecked = useMemo(() => {
    return selectedList.every(b => checkedBranches.has(b));
  }, [selectedList, checkedBranches]);

  const noneChecked = useMemo(() => {
    return selectedList.every(b => !checkedBranches.has(b));
  }, [selectedList, checkedBranches]);

  return (
    <div className="panel">
      <div className="panel__header">
        <h3>{selectedBranches.size} branches selected</h3>
        <button
          className="btn-icon btn-icon--small"
          onClick={onClearSelection}
          title="Clear selection"
          style={{ marginLeft: "auto" }}
        >
          ×
        </button>
      </div>

      <div style={{ padding: "16px" }}>
        {/* Selected branches list */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8 }}>
            Selected branches:
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {displayedBranches.map((branch) => (
              <div
                key={branch}
                style={{
                  padding: "4px 8px",
                  background: "#1f2937",
                  borderRadius: 4,
                  fontSize: 13,
                  color: "#e5e7eb",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {branch}
              </div>
            ))}
            {remainingCount > 0 && (
              <div style={{ color: "#6b7280", fontSize: 12, paddingLeft: 8 }}>
                ...and {remainingCount} more
              </div>
            )}
          </div>
        </div>

        {/* Bulk actions */}
        <div style={{ borderTop: "1px solid #374151", paddingTop: 16 }}>
          <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8 }}>
            Bulk actions:
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              onClick={onCheckAll}
              disabled={allChecked}
              style={{
                padding: "8px 12px",
                background: allChecked ? "#1f2937" : "#14532d",
                border: `1px solid ${allChecked ? "#374151" : "#22c55e"}`,
                borderRadius: 6,
                color: allChecked ? "#6b7280" : "#4ade80",
                cursor: allChecked ? "not-allowed" : "pointer",
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span>Check All</span>
              <span style={{ color: "#9ca3af", fontSize: 11 }}>
                (hide in filter)
              </span>
            </button>
            <button
              onClick={onUncheckAll}
              disabled={noneChecked}
              style={{
                padding: "8px 12px",
                background: noneChecked ? "#1f2937" : "#7f1d1d",
                border: `1px solid ${noneChecked ? "#374151" : "#ef4444"}`,
                borderRadius: 6,
                color: noneChecked ? "#6b7280" : "#f87171",
                cursor: noneChecked ? "not-allowed" : "pointer",
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span>Uncheck All</span>
              <span style={{ color: "#9ca3af", fontSize: 11 }}>
                (show in filter)
              </span>
            </button>
          </div>
        </div>

        {/* Keyboard shortcuts hint */}
        <div style={{ marginTop: 16, padding: 12, background: "#1f2937", borderRadius: 6 }}>
          <div style={{ color: "#9ca3af", fontSize: 11, marginBottom: 6 }}>
            Selection shortcuts:
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#6b7280" }}>
            <div>
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginRight: 4 }}>Click</kbd>
              Single select
            </div>
            <div>
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginRight: 4 }}>Cmd</kbd>
              +
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginLeft: 4, marginRight: 4 }}>Click</kbd>
              Toggle
            </div>
            <div>
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginRight: 4 }}>Shift</kbd>
              +
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginLeft: 4, marginRight: 4 }}>Click</kbd>
              Range select
            </div>
            <div>
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginRight: 4 }}>Drag</kbd>
              Rectangle select
            </div>
            <div>
              <kbd style={{ background: "#374151", padding: "2px 4px", borderRadius: 3, marginRight: 4 }}>ESC</kbd>
              Clear selection
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
