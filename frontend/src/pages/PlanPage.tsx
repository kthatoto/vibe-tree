import { useState, useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { api, type Repo, type Plan, type BranchNamingRule } from "../lib/api";

export default function PlanPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const repoIdParam = searchParams.get("repoId");

  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(
    repoIdParam ? parseInt(repoIdParam) : null
  );
  const [plan, setPlan] = useState<Plan | null>(null);
  const [branchNaming, setBranchNaming] = useState<BranchNamingRule | null>(
    null
  );
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [newRepoPath, setNewRepoPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load repos
  useEffect(() => {
    api.getRepos().then(setRepos).catch(console.error);
  }, []);

  // Load plan and branch naming when repo is selected
  useEffect(() => {
    if (!selectedRepoId) return;

    Promise.all([
      api.getCurrentPlan(selectedRepoId),
      api.getBranchNaming(selectedRepoId),
    ])
      .then(([p, bn]) => {
        setPlan(p);
        setBranchNaming(bn);
        if (p) {
          setTitle(p.title);
          setContent(p.contentMd);
          // If already committed, redirect to execute
          if (p.status === "committed") {
            navigate(`/execute?repoId=${selectedRepoId}`);
          }
        }
      })
      .catch((err) => {
        console.error(err);
        setError(err.message);
      });
  }, [selectedRepoId, navigate]);

  const handleCreateRepo = async () => {
    if (!newRepoPath) return;
    try {
      const repo = await api.createRepo(newRepoPath);
      setRepos([...repos, repo]);
      setSelectedRepoId(repo.id);
      setNewRepoPath("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleStartPlan = async () => {
    if (!selectedRepoId || !title) return;
    setLoading(true);
    try {
      const newPlan = await api.startPlan(selectedRepoId, title);
      setPlan(newPlan);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePlan = async () => {
    if (!plan) return;
    setLoading(true);
    try {
      const updated = await api.updatePlan(plan.id, content);
      setPlan(updated);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!plan) return;
    setLoading(true);
    try {
      await api.updatePlan(plan.id, content);
      const committed = await api.commitPlan(plan.id);
      setPlan(committed);
      navigate(`/execute?repoId=${selectedRepoId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: "20px", maxWidth: "1200px", margin: "0 auto" }}>
      <h1>Vibe Tree - Plan Mode</h1>

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
        }}
      >
        <h3>Select Repository</h3>
        <select
          value={selectedRepoId || ""}
          onChange={(e) => setSelectedRepoId(Number(e.target.value) || null)}
          style={{ padding: "8px", marginRight: "10px", minWidth: "300px" }}
        >
          <option value="">-- Select a repo --</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.path})
            </option>
          ))}
        </select>

        <div style={{ marginTop: "10px" }}>
          <input
            type="text"
            placeholder="Add new repo path..."
            value={newRepoPath}
            onChange={(e) => setNewRepoPath(e.target.value)}
            style={{ padding: "8px", marginRight: "10px", width: "300px" }}
          />
          <button onClick={handleCreateRepo} style={{ padding: "8px 16px" }}>
            Add Repo
          </button>
        </div>
      </div>

      {selectedRepoId && (
        <>
          {/* Branch Naming Rule (Read-Only) */}
          <div
            style={{
              marginBottom: "20px",
              padding: "15px",
              background: "#e8f4f8",
              borderRadius: "8px",
            }}
          >
            <h3>
              Branch Naming Rule{" "}
              <Link
                to={`/settings?repoId=${selectedRepoId}`}
                style={{ fontSize: "14px" }}
              >
                (Edit in Settings)
              </Link>
            </h3>
            {branchNaming && (
              <>
                <p>
                  <strong>Pattern:</strong>{" "}
                  <code>{branchNaming.pattern}</code>
                </p>
                <p>
                  <strong>Examples:</strong>{" "}
                  {branchNaming.examples.map((e, i) => (
                    <code key={i} style={{ marginRight: "8px" }}>
                      {e}
                    </code>
                  ))}
                </p>
              </>
            )}
          </div>

          {/* Plan Editor */}
          <div
            style={{
              marginBottom: "20px",
              padding: "15px",
              background: "#fff",
              border: "1px solid #ddd",
              borderRadius: "8px",
            }}
          >
            <h3>Plan</h3>

            {!plan ? (
              <div>
                <input
                  type="text"
                  placeholder="Plan title..."
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  style={{
                    padding: "8px",
                    marginRight: "10px",
                    width: "400px",
                  }}
                />
                <button
                  onClick={handleStartPlan}
                  disabled={loading || !title}
                  style={{ padding: "8px 16px" }}
                >
                  Start Plan
                </button>
              </div>
            ) : (
              <>
                <h4>{plan.title}</h4>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Write your plan in markdown..."
                  style={{
                    width: "100%",
                    minHeight: "300px",
                    padding: "10px",
                    fontFamily: "monospace",
                    fontSize: "14px",
                  }}
                />
                <div style={{ marginTop: "10px" }}>
                  <button
                    onClick={handleUpdatePlan}
                    disabled={loading}
                    style={{
                      padding: "8px 16px",
                      marginRight: "10px",
                      background: "#eee",
                    }}
                  >
                    Save Draft
                  </button>
                  <button
                    onClick={handleCommit}
                    disabled={loading}
                    style={{
                      padding: "8px 16px",
                      background: "#4CAF50",
                      color: "white",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    Commit & Go to Execute
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
