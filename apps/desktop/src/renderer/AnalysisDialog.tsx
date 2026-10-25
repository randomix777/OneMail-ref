import { useEffect, useState } from "react";
import { useConversation } from "@inboxzero/mail-react/use-conversation";
import type { ConversationKey } from "@inboxzero/mail-core/identities";
import type { InboxZeroDesktopApi } from "./desktop-api";
import { Dialog } from "./Dialog";

export function AnalysisDialog({
  conversationKey,
  api,
  onClose,
}: {
  conversationKey: ConversationKey;
  api: InboxZeroDesktopApi;
  onClose: () => void;
}) {
  const conversation = useConversation(conversationKey, {
    after: null,
    pageSize: 20,
  });
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api.localAssistant
      .models()
      .then((value) => {
        if (active) setModels(value);
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "Connect JYI in Settings to use AI",
          );
      });
    return () => {
      active = false;
    };
  }, [api]);
  const model = selectedModel || models[0] || "";
  const messages =
    conversation.data?.messages.slice(0, 20).flatMap((message) =>
      message.content.status === "available"
        ? [
            {
              subject: message.metadata.subject,
              from: message.metadata.from,
              text: (message.content.text ?? message.content.html ?? "").slice(
                0,
                20_000,
              ),
            },
          ]
        : [],
    ) ?? [];
  return (
    <Dialog title="Ask JYI about this conversation" onClose={onClose}>
      <p>
        Only the downloaded messages in this conversation are sent to JYI when
        you click Analyze. Up to 20 messages and the first 20,000 characters of
        each are included. Attachments are not included. Token charges apply.
      </p>
      <label>
        Model
        <select
          value={model}
          onChange={(event) => setSelectedModel(event.target.value)}
        >
          {models.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      <label>
        Your question
        <textarea
          rows={4}
          maxLength={4000}
          value={question}
          placeholder="Summarize this conversation and list what I need to do next."
          onChange={(event) => setQuestion(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || !model || !question.trim() || !messages.length}
        onClick={async () => {
          setBusy(true);
          setError("");
          setAnswer("");
          try {
            setAnswer(
              await api.localAssistant.analyze({ question, model, messages }),
            );
          } catch (failure) {
            setError(
              failure instanceof Error ? failure.message : "Analysis failed",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Analyzing…" : "Analyze with JYI"}
      </button>
      {!messages.length ? (
        <p>
          Open the conversation and wait for the message bodies to download
          before analyzing it.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="local-error">
          {error}
        </p>
      ) : null}
      {answer ? <pre className="local-analysis-answer">{answer}</pre> : null}
    </Dialog>
  );
}
