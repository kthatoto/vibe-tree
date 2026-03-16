import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  sessionId: string;
  onClose?: () => void;
  taskContext?: {
    title: string;
    description?: string;
  };
  autoRunClaude?: boolean;
}

export function Terminal({ sessionId, onClose, taskContext, autoRunClaude }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [claudeRunning, setClaudeRunning] = useState(false);
  const autoRunTriggeredRef = useRef(false);

  const sendCommand = useCallback((command: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data: command + "\r" }));
    }
  }, []);

  const handleRunClaude = useCallback(() => {
    if (!connected) return;
    setClaudeRunning(true);
    // Build the Claude command with task context if available
    let command = "claude";
    if (taskContext) {
      const prompt = taskContext.description
        ? `Task: ${taskContext.title}\\n\\n${taskContext.description}`
        : `Task: ${taskContext.title}`;
      command = `claude -p "${prompt.replace(/"/g, '\\"')}"`;
    }
    sendCommand(command);
  }, [connected, taskContext, sendCommand]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//localhost:9000/ws/term?sessionId=${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setStatus("connected");
      xtermRef.current?.writeln("\x1b[32mConnected to terminal\x1b[0m");
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "data") {
          xtermRef.current?.write(msg.data);
        } else if (msg.type === "exit") {
          xtermRef.current?.writeln(`\r\n\x1b[33mProcess exited with code ${msg.code}\x1b[0m`);
          setStatus("disconnected");
        }
      } catch {
        // Invalid message
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setStatus("disconnected");
    };

    ws.onerror = () => {
      xtermRef.current?.writeln("\x1b[31mConnection error\x1b[0m");
    };
  }, [sessionId]);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#1a1b26",
        foreground: "#a9b1d6",
        cursor: "#c0caf5",
        cursorAccent: "#1a1b26",
        selectionBackground: "#33467c",
        black: "#32344a",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#444b6a",
        brightRed: "#ff7a93",
        brightGreen: "#b9f27c",
        brightYellow: "#ff9e64",
        brightBlue: "#7da6ff",
        brightMagenta: "#c0a8e4",
        brightCyan: "#a6d7ff",
        brightWhite: "#c0caf5",
      },
      convertEol: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle input
    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Handle resize
    const handleResize = () => {
      fitAddon.fit();
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
        );
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(terminalRef.current);

    // Connect
    connect();

    return () => {
      resizeObserver.disconnect();
      wsRef.current?.close();
      term.dispose();
    };
  }, [connect]);

  // Send initial resize after connection
  useEffect(() => {
    if (connected && xtermRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "resize",
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows,
        })
      );
    }
  }, [connected]);

  // Auto-run Claude when connected (if autoRunClaude is true)
  useEffect(() => {
    if (autoRunClaude && connected && taskContext && !autoRunTriggeredRef.current) {
      autoRunTriggeredRef.current = true;
      // Small delay to let terminal fully initialize
      const timer = setTimeout(() => {
        handleRunClaude();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [autoRunClaude, connected, taskContext, handleRunClaude]);

  return (
    <div className="flex flex-col h-full bg-[#1a1b26] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#24283b] border-b border-[#32344a]">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#a9b1d6]">Terminal</span>
          <span
            className={`w-2 h-2 rounded-full ${
              status === "connected"
                ? "bg-green-500"
                : status === "connecting"
                ? "bg-yellow-500 animate-pulse"
                : "bg-red-500"
            }`}
          />
        </div>
        <div className="flex items-center gap-1">
          {status === "connected" && (
            <button
              onClick={handleRunClaude}
              disabled={claudeRunning}
              className={`px-2 py-0.5 text-xs rounded flex items-center gap-1 ${
                claudeRunning
                  ? "bg-[#565f89] text-[#a9b1d6] cursor-not-allowed"
                  : "bg-[#bb9af7] text-white hover:bg-[#9d7cd8]"
              }`}
              title={taskContext ? `Run Claude with task: ${taskContext.title}` : "Run Claude Code"}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
              </svg>
              {claudeRunning ? "Claude Running..." : "Run Claude"}
            </button>
          )}
          {status === "disconnected" && (
            <button
              onClick={connect}
              className="px-2 py-0.5 text-xs bg-[#7aa2f7] text-white rounded hover:bg-[#5d7ec9]"
            >
              Reconnect
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="ml-2 px-2 py-0.5 text-xs bg-[#f7768e] text-white rounded hover:bg-[#ff99a3]"
              title="Close terminal"
            >
              ✕ Close
            </button>
          )}
        </div>
      </div>
      <div ref={terminalRef} className="flex-1 p-1" />
    </div>
  );
}
