import { useState } from "react";
import type { AskUserQuestionData, AskUserQuestion } from "../lib/ask-user-question";
import { formatAnswers } from "../lib/ask-user-question";

interface AskUserQuestionUIProps {
  data: AskUserQuestionData;
  onSubmit: (answer: string) => void;
  disabled?: boolean;
}

export function AskUserQuestionUI({ data, onSubmit, disabled }: AskUserQuestionUIProps) {
  // Debug: log incoming data
  console.log("[AskUserQuestionUI] Rendering with data:", data);
  console.log("[AskUserQuestionUI] Questions count:", data?.questions?.length);

  // Track selections for each question (Map<questionIndex, Set<selectedLabels>>)
  const [selections, setSelections] = useState<Map<number, Set<string>>>(new Map());
  // Track "Other" text input for each question
  const [otherInputs, setOtherInputs] = useState<Map<number, string>>(new Map());
  // Track which questions have "Other" selected
  const [otherSelected, setOtherSelected] = useState<Map<number, boolean>>(new Map());

  const toggleOption = (questionIndex: number, label: string, multiSelect: boolean) => {
    setSelections((prev) => {
      const newMap = new Map(prev);
      const current = newMap.get(questionIndex) || new Set();

      if (multiSelect) {
        // Multi-select: toggle the option
        const newSet = new Set(current);
        if (newSet.has(label)) {
          newSet.delete(label);
        } else {
          newSet.add(label);
        }
        newMap.set(questionIndex, newSet);
      } else {
        // Single-select: replace selection
        if (current.has(label)) {
          // Deselect if already selected
          newMap.set(questionIndex, new Set());
        } else {
          newMap.set(questionIndex, new Set([label]));
        }
        // Clear "Other" when selecting a regular option
        setOtherSelected((prev) => {
          const newOther = new Map(prev);
          newOther.set(questionIndex, false);
          return newOther;
        });
        setOtherInputs((prev) => {
          const newInputs = new Map(prev);
          newInputs.delete(questionIndex);
          return newInputs;
        });
      }

      return newMap;
    });
  };

  const toggleOther = (questionIndex: number, multiSelect: boolean) => {
    setOtherSelected((prev) => {
      const newMap = new Map(prev);
      const isSelected = prev.get(questionIndex) || false;
      newMap.set(questionIndex, !isSelected);

      // If single-select, clear other selections when selecting "Other"
      if (!multiSelect && !isSelected) {
        setSelections((prevSel) => {
          const newSel = new Map(prevSel);
          newSel.set(questionIndex, new Set());
          return newSel;
        });
      }

      return newMap;
    });
  };

  const handleOtherInput = (questionIndex: number, value: string) => {
    setOtherInputs((prev) => {
      const newMap = new Map(prev);
      newMap.set(questionIndex, value);
      return newMap;
    });
  };

  const handleSubmit = () => {
    if (disabled || !hasAnyAnswer()) return;
    const answer = formatAnswers(data.questions, selections, otherInputs);
    onSubmit(answer);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // ⌘+Enter or Ctrl+Enter to submit
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Check if at least one answer is provided
  const hasAnyAnswer = () => {
    for (let i = 0; i < data.questions.length; i++) {
      const selected = selections.get(i);
      const otherInput = otherInputs.get(i);
      if ((selected && selected.size > 0) || (otherInput && otherInput.trim())) {
        return true;
      }
    }
    return false;
  };

  return (
    <div
      style={{
        background: "#1e293b",
        border: "1px solid #3b82f6",
        borderRadius: 8,
        margin: "8px 4px",
      }}
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div style={{
        padding: "10px 14px",
        background: "#0f172a",
        borderBottom: "1px solid #3b82f6",
        borderRadius: "7px 7px 0 0",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}>
        <span style={{ fontSize: 16 }}>❓</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#93c5fd" }}>
          質問があります
        </span>
      </div>

      {/* Questions */}
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 20 }}>
        {data.questions.map((q, qIndex) => (
          <QuestionSection
            key={qIndex}
            question={q}
            questionIndex={qIndex}
            selections={selections.get(qIndex) || new Set()}
            otherSelected={otherSelected.get(qIndex) || false}
            otherInput={otherInputs.get(qIndex) || ""}
            onToggleOption={(label) => toggleOption(qIndex, label, q.multiSelect)}
            onToggleOther={() => toggleOther(qIndex, q.multiSelect)}
            onOtherInput={(value) => handleOtherInput(qIndex, value)}
            disabled={disabled}
          />
        ))}
      </div>

      {/* Submit button */}
      <div style={{
        padding: "10px 14px",
        borderTop: "1px solid #374151",
        display: "flex",
        justifyContent: "flex-end",
      }}>
        <button
          onClick={handleSubmit}
          disabled={disabled || !hasAnyAnswer()}
          style={{
            padding: "8px 20px",
            background: disabled || !hasAnyAnswer() ? "#4b5563" : "#3b82f6",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: disabled || !hasAnyAnswer() ? "not-allowed" : "pointer",
          }}
        >
          回答を送信 (⌘↵)
        </button>
      </div>
    </div>
  );
}

interface QuestionSectionProps {
  question: AskUserQuestion;
  questionIndex: number;
  selections: Set<string>;
  otherSelected: boolean;
  otherInput: string;
  onToggleOption: (label: string) => void;
  onToggleOther: () => void;
  onOtherInput: (value: string) => void;
  disabled?: boolean;
}

function QuestionSection({
  question,
  selections,
  otherSelected,
  otherInput,
  onToggleOption,
  onToggleOther,
  onOtherInput,
  disabled,
}: QuestionSectionProps) {
  return (
    <div>
      {/* Question header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 10,
      }}>
        <span style={{
          padding: "2px 8px",
          background: "#3b82f6",
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 600,
          color: "#fff",
        }}>
          {question.header}
        </span>
        {question.multiSelect && (
          <span style={{
            padding: "2px 6px",
            background: "#374151",
            borderRadius: 4,
            fontSize: 10,
            color: "#9ca3af",
          }}>
            複数選択可
          </span>
        )}
      </div>

      {/* Question text */}
      <p style={{
        margin: "0 0 12px",
        fontSize: 14,
        color: "#e2e8f0",
        lineHeight: 1.5,
      }}>
        {question.question}
      </p>

      {/* Options */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {question.options.map((opt, optIndex) => {
          const isSelected = selections.has(opt.label);
          return (
            <button
              key={optIndex}
              onClick={() => onToggleOption(opt.label)}
              disabled={disabled}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                padding: "10px 14px",
                background: isSelected ? "#1e3a5f" : "#0f172a",
                border: isSelected ? "2px solid #3b82f6" : "1px solid #374151",
                borderRadius: 6,
                cursor: disabled ? "not-allowed" : "pointer",
                textAlign: "left",
                transition: "all 0.15s",
              }}
            >
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
              }}>
                {/* Checkbox/Radio indicator */}
                <div style={{
                  width: 18,
                  height: 18,
                  borderRadius: question.multiSelect ? 4 : 9,
                  border: isSelected ? "2px solid #3b82f6" : "2px solid #4b5563",
                  background: isSelected ? "#3b82f6" : "transparent",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}>
                  {isSelected && (
                    <span style={{ color: "#fff", fontSize: 12, fontWeight: "bold" }}>✓</span>
                  )}
                </div>
                <span style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: isSelected ? "#93c5fd" : "#e2e8f0",
                }}>
                  {opt.label}
                </span>
              </div>
              {opt.description && (
                <span style={{
                  marginTop: 4,
                  marginLeft: 26,
                  fontSize: 12,
                  color: "#9ca3af",
                  lineHeight: 1.4,
                }}>
                  {opt.description}
                </span>
              )}
            </button>
          );
        })}

        {/* "Other" option */}
        <div style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}>
          <button
            onClick={onToggleOther}
            disabled={disabled}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 14px",
              background: otherSelected ? "#1e3a5f" : "#0f172a",
              border: otherSelected ? "2px solid #3b82f6" : "1px solid #374151",
              borderRadius: 6,
              cursor: disabled ? "not-allowed" : "pointer",
              textAlign: "left",
              transition: "all 0.15s",
            }}
          >
            <div style={{
              width: 18,
              height: 18,
              borderRadius: question.multiSelect ? 4 : 9,
              border: otherSelected ? "2px solid #3b82f6" : "2px solid #4b5563",
              background: otherSelected ? "#3b82f6" : "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}>
              {otherSelected && (
                <span style={{ color: "#fff", fontSize: 12, fontWeight: "bold" }}>✓</span>
              )}
            </div>
            <span style={{
              fontSize: 13,
              fontWeight: 500,
              color: otherSelected ? "#93c5fd" : "#e2e8f0",
            }}>
              その他（自由入力）
            </span>
          </button>

          {/* Text input for "Other" */}
          {otherSelected && (
            <textarea
              value={otherInput}
              onChange={(e) => onOtherInput(e.target.value)}
              placeholder="具体的に入力してください..."
              disabled={disabled}
              style={{
                marginLeft: 26,
                padding: "10px 12px",
                background: "#0f172a",
                border: "1px solid #374151",
                borderRadius: 6,
                color: "#e2e8f0",
                fontSize: 13,
                fontFamily: "inherit",
                resize: "vertical",
                minHeight: 60,
                outline: "none",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
