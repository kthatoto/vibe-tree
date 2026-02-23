import "./Chips.css";

// Helper to calculate text color based on background
function getTextColor(hexColor: string): string {
  const r = parseInt(hexColor.slice(0, 2), 16);
  const g = parseInt(hexColor.slice(2, 4), 16);
  const b = parseInt(hexColor.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#000000" : "#ffffff";
}

// GitHub Label Chip
interface LabelChipProps {
  name: string;
  color: string; // hex without #
  removed?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
}

export function LabelChip({ name, color, removed, onClick, onRemove }: LabelChipProps) {
  const bg = `#${color}`;
  const textColor = getTextColor(color);
  return (
    <span
      className={`chip chip--label ${removed ? "chip--removed" : ""} ${onClick ? "chip--clickable" : ""}`}
      style={{ background: bg, color: textColor }}
      onClick={onClick}
    >
      {name}
      {onRemove && (
        <button
          className="chip__remove"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          type="button"
        >
          ×
        </button>
      )}
    </span>
  );
}

// GitHub User Chip (for reviewers, assignees, etc.)
interface UserChipProps {
  login: string;
  name?: string;
  avatarUrl?: string;
  removed?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
}

export function UserChip({ login, name, avatarUrl, removed, onClick, onRemove }: UserChipProps) {
  const isCopilot = login.toLowerCase().includes("copilot");
  const displayName = name || (isCopilot ? "Copilot" : login);
  const avatar = avatarUrl || (isCopilot
    ? "https://avatars.githubusercontent.com/in/946600?v=4"
    : `https://github.com/${login}.png?size=32`);

  const handleImageError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    img.style.display = "none";
    const placeholder = document.createElement("span");
    placeholder.className = "chip__avatar-placeholder";
    placeholder.textContent = displayName.charAt(0).toUpperCase();
    img.parentElement?.insertBefore(placeholder, img);
  };

  return (
    <span
      className={`chip chip--user ${removed ? "chip--removed" : ""} ${onClick ? "chip--clickable" : ""}`}
      onClick={onClick}
    >
      <img
        src={avatar}
        alt={displayName}
        className="chip__avatar"
        onError={handleImageError}
      />
      <span className="chip__text">{displayName}</span>
      {onRemove && (
        <button
          className="chip__remove"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          type="button"
        >
          ×
        </button>
      )}
    </span>
  );
}

// Review Status Badge
type ReviewStatus = "approved" | "changes_requested" | "review_required" | "pending";

interface ReviewBadgeProps {
  status: ReviewStatus;
}

export function ReviewBadge({ status }: ReviewBadgeProps) {
  const config: Record<ReviewStatus, { icon: string; text: string; className: string }> = {
    approved: { icon: "✓", text: "Approved", className: "chip--review-approved" },
    changes_requested: { icon: "⚠", text: "Changes Requested", className: "chip--review-changes" },
    review_required: { icon: "○", text: "Review Required", className: "chip--review-required" },
    pending: { icon: "○", text: "Pending", className: "chip--review-pending" },
  };
  const { icon, text, className } = config[status] || config.pending;

  return (
    <span className={`chip chip--review ${className}`}>
      <span className="chip__icon">{icon}</span>
      <span className="chip__text">{text}</span>
    </span>
  );
}

// CI Status Badge
type CIStatus = "success" | "failure" | "pending" | "unknown";

interface CIBadgeProps {
  status: CIStatus;
  passed?: number;
  total?: number;
  onClick?: () => void;
}

export function CIBadge({ status, passed, total, onClick }: CIBadgeProps) {
  const config: Record<CIStatus, { icon: string; className: string }> = {
    success: { icon: "✔", className: "chip--ci-success" },
    failure: { icon: "✗", className: "chip--ci-failure" },
    pending: { icon: "⏳", className: "chip--ci-pending" },
    unknown: { icon: "?", className: "chip--ci-unknown" },
  };
  const { icon, className } = config[status] || config.unknown;
  const hasCount = typeof passed === "number" && typeof total === "number";

  return (
    <span
      className={`chip chip--ci ${className} ${onClick ? "chip--clickable" : ""}`}
      onClick={onClick}
    >
      <span className="chip__icon">{icon}</span>
      {hasCount && <span className="chip__count">{passed}/{total}</span>}
    </span>
  );
}
