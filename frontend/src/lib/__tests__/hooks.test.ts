import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useClipboard,
  useLocalStorage,
  useRepos,
  useRepo,
  useBranchNaming,
  usePlan,
  useScan,
} from '../hooks';
import { api } from '../api';
import { wsClient } from '../ws';

// Mock api module
vi.mock('../api', () => ({
  api: {
    getRepos: vi.fn(),
    getRepo: vi.fn(),
    getBranchNaming: vi.fn(),
    getCurrentPlan: vi.fn(),
    scan: vi.fn(),
  },
}));

// Mock wsClient
vi.mock('../ws', () => ({
  wsClient: {
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
  },
}));

describe('useClipboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should copy text to clipboard', async () => {
    const { result } = renderHook(() => useClipboard());

    expect(result.current.copied).toBeNull();

    act(() => {
      result.current.copy('test text', 'label');
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('test text');
    expect(result.current.copied).toBe('label');
  });

  it('should reset copied state after timeout', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useClipboard());

    act(() => {
      result.current.copy('test', 'label');
    });

    expect(result.current.copied).toBe('label');

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.copied).toBeNull();

    vi.useRealTimers();
  });
});

describe('useLocalStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should return initial value when nothing stored', () => {
    const { result } = renderHook(() =>
      useLocalStorage('test-key', 'initial')
    );

    expect(result.current[0]).toBe('initial');
  });

  it('should return stored value', () => {
    localStorage.setItem('test-key', JSON.stringify('stored'));

    const { result } = renderHook(() =>
      useLocalStorage('test-key', 'initial')
    );

    expect(result.current[0]).toBe('stored');
  });

  it('should update stored value', () => {
    const { result } = renderHook(() =>
      useLocalStorage('test-key', 'initial')
    );

    act(() => {
      result.current[1]('updated');
    });

    expect(result.current[0]).toBe('updated');
    expect(JSON.parse(localStorage.getItem('test-key') || '')).toBe('updated');
  });

  it('should handle function updates', () => {
    const { result } = renderHook(() =>
      useLocalStorage('test-key', 0)
    );

    act(() => {
      result.current[1]((prev) => prev + 1);
    });

    expect(result.current[0]).toBe(1);
  });

  it('should handle objects', () => {
    const { result } = renderHook(() =>
      useLocalStorage('test-key', { count: 0 })
    );

    act(() => {
      result.current[1]({ count: 5 });
    });

    expect(result.current[0]).toEqual({ count: 5 });
  });

  it('should handle invalid JSON in storage', () => {
    localStorage.setItem('test-key', 'invalid json');

    const { result } = renderHook(() =>
      useLocalStorage('test-key', 'fallback')
    );

    expect(result.current[0]).toBe('fallback');
  });
});

describe('useRepos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch repos successfully', async () => {
    const mockRepos = [
      { id: 'owner/repo1', name: 'repo1', fullName: 'owner/repo1' },
      { id: 'owner/repo2', name: 'repo2', fullName: 'owner/repo2' },
    ];
    vi.mocked(api.getRepos).mockResolvedValue(mockRepos as any);

    const { result } = renderHook(() => useRepos());

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(mockRepos);
    expect(result.current.error).toBeNull();
  });

  it('should handle error', async () => {
    vi.mocked(api.getRepos).mockRejectedValue(new Error('Failed to fetch'));

    const { result } = renderHook(() => useRepos());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe('Failed to fetch');
  });

  it('should refetch when called', async () => {
    vi.mocked(api.getRepos).mockResolvedValue([]);

    const { result } = renderHook(() => useRepos());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    vi.mocked(api.getRepos).mockResolvedValue([{ id: 'owner/new', name: 'new', fullName: 'owner/new' }] as any);

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.data).toHaveLength(1);
    });
  });
});

describe('useRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch single repo', async () => {
    const mockRepo = { id: 'owner/repo', name: 'repo', fullName: 'owner/repo' };
    vi.mocked(api.getRepo).mockResolvedValue(mockRepo as any);

    const { result } = renderHook(() => useRepo('owner', 'repo'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(mockRepo);
    expect(api.getRepo).toHaveBeenCalledWith('owner', 'repo');
  });

  it('should return null when owner is null', async () => {
    const { result } = renderHook(() => useRepo(null, 'repo'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBeNull();
    expect(api.getRepo).not.toHaveBeenCalled();
  });

  it('should return null when name is null', async () => {
    const { result } = renderHook(() => useRepo('owner', null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBeNull();
    expect(api.getRepo).not.toHaveBeenCalled();
  });
});

describe('useBranchNaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch branch naming rule', async () => {
    const mockRule = {
      id: 1,
      repoId: 'owner/repo',
      pattern: 'vt/{planId}/{taskSlug}',
      description: 'test',
      examples: ['vt/1/feature'],
    };
    vi.mocked(api.getBranchNaming).mockResolvedValue(mockRule);
    vi.mocked(wsClient.on).mockReturnValue(vi.fn());

    const { result } = renderHook(() => useBranchNaming('owner/repo'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(mockRule);
  });

  it('should return null when repoId is null', async () => {
    const { result } = renderHook(() => useBranchNaming(null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBeNull();
    expect(api.getBranchNaming).not.toHaveBeenCalled();
  });

  it('should handle errors', async () => {
    vi.mocked(api.getBranchNaming).mockRejectedValue(new Error('Not found'));
    vi.mocked(wsClient.on).mockReturnValue(vi.fn());

    const { result } = renderHook(() => useBranchNaming('owner/repo'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Not found');
  });

  it('should subscribe to WebSocket updates', async () => {
    vi.mocked(api.getBranchNaming).mockResolvedValue(null as any);
    vi.mocked(wsClient.on).mockReturnValue(vi.fn());

    renderHook(() => useBranchNaming('owner/repo'));

    await waitFor(() => {
      expect(wsClient.on).toHaveBeenCalledWith('projectRules.updated', expect.any(Function));
    });
  });
});

describe('usePlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch plan', async () => {
    const mockPlan = { id: 1, repoId: 'owner/repo', title: 'Test', status: 'draft' };
    vi.mocked(api.getCurrentPlan).mockResolvedValue(mockPlan as any);
    vi.mocked(wsClient.on).mockReturnValue(vi.fn());

    const { result } = renderHook(() => usePlan('owner/repo'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(mockPlan);
  });

  it('should return null when repoId is null', async () => {
    const { result } = renderHook(() => usePlan(null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBeNull();
  });

  it('should subscribe to WebSocket updates', async () => {
    vi.mocked(api.getCurrentPlan).mockResolvedValue(null);
    vi.mocked(wsClient.on).mockReturnValue(vi.fn());

    renderHook(() => usePlan('owner/repo'));

    await waitFor(() => {
      expect(wsClient.on).toHaveBeenCalledWith('plan.updated', expect.any(Function));
    });
  });

  it('should handle setData', async () => {
    vi.mocked(api.getCurrentPlan).mockResolvedValue(null);
    vi.mocked(wsClient.on).mockReturnValue(vi.fn());

    const { result } = renderHook(() => usePlan('owner/repo'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setData({ id: 2, repoId: 'owner/repo', title: 'New', status: 'committed' } as any);
    });

    expect(result.current.data?.title).toBe('New');
  });
});

describe('useScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not auto-fetch on mount', async () => {
    vi.mocked(wsClient.on).mockReturnValue(vi.fn());

    const { result } = renderHook(() => useScan('/path/to/repo'));

    // Initial state should not be loading
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(api.scan).not.toHaveBeenCalled();
  });

  it('should scan when triggered', async () => {
    const mockSnapshot = {
      repoId: 'owner/repo',
      defaultBranch: 'main',
      branches: ['main'],
      nodes: [],
      edges: [],
      warnings: [],
      worktrees: [],
      rules: { branchNaming: null },
      restart: null,
    };
    vi.mocked(api.scan).mockResolvedValue(mockSnapshot);
    vi.mocked(wsClient.on).mockReturnValue(vi.fn());

    const { result } = renderHook(() => useScan('/path/to/repo'));

    act(() => {
      result.current.scan();
    });

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(mockSnapshot);
  });

  it('should connect to WebSocket after scan', async () => {
    const mockSnapshot = {
      repoId: 'owner/repo',
      defaultBranch: 'main',
      branches: ['main'],
      nodes: [],
      edges: [],
      warnings: [],
      worktrees: [],
      rules: { branchNaming: null },
      restart: null,
    };
    vi.mocked(api.scan).mockResolvedValue(mockSnapshot);
    vi.mocked(wsClient.on).mockReturnValue(vi.fn());

    const { result } = renderHook(() => useScan('/path/to/repo'));

    act(() => {
      result.current.scan();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await waitFor(() => {
      expect(wsClient.connect).toHaveBeenCalledWith('owner/repo');
    });
  });

  it('should not connect when localPath is null', async () => {
    vi.mocked(wsClient.on).mockReturnValue(vi.fn());

    renderHook(() => useScan(null));

    expect(wsClient.connect).not.toHaveBeenCalled();
  });

  it('should handle scan error', async () => {
    vi.mocked(api.scan).mockRejectedValue(new Error('Scan failed'));
    vi.mocked(wsClient.on).mockReturnValue(vi.fn());

    const { result } = renderHook(() => useScan('/path/to/repo'));

    act(() => {
      result.current.scan();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Scan failed');
  });
});
