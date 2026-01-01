import { useState, useEffect } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { api, type BranchNamingRule, type Repo } from "../lib/api";

export default function SettingsPage() {
  const [searchParams] = useSearchParams();
  const repoIdParam = searchParams.get("repoId");

  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(repoIdParam);
  const [rule, setRule] = useState<BranchNamingRule | null>(null);
  const [pattern, setPattern] = useState("");
  const [description, setDescription] = useState("");
  const [examples, setExamples] = useState<string[]>([]);
  const [newExample, setNewExample] = useState("");
  const [previewPlanId, setPreviewPlanId] = useState("1");
  const [previewSlug, setPreviewSlug] = useState("add-feature");
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load repos
  useEffect(() => {
    api.getRepos().then(setRepos).catch(console.error);
  }, []);

  // Load rule when repo is selected
  useEffect(() => {
    if (!selectedRepoId) return;

    api
      .getBranchNaming(selectedRepoId)
      .then((r) => {
        setRule(r);
        setPattern(r.pattern);
        setDescription(r.description);
        setExamples(r.examples);
      })
      .catch((err) => {
        console.error(err);
        // Create default rule if not exists
        setRule({ pattern: "vt/{planId}/{taskSlug}", description: "", examples: [] });
        setPattern("vt/{planId}/{taskSlug}");
        setDescription("");
        setExamples([]);
      });
  }, [selectedRepoId]);

  const handleSave = async () => {
    if (!selectedRepoId) return;
    setLoading(true);
    setSaved(false);
    try {
      const updated = await api.updateBranchNaming({
        repoId: selectedRepoId,
        pattern,
        description,
        examples,
      });
      setRule(updated);
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddExample = () => {
    if (newExample && !examples.includes(newExample)) {
      setExamples([...examples, newExample]);
      setNewExample("");
    }
  };

  const handleRemoveExample = (ex: string) => {
    setExamples(examples.filter((e) => e !== ex));
  };

  const generatePreview = () => {
    return pattern
      .replace("{planId}", previewPlanId)
      .replace("{taskSlug}", previewSlug);
  };

  return (
    <div style={{ padding: "20px", maxWidth: "800px", margin: "0 auto", minHeight: "100vh", background: "#0f172a" }}>
      <h1 style={{ color: "#e5e7eb" }}>Project Settings</h1>

      <div style={{ marginBottom: "20px" }}>
        <Link to="/" style={{ color: "#60a5fa" }}>← Back to Dashboard</Link>
      </div>

      {error && (
        <div
          style={{
            background: "#7f1d1d",
            color: "#f87171",
            padding: "10px",
            marginBottom: "20px",
            borderRadius: "4px",
          }}
        >
          {error}
        </div>
      )}

      {saved && (
        <div
          style={{
            background: "#14532d",
            color: "#4ade80",
            padding: "10px",
            marginBottom: "20px",
            borderRadius: "4px",
          }}
        >
          Settings saved successfully!
        </div>
      )}

      {/* Repo Selection */}
      <div
        style={{
          marginBottom: "20px",
          padding: "15px",
          background: "#1f2937",
          borderRadius: "8px",
          border: "1px solid #374151",
        }}
      >
        <h3 style={{ color: "#e5e7eb" }}>Select Repository</h3>
        <select
          value={selectedRepoId || ""}
          onChange={(e) => setSelectedRepoId(e.target.value || null)}
          style={{ padding: "8px", minWidth: "300px", background: "#111827", color: "#e5e7eb", border: "1px solid #374151", borderRadius: "4px" }}
        >
          <option value="">-- Select a repo --</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </select>
      </div>

      {selectedRepoId && rule && (
        <div
          style={{
            padding: "20px",
            background: "#1f2937",
            border: "1px solid #374151",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ color: "#e5e7eb" }}>Branch Naming Rule</h3>

          <div style={{ marginBottom: "15px" }}>
            <label style={{ color: "#e5e7eb" }}>
              <strong>Pattern:</strong>
            </label>
            <input
              type="text"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              style={{
                display: "block",
                width: "100%",
                padding: "8px",
                marginTop: "5px",
                fontFamily: "monospace",
                background: "#111827",
                color: "#e5e7eb",
                border: "1px solid #374151",
                borderRadius: "4px",
              }}
            />
            <small style={{ color: "#9ca3af" }}>
              Use {"{planId}"} and {"{taskSlug}"} as placeholders
            </small>
          </div>

          <div style={{ marginBottom: "15px" }}>
            <label style={{ color: "#e5e7eb" }}>
              <strong>Description:</strong>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{
                display: "block",
                width: "100%",
                padding: "8px",
                marginTop: "5px",
                minHeight: "60px",
                background: "#111827",
                color: "#e5e7eb",
                border: "1px solid #374151",
                borderRadius: "4px",
              }}
            />
          </div>

          <div style={{ marginBottom: "15px" }}>
            <label style={{ color: "#e5e7eb" }}>
              <strong>Examples:</strong>
            </label>
            <div style={{ marginTop: "5px" }}>
              {examples.map((ex, i) => (
                <span
                  key={i}
                  style={{
                    display: "inline-block",
                    background: "#374151",
                    padding: "4px 8px",
                    marginRight: "8px",
                    marginBottom: "8px",
                    borderRadius: "4px",
                    color: "#e5e7eb",
                  }}
                >
                  <code>{ex}</code>
                  <button
                    onClick={() => handleRemoveExample(ex)}
                    style={{
                      marginLeft: "8px",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "#9ca3af",
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div style={{ marginTop: "8px" }}>
              <input
                type="text"
                value={newExample}
                onChange={(e) => setNewExample(e.target.value)}
                placeholder="Add example..."
                style={{ padding: "6px", marginRight: "8px", background: "#111827", color: "#e5e7eb", border: "1px solid #374151", borderRadius: "4px" }}
                onKeyDown={(e) => e.key === "Enter" && handleAddExample()}
              />
              <button onClick={handleAddExample} style={{ background: "#3b82f6", color: "white", border: "none", borderRadius: "4px", padding: "6px 12px", cursor: "pointer" }}>Add</button>
            </div>
          </div>

          {/* Preview */}
          <div
            style={{
              marginBottom: "20px",
              padding: "15px",
              background: "#111827",
              borderRadius: "4px",
              border: "1px solid #374151",
            }}
          >
            <label style={{ color: "#e5e7eb" }}>
              <strong>Preview:</strong>
            </label>
            <div style={{ marginTop: "10px", display: "flex", gap: "10px" }}>
              <input
                type="text"
                value={previewPlanId}
                onChange={(e) => setPreviewPlanId(e.target.value)}
                placeholder="planId"
                style={{ width: "80px", padding: "6px", background: "#1f2937", color: "#e5e7eb", border: "1px solid #374151", borderRadius: "4px" }}
              />
              <input
                type="text"
                value={previewSlug}
                onChange={(e) => setPreviewSlug(e.target.value)}
                placeholder="taskSlug"
                style={{ width: "150px", padding: "6px", background: "#1f2937", color: "#e5e7eb", border: "1px solid #374151", borderRadius: "4px" }}
              />
              <code
                style={{
                  flex: 1,
                  padding: "6px 10px",
                  background: "#1f2937",
                  border: "1px solid #374151",
                  borderRadius: "4px",
                  color: "#e5e7eb",
                }}
              >
                {generatePreview()}
              </code>
            </div>
          </div>

          <button
            onClick={handleSave}
            disabled={loading}
            style={{
              padding: "10px 20px",
              background: "#22c55e",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "16px",
            }}
          >
            {loading ? "Saving..." : "Save Settings"}
          </button>
        </div>
      )}
    </div>
  );
}
