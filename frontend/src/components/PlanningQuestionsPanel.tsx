import { useState, useEffect, useCallback } from "react";
import { api, type PlanningQuestion } from "../lib/api";
import { wsClient } from "../lib/ws";
import "./PlanningQuestionsPanel.css";

interface PlanningQuestionsPanelProps {
  planningSessionId: string;
  disabled?: boolean;
}

export function PlanningQuestionsPanel({
  planningSessionId,
  disabled = false,
}: PlanningQuestionsPanelProps) {
  const [questions, setQuestions] = useState<PlanningQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [answeringId, setAnsweringId] = useState<number | null>(null);
  const [answerText, setAnswerText] = useState("");

  // Load questions
  useEffect(() => {
    if (!planningSessionId) return;
    setLoading(true);
    api
      .getQuestions(planningSessionId)
      .then(setQuestions)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [planningSessionId]);

  // WebSocket updates
  useEffect(() => {
    const unsubCreated = wsClient.on("question.created", (msg) => {
      const q = msg.data as PlanningQuestion;
      if (q.planningSessionId === planningSessionId) {
        setQuestions((prev) => [...prev, q].sort((a, b) => a.orderIndex - b.orderIndex));
      }
    });

    const unsubUpdated = wsClient.on("question.updated", (msg) => {
      const q = msg.data as PlanningQuestion;
      if (q.planningSessionId === planningSessionId) {
        setQuestions((prev) =>
          prev.map((item) => (item.id === q.id ? q : item))
        );
      }
    });

    const unsubAnswered = wsClient.on("question.answered", (msg) => {
      const q = msg.data as PlanningQuestion;
      if (q.planningSessionId === planningSessionId) {
        setQuestions((prev) =>
          prev.map((item) => (item.id === q.id ? q : item))
        );
      }
    });

    const unsubDeleted = wsClient.on("question.deleted", (msg) => {
      const data = msg.data as { id: number; planningSessionId: string };
      if (data.planningSessionId === planningSessionId) {
        setQuestions((prev) => prev.filter((q) => q.id !== data.id));
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
      unsubAnswered();
      unsubDeleted();
    };
  }, [planningSessionId]);

  const handleStartAnswer = useCallback((q: PlanningQuestion) => {
    if (disabled) return;
    setAnsweringId(q.id);
    setAnswerText(q.answer || "");
  }, [disabled]);

  const handleSubmitAnswer = useCallback(async () => {
    if (answeringId === null || !answerText.trim() || disabled) return;
    try {
      await api.answerQuestion(answeringId, answerText.trim());
      setAnsweringId(null);
      setAnswerText("");
    } catch (err) {
      console.error("Failed to answer question:", err);
    }
  }, [answeringId, answerText, disabled]);

  const handleSkip = useCallback(async (id: number) => {
    if (disabled) return;
    try {
      await api.updateQuestion(id, { status: "skipped" });
    } catch (err) {
      console.error("Failed to skip question:", err);
    }
  }, [disabled]);

  const handleDelete = useCallback(async (id: number) => {
    if (disabled) return;
    try {
      await api.deleteQuestion(id);
    } catch (err) {
      console.error("Failed to delete question:", err);
    }
  }, [disabled]);

  const pendingQuestions = questions.filter((q) => q.status === "pending");
  const answeredQuestions = questions.filter((q) => q.status === "answered");
  const skippedQuestions = questions.filter((q) => q.status === "skipped");

  if (loading) {
    return (
      <div className="planning-questions planning-questions--loading">
        <div className="planning-questions__spinner" />
      </div>
    );
  }

  return (
    <div className="planning-questions">
      <div className="planning-questions__header">
        <h4>Questions</h4>
        {questions.length > 0 && (
          <span className="planning-questions__count">
            {pendingQuestions.length} pending
          </span>
        )}
      </div>

      {/* Pending Questions */}
      {pendingQuestions.length > 0 && (
        <div className="planning-questions__section">
          {pendingQuestions.map((q) => (
            <div key={q.id} className="planning-questions__item planning-questions__item--pending">
              {q.branchName && (
                <span className="planning-questions__branch">{q.branchName}</span>
              )}
              {q.assumption && (
                <span className="planning-questions__assumption">
                  Assuming: {q.assumption}
                </span>
              )}
              <p className="planning-questions__text">{q.question}</p>

              {answeringId === q.id ? (
                <div className="planning-questions__answer-form">
                  <textarea
                    className="planning-questions__answer-input"
                    value={answerText}
                    onChange={(e) => setAnswerText(e.target.value)}
                    placeholder="Your answer..."
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        handleSubmitAnswer();
                      }
                      if (e.key === "Escape") {
                        setAnsweringId(null);
                        setAnswerText("");
                      }
                    }}
                  />
                  <div className="planning-questions__answer-actions">
                    <button
                      className="planning-questions__btn planning-questions__btn--primary"
                      onClick={handleSubmitAnswer}
                      disabled={!answerText.trim()}
                    >
                      Submit (⌘↵)
                    </button>
                    <button
                      className="planning-questions__btn"
                      onClick={() => {
                        setAnsweringId(null);
                        setAnswerText("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="planning-questions__actions">
                  <button
                    className="planning-questions__btn planning-questions__btn--primary"
                    onClick={() => handleStartAnswer(q)}
                    disabled={disabled}
                  >
                    Answer
                  </button>
                  <button
                    className="planning-questions__btn"
                    onClick={() => handleSkip(q.id)}
                    disabled={disabled}
                  >
                    Skip
                  </button>
                  <button
                    className="planning-questions__btn planning-questions__btn--danger"
                    onClick={() => handleDelete(q.id)}
                    disabled={disabled}
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Answered Questions */}
      {answeredQuestions.length > 0 && (
        <div className="planning-questions__section planning-questions__section--answered">
          <div className="planning-questions__section-header">Answered</div>
          {answeredQuestions.map((q) => (
            <div key={q.id} className="planning-questions__item planning-questions__item--answered">
              {q.branchName && (
                <span className="planning-questions__branch">{q.branchName}</span>
              )}
              <p className="planning-questions__text">{q.question}</p>
              <p className="planning-questions__answer">{q.answer}</p>
            </div>
          ))}
        </div>
      )}

      {/* Skipped Questions */}
      {skippedQuestions.length > 0 && (
        <div className="planning-questions__section planning-questions__section--skipped">
          <div className="planning-questions__section-header">Skipped</div>
          {skippedQuestions.map((q) => (
            <div key={q.id} className="planning-questions__item planning-questions__item--skipped">
              {q.branchName && (
                <span className="planning-questions__branch">{q.branchName}</span>
              )}
              <p className="planning-questions__text">{q.question}</p>
            </div>
          ))}
        </div>
      )}

      {questions.length === 0 && (
        <div className="planning-questions__empty">
          No questions yet. Questions will appear here as AI processes branches.
        </div>
      )}
    </div>
  );
}

export default PlanningQuestionsPanel;
