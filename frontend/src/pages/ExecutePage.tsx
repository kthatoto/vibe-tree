import { useState, useEffect, useCallback } from "react";
import { useSearchParams, Link } from "react-router-dom";
import {
  api,
  type Repo,
  type Plan,
  type ScanSnapshot,
  type Warning,
} from "../lib/api";
import { wsClient } from "../lib/ws";

export default function ExecutePage() {
  const [searchParams] = useSearchParams();
  const repoIdParam = searchParams.get("repoId");

  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(
    repoIdParam ? parseInt(repoIdParam) : null
  );
  const [plan, setPlan] = useState<Plan | null>(null);
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null);
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Load repos
  useEffect(() => {
    api.getRepos().then(setRepos).catch(console.error);
  }, []);

  // Load plan and scan when repo is selected
  useEffect(() => {
    if (!selectedRepoId) return;

    api.getCurrentPlan(selectedRepoId).then(setPlan).catch(console.error);

    // Connect WebSocket
    wsClient.connect(selectedRepoId);

    // Listen for updates
    const unsubScan = wsClient.on("scan.updated", (msg) => {
      setSnapshot(msg.data as ScanSnapshot);
    });

    // Initial scan
    handleScan();

    return () => {
      unsubScan();
    };
  }, [selectedRepoId]);

  const handleScan = useCallback(async () => {
    if (!selectedRepoId) return;
    setLoading(true);
    try {
      const result = await api.scan(selectedRepoId);
      setSnapshot(result);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedRepoId]);

  const handleLogInstruction = async () => {
    if (!selectedRepoId || !instruction.trim()) return;
    try {
      await api.logInstruction({
        repoId: selectedRepoId,
        planId: plan?.id,
        kind: "user_instruction",
        contentMd: instruction,
      });
      setInstruction("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const getWarningColor = (severity: "warn" | "error") =>
    severity === "error" ? "#fee" : "#fff8e8";

  return (
    <div style={{ padding: "20px", maxWidth: "1400px", margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "20px",
        }}
      >
        <h1>Vibe Tree - Execute</h1>
        <div>
          <Link to="/" style={{ marginRight: "15px" }}>
            Plan Mode
          </Link>
          {selectedRepoId && (
            <Link to={`/settings?repoId=${selectedRepoId}`}>Settings</Link>
          )}
        </div>
      </div>

      {error && (
        <div
          style={{
            background: "#fee",
            padding: "10px",
            marginBottom: "20px",
            borderRadius: "4px",
          }}
        >
          {error}
        </div>
      )}

      {/* Repo Selection */}
      <div
        style={{
          marginBottom: "20px",
          padding: "15px",
          background: "#f5f5f5",
          borderRadius: "8px",
          display: "flex",
          alignItems: "center",
          gap: "15px",
        }}
      >
        <select
          value={selectedRepoId || ""}
          onChange={(e) => setSelectedRepoId(Number(e.target.value) || null)}
          style={{ padding: "8px", minWidth: "300px" }}
        >
          <option value="">-- Select a repo --</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.path})
            </option>
          ))}
        </select>
        <button
          onClick={handleScan}
          disabled={loading || !selectedRepoId}
          style={{ padding: "8px 16px" }}
        >
          {loading ? "Scanning..." : "Refresh"}
        </button>
        {plan && (
          <span style={{ color: "#666" }}>
            Plan: <strong>{plan.title}</strong> ({plan.status})
            {plan.githubIssueUrl && (
              <a
                href={plan.githubIssueUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ marginLeft: "10px" }}
              >
                GitHub Issue
              </a>
            )}
          </span>
        )}
      </div>

      {selectedRepoId && snapshot && (
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "20px" }}>
          {/* Left: Tree */}
          <div
            style={{
              background: "#fff",
              border: "1px solid #ddd",
              borderRadius: "8px",
              padding: "15px",
            }}
          >
            <h3>Branch Tree</h3>
            <div style={{ fontFamily: "monospace", fontSize: "14px" }}>
              {snapshot.nodes.map((node) => {
                const edge = snapshot.edges.find(
                  (e) => e.child === node.branchName
                );
                const indent = edge ? "  └─ " : "";
                return (
                  <div
                    key={node.branchName}
                    style={{
                      padding: "8px",
                      marginBottom: "4px",
                      background: node.worktree?.dirty ? "#fff8e8" : "#f9f9f9",
                      borderRadius: "4px",
                      borderLeft: node.worktree
                        ? "3px solid #4CAF50"
                        : "3px solid transparent",
                    }}
                  >
                    <div>
                      {indent}
                      <strong>{node.branchName}</strong>
                      {node.badges.map((badge) => (
                        <span
                          key={badge}
                          style={{
                            marginLeft: "8px",
                            padding: "2px 6px",
                            fontSize: "12px",
                            borderRadius: "3px",
                            background:
                              badge === "dirty"
                                ? "#ff9800"
                                : badge === "ci-fail"
                                ? "#f44336"
                                : badge === "pr"
                                ? "#2196F3"
                                : "#9e9e9e",
                            color: "white",
                          }}
                        >
                          {badge}
                        </span>
                      ))}
                    </div>
                    {node.aheadBehind && (
                      <div style={{ fontSize: "12px", color: "#666" }}>
                        ↑{node.aheadBehind.ahead} ↓{node.aheadBehind.behind}
                      </div>
                    )}
                    {node.pr && (
                      <div style={{ fontSize: "12px" }}>
                        <a
                          href={node.pr.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          PR #{node.pr.number}: {node.pr.title}
                        </a>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: Warnings + Restart */}
          <div>
            {/* Warnings */}
            <div
              style={{
                background: "#fff",
                border: "1px solid #ddd",
                borderRadius: "8px",
                padding: "15px",
                marginBottom: "20px",
              }}
            >
              <h3>Warnings ({snapshot.warnings.length})</h3>
              {snapshot.warnings.length === 0 ? (
                <p style={{ color: "#4CAF50" }}>No warnings</p>
              ) : (
                snapshot.warnings.map((w, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "8px",
                      marginBottom: "8px",
                      background: getWarningColor(w.severity),
                      borderRadius: "4px",
                    }}
                  >
                    <strong>[{w.severity.toUpperCase()}]</strong> {w.code}
                    <div style={{ fontSize: "13px", marginTop: "4px" }}>
                      {w.message}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Restart Panel */}
            {snapshot.restart && (
              <div
                style={{
                  background: "#e8f4f8",
                  border: "1px solid #b8d4e8",
                  borderRadius: "8px",
                  padding: "15px",
                  marginBottom: "20px",
                }}
              >
                <h3>Restart Session</h3>
                <div style={{ marginBottom: "10px" }}>
                  <label>
                    <strong>Terminal Command:</strong>
                  </label>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      marginTop: "5px",
                    }}
                  >
                    <code
                      style={{
                        flex: 1,
                        padding: "8px",
                        background: "#fff",
                        borderRadius: "4px",
                      }}
                    >
                      {snapshot.restart.cdCommand}
                    </code>
                    <button
                      onClick={() =>
                        copyToClipboard(snapshot.restart!.cdCommand, "cd")
                      }
                      style={{ marginLeft: "10px", padding: "8px" }}
                    >
                      {copied === "cd" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
                <div>
                  <label>
                    <strong>Restart Prompt:</strong>
                  </label>
                  <div
                    style={{
                      marginTop: "5px",
                      maxHeight: "200px",
                      overflow: "auto",
                    }}
                  >
                    <pre
                      style={{
                        padding: "10px",
                        background: "#fff",
                        borderRadius: "4px",
                        fontSize: "12px",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {snapshot.restart.restartPromptMd}
                    </pre>
                  </div>
                  <button
                    onClick={() =>
                      copyToClipboard(
                        snapshot.restart!.restartPromptMd,
                        "prompt"
                      )
                    }
                    style={{ marginTop: "10px", padding: "8px 16px" }}
                  >
                    {copied === "prompt" ? "Copied!" : "Copy Restart Prompt"}
                  </button>
                </div>
              </div>
            )}

            {/* Instruction Logger */}
            <div
              style={{
                background: "#fff",
                border: "1px solid #ddd",
                borderRadius: "8px",
                padding: "15px",
              }}
            >
              <h3>Log Instruction</h3>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="Enter instruction for Claude..."
                style={{
                  width: "100%",
                  minHeight: "80px",
                  padding: "8px",
                  marginBottom: "10px",
                }}
              />
              <button
                onClick={handleLogInstruction}
                disabled={!instruction.trim()}
                style={{
                  padding: "8px 16px",
                  background: "#4CAF50",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                }}
              >
                Log Instruction
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
