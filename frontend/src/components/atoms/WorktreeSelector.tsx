import { useMemo } from "react";
import type { TreeNode } from "../../lib/api";
import { Dropdown } from "./Dropdown";

interface WorktreeOption {
  label: string;
  value: string | null; // null means main repository
  branchName?: string;
}

interface WorktreeSelectorProps {
  nodes: TreeNode[];
  selectedWorktree: string | null;
  onSelect: (worktreePath: string | null) => void;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  disabled?: boolean;
  placeholder?: string;
}

export function WorktreeSelector({
  nodes,
  selectedWorktree,
  onSelect,
  isOpen,
  onOpen,
  onClose,
  disabled = false,
  placeholder = "Select worktree",
}: WorktreeSelectorProps) {
  // Get available worktrees from nodes
  const worktreeOptions = useMemo(() => {
    const options: WorktreeOption[] = [
      { label: "Main Repository (temporary checkout)", value: null },
    ];

    nodes.forEach((node) => {
      if (node.worktree) {
        const shortPath = node.worktree.path.split("/").slice(-2).join("/");
        options.push({
          label: `${node.branchName} (${shortPath})`,
          value: node.worktree.path,
          branchName: node.branchName,
        });
      }
    });

    return options;
  }, [nodes]);

  // Get display label for selected worktree
  const selectedLabel = useMemo(() => {
    if (selectedWorktree === null) {
      return "Main Repository";
    }
    const option = worktreeOptions.find((o) => o.value === selectedWorktree);
    return option?.label || placeholder;
  }, [selectedWorktree, worktreeOptions, placeholder]);

  return (
    <Dropdown
      isOpen={isOpen}
      onClose={onClose}
      trigger={
        <button
          type="button"
          disabled={disabled}
          onClick={() => !disabled && onOpen()}
          style={{
            width: "100%",
            padding: "8px 12px",
            background: disabled ? "#1f2937" : "#0f172a",
            border: "1px solid #374151",
            borderRadius: 6,
            color: disabled ? "#6b7280" : "#e5e7eb",
            cursor: disabled ? "not-allowed" : "pointer",
            fontSize: 12,
            textAlign: "left",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selectedLabel}
          </span>
          <span style={{ color: "#6b7280", fontSize: 10 }}>▼</span>
        </button>
      }
    >
      <div style={{ maxHeight: 200, overflowY: "auto" }}>
        {worktreeOptions.map((option) => {
          const isSelected = option.value === selectedWorktree;
          return (
            <button
              key={option.value ?? "main"}
              onClick={() => {
                onSelect(option.value);
                onClose();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "8px 12px",
                background: isSelected ? "#374151" : "transparent",
                border: "none",
                color: "#e5e7eb",
                fontSize: 12,
                textAlign: "left",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                if (!isSelected) e.currentTarget.style.background = "#2d3748";
              }}
              onMouseLeave={(e) => {
                if (!isSelected) e.currentTarget.style.background = "transparent";
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  border: isSelected ? "none" : "1px solid #4b5563",
                  background: isSelected ? "#3b82f6" : "transparent",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  color: "#fff",
                  flexShrink: 0,
                }}
              >
                {isSelected && "✓"}
              </span>
              <div style={{ flex: 1, overflow: "hidden" }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {option.label}
                </div>
                {option.branchName && (
                  <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>
                    Branch: {option.branchName}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </Dropdown>
  );
}
