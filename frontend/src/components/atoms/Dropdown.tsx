import { useEffect, useRef, ReactNode } from "react";

interface DropdownProps {
  isOpen: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  width?: number | string;
}

export function Dropdown({
  isOpen,
  onClose,
  trigger,
  children,
  align = "left",
  width = "100%",
}: DropdownProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose]);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {trigger}
      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            [align]: 0,
            width,
            background: "#1f2937",
            border: "1px solid #374151",
            borderRadius: 6,
            marginTop: 4,
            maxHeight: 240,
            overflowY: "auto",
            zIndex: 20,
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

interface DropdownItemProps {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}

export function DropdownItem({ onClick, children, disabled }: DropdownItemProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "8px 12px",
        background: "transparent",
        border: "none",
        color: disabled ? "#6b7280" : "#e5e7eb",
        fontSize: 12,
        textAlign: "left",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "#374151";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

export function DropdownEmpty({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "12px", color: "#6b7280", fontSize: 12, textAlign: "center" }}>
      {children}
    </div>
  );
}
