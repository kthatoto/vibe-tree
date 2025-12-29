import { useState, useEffect, useCallback } from "react";
import { api, type Plan, type BranchNamingRule, type ScanSnapshot } from "./api";
import { wsClient } from "./ws";

// Generic async state hook
interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

function useAsync<T>(
  asyncFn: () => Promise<T>,
  deps: React.DependencyList = []
): AsyncState<T> & { refetch: () => void } {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  const execute = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await asyncFn();
      setState({ data, loading: false, error: null });
    } catch (err) {
      setState({
        data: null,
        loading: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, deps);

  useEffect(() => {
    execute();
  }, [execute]);

  return { ...state, refetch: execute };
}

// Repos hook
export function useRepos() {
  return useAsync(() => api.getRepos(), []);
}

// Single repo hook
export function useRepo(owner: string | null, name: string | null) {
  return useAsync(
    async () => {
      if (!owner || !name) return null;
      return api.getRepo(owner, name);
    },
    [owner, name]
  );
}

// Branch naming hook with WebSocket updates
export function useBranchNaming(repoId: string | null) {
  const [data, setData] = useState<BranchNamingRule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!repoId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await api.getBranchNaming(repoId);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [repoId]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  // Listen for WebSocket updates
  useEffect(() => {
    if (!repoId) return;

    const unsubscribe = wsClient.on("projectRules.updated", (msg) => {
      if (msg.repoId === repoId && msg.data) {
        setData(msg.data as BranchNamingRule);
      }
    });

    return unsubscribe;
  }, [repoId]);

  return { data, loading, error, refetch: fetch };
}

// Plan hook with WebSocket updates
export function usePlan(repoId: string | null) {
  const [data, setData] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!repoId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await api.getCurrentPlan(repoId);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [repoId]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  // Listen for WebSocket updates
  useEffect(() => {
    if (!repoId) return;

    const unsubscribe = wsClient.on("plan.updated", (msg) => {
      if (msg.repoId === repoId && msg.data) {
        setData(msg.data as Plan);
      }
    });

    return unsubscribe;
  }, [repoId]);

  return { data, loading, error, refetch: fetch, setData };
}

// Scan hook with WebSocket updates
export function useScan(localPath: string | null) {
  const [data, setData] = useState<ScanSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    if (!localPath) return;
    setLoading(true);
    try {
      const result = await api.scan(localPath);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [localPath]);

  // Listen for WebSocket updates
  useEffect(() => {
    if (!data?.repoId) return;

    wsClient.connect(data.repoId);

    const unsubscribe = wsClient.on("scan.updated", (msg) => {
      if (msg.repoId === data.repoId && msg.data) {
        setData(msg.data as ScanSnapshot);
      }
    });

    return unsubscribe;
  }, [data?.repoId]);

  return { data, loading, error, scan };
}

// Clipboard hook
export function useClipboard() {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  return { copied, copy };
}

// Local storage hook for persisting state
export function useLocalStorage<T>(key: string, initialValue: T) {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch {
      return initialValue;
    }
  });

  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      try {
        const valueToStore =
          value instanceof Function ? value(storedValue) : value;
        setStoredValue(valueToStore);
        window.localStorage.setItem(key, JSON.stringify(valueToStore));
      } catch (error) {
        console.error("Error saving to localStorage:", error);
      }
    },
    [key, storedValue]
  );

  return [storedValue, setValue] as const;
}
