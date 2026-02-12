import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faSync, faTimes } from "@fortawesome/free-solid-svg-icons";

interface ScanUpdateToastProps {
  message: string;
  diffSummary?: string;
  onApply: () => void;
  onDismiss: () => void;
  isEditing?: boolean;
  isApplying?: boolean;
}

export function ScanUpdateToast({
  message,
  diffSummary,
  onApply,
  onDismiss,
  isEditing = false,
  isApplying = false,
}: ScanUpdateToastProps) {
  return (
    <div className="scan-update-toast">
      <div className="scan-update-toast__content">
        <span className="scan-update-toast__message">{message}</span>
        {diffSummary && (
          <span className="scan-update-toast__diff">{diffSummary}</span>
        )}
      </div>
      <div className="scan-update-toast__actions">
        <button
          className="scan-update-toast__apply"
          onClick={onApply}
          disabled={isEditing || isApplying}
          title={isEditing ? "Exit edit mode first to apply updates" : "Apply update"}
        >
          {isApplying ? (
            <FontAwesomeIcon icon={faSync} spin />
          ) : (
            "Apply"
          )}
        </button>
        <button
          className="scan-update-toast__dismiss"
          onClick={onDismiss}
          title="Dismiss"
        >
          <FontAwesomeIcon icon={faTimes} />
        </button>
      </div>
      {isEditing && (
        <div className="scan-update-toast__warning">
          Exit edit mode to apply
        </div>
      )}
    </div>
  );
}
