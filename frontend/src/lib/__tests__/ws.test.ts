import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create mock WebSocket class
let mockWsInstance: MockWebSocket;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: Event) => void) | null = null;

  send = vi.fn();
  close = vi.fn();

  constructor(public url: string) {
    mockWsInstance = this;
  }

  // Helper to simulate connection
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateError() {
    this.onerror?.(new Event('error'));
  }
}

// Store the mock for access in tests
vi.stubGlobal('WebSocket', MockWebSocket);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe('WebSocketClient', () => {
  it('should connect to WebSocket', async () => {
    const { wsClient } = await import('../ws');

    wsClient.connect('owner/repo');

    expect(mockWsInstance).toBeDefined();
    expect(mockWsInstance.url).toContain('/ws');
  });

  it('should subscribe to repoId on connection', async () => {
    const { wsClient } = await import('../ws');

    wsClient.connect('owner/repo');
    mockWsInstance.simulateOpen();

    expect(mockWsInstance.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', repoId: 'owner/repo' })
    );
  });

  it('should register message handlers', async () => {
    const { wsClient } = await import('../ws');
    const handler = vi.fn();

    wsClient.on('test.event', handler);
    wsClient.connect();
    mockWsInstance.simulateOpen();
    mockWsInstance.simulateMessage({ type: 'test.event', data: 'test data' });

    expect(handler).toHaveBeenCalledWith({
      type: 'test.event',
      data: 'test data',
    });
  });

  it('should unregister message handlers', async () => {
    const { wsClient } = await import('../ws');
    const handler = vi.fn();

    const unsubscribe = wsClient.on('test.event', handler);
    unsubscribe();

    wsClient.connect();
    mockWsInstance.simulateOpen();
    mockWsInstance.simulateMessage({ type: 'test.event', data: 'test' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should emit to wildcard handlers', async () => {
    const { wsClient } = await import('../ws');
    const handler = vi.fn();

    wsClient.on('*', handler);
    wsClient.connect();
    mockWsInstance.simulateOpen();
    mockWsInstance.simulateMessage({ type: 'any.event', data: 'test' });

    expect(handler).toHaveBeenCalledWith({
      type: 'any.event',
      data: 'test',
    });
  });

  it('should reuse existing connection', async () => {
    const { wsClient } = await import('../ws');

    wsClient.connect('owner/repo');
    mockWsInstance.simulateOpen();

    const firstInstance = mockWsInstance;
    wsClient.connect('owner/repo');

    // Should be the same instance
    expect(mockWsInstance).toBe(firstInstance);
  });

  it('should resubscribe when changing repo on existing connection', async () => {
    const { wsClient } = await import('../ws');

    wsClient.connect('owner/repo');
    mockWsInstance.simulateOpen();

    mockWsInstance.send.mockClear();
    wsClient.connect('other/repo');

    expect(mockWsInstance.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', repoId: 'other/repo' })
    );
  });

  it('should handle disconnect', async () => {
    const { wsClient } = await import('../ws');

    wsClient.connect();
    mockWsInstance.simulateOpen();

    wsClient.disconnect();

    expect(mockWsInstance.close).toHaveBeenCalled();
  });

  it('should schedule reconnection on close', async () => {
    const { wsClient } = await import('../ws');

    wsClient.connect('owner/repo');
    const firstInstance = mockWsInstance;
    firstInstance.simulateOpen();
    firstInstance.simulateClose();

    // Advance time to trigger reconnect
    vi.advanceTimersByTime(3000);

    // A new WebSocket should be created
    expect(mockWsInstance).not.toBe(firstInstance);
  });

  it('should cancel reconnection on disconnect', async () => {
    const { wsClient } = await import('../ws');

    wsClient.connect('owner/repo');
    const firstInstance = mockWsInstance;
    firstInstance.simulateOpen();
    firstInstance.simulateClose();

    wsClient.disconnect();
    vi.advanceTimersByTime(3000);

    // Should still be the same instance (no reconnect happened)
    expect(mockWsInstance).toBe(firstInstance);
  });

  it('should handle JSON parse errors gracefully', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { wsClient } = await import('../ws');

    wsClient.connect();
    mockWsInstance.simulateOpen();

    // Simulate invalid JSON by directly calling onmessage with invalid data
    mockWsInstance.onmessage?.({ data: 'not valid json' });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to parse WS message:',
      expect.any(Error)
    );

    consoleErrorSpy.mockRestore();
  });

  it('should handle WebSocket errors', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { wsClient } = await import('../ws');

    wsClient.connect();
    mockWsInstance.simulateError();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'WebSocket error:',
      expect.any(Event)
    );

    consoleErrorSpy.mockRestore();
  });

  it('should use correct protocol based on page protocol', async () => {
    const { wsClient } = await import('../ws');
    wsClient.connect();

    expect(mockWsInstance.url).toContain('ws://');
  });
});
