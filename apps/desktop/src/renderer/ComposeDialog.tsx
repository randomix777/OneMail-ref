import { useState, type FormEvent } from "react";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { OperationKey } from "@inboxzero/mail-core/identities";
import { useOperation } from "@inboxzero/mail-react/use-operation";
import type { LocalSettingsSummary } from "../local/settings";
import { Dialog } from "./Dialog";

export function ComposeDialog({
  accounts,
  client,
  onClose,
}: {
  accounts: LocalSettingsSummary["accounts"];
  client: MailClient;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draftId] = useState(() => crypto.randomUUID());
  const [revision, setRevision] = useState<number | null>(null);
  const [draftAccountId, setDraftAccountId] = useState(accounts[0]?.id ?? "");
  const [operation, setOperation] = useState<OperationKey | null>(null);
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = new FormData(event.currentTarget);
      const to = String(data.get("to") ?? "")
        .split(/[;,]/u)
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (!to.length) throw new Error("Enter a recipient");
      const escaped = document.createElement("div");
      escaped.textContent = String(data.get("body") ?? "");
      const key = { accountId: draftAccountId, draftId };
      const saved = await client.saveDraft({
        key,
        expectedRevision: revision,
        content: {
          to,
          cc: [],
          bcc: [],
          subject: String(data.get("subject") ?? ""),
          editableHtml: escaped.innerHTML.replaceAll("\n", "<br>"),
          quotedHtml: "",
        },
      });
      if (saved.status !== "saved")
        throw new Error(
          "The draft could not be saved. Your message has not been sent.",
        );
      setRevision(saved.draftRevision);
      const result = await client.submitSend({
        commandId: crypto.randomUUID(),
        draft: key,
        draftRevision: saved.draftRevision,
        replyTo: null,
      });
      if (result.status === "rejected")
        throw new Error(`The message could not be queued (${result.code})`);
      setOperation(result.operation);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The message could not be queued",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="New message" onClose={onClose}>
      {operation ? (
        <SendProgress operation={operation} />
      ) : (
        <form
          onSubmit={(event) => {
            send(event);
          }}
        >
          <label>
            From
            <select
              value={draftAccountId}
              disabled={revision !== null || busy}
              onChange={(event) => setDraftAccountId(event.target.value)}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            To
            <input name="to" required placeholder="recipient@example.com" />
          </label>
          <label>
            Subject
            <input name="subject" maxLength={16_384} />
          </label>
          <label>
            Message
            <textarea name="body" rows={12} required />
          </label>
          <p>
            Send runs while OneMail is open. A queued message can resume when
            you next open the app.
          </p>
          {error ? (
            <p role="alert" className="local-error">
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={busy || !draftAccountId}>
            {busy ? "Queueing…" : "Send"}
          </button>
        </form>
      )}
    </Dialog>
  );
}

function SendProgress({ operation }: { operation: OperationKey }) {
  const snapshot = useOperation(operation);
  const status = snapshot.data?.status;
  let message = "Queued locally. Sending continues while OneMail is open.";
  if (status === "succeeded")
    message = "Your mail server accepted the message.";
  else if (status === "executing") message = "Sending to your mail server…";
  else if (status === "failed")
    message = "Sending failed. Check your mailbox settings.";
  else if (status === "blocked_auth")
    message = "Reconnect this mailbox in Settings to send.";
  else if (status === "cancelled") message = "Sending was cancelled.";
  else if (
    status === "uncertain" ||
    status === "needs_attention" ||
    status === "verifying"
  )
    message =
      "Delivery is unconfirmed or some recipients may have been rejected. OneMail will not automatically resend. Check your server's Sent folder and delivery notices before sending another copy.";
  return <p role="status">{message}</p>;
}
