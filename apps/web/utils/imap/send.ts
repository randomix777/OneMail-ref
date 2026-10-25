import MailComposer from "nodemailer/lib/mail-composer";
import { createTransport } from "nodemailer";
import { getCloudflareBindings } from "@/utils/cloudflare/context";

/**
 * Whether sending also files a copy in the provider's Sent folder.
 *
 * Zoho documents that it does ("those emails are automatically saved in your Sent
 * folder"), and a user can turn that off in the provider's own settings, which we
 * cannot see. The other providers document nothing either way. Because guessing
 * wrong either loses sent mail or duplicates it, the default is to treat the copy
 * as ours to make, and to record the one exception we know about.
 */
export type SentCopyBehaviour = "provider-files" | "client-files";

const SENT_COPY_BY_FAMILY: Partial<Record<string, SentCopyBehaviour>> = {
  zoho: "provider-files",
};

/**
 * The behaviour to assume for a family on the IMAP transport.
 *
 * A per-family default rather than a per-account fact: the account may have
 * changed the provider's own setting since. It exists so the choice is written
 * down once instead of being implicit in the send path.
 */
export function sentCopyBehaviour(family: string): SentCopyBehaviour {
  return SENT_COPY_BY_FAMILY[family] ?? "client-files";
}

export type OutgoingAttachment = {
  filename: string;
  content: Buffer | string;
  contentType?: string;
};

export type OutgoingMessage = {
  /** Fully-qualified From, which the account must be allowed to send as. */
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: OutgoingAttachment[];
  inReplyTo?: string;
  references?: string[];
};

/**
 * The exact bytes of the message.
 *
 * Composed once and then both sent and (when the provider does not file one) put
 * in Sent, so the copy cannot drift from what was delivered. MailComposer builds
 * the whole MIME tree, which a hand-written header block would not: it picks the
 * multipart structure, encodes non-ASCII subjects and encodes attachments.
 */
export async function composeRawMessage(message: OutgoingMessage) {
  const composer = new MailComposer({
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    html: message.html,
    inReplyTo: message.inReplyTo,
    references: message.references?.length ? message.references : undefined,
    attachments: message.attachments?.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType,
    })),
  });

  return composer.compile().build();
}

export type SendViaSmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  secret: string;
};

/**
 * Sends one message over SMTP and hands back the bytes that were sent.
 *
 * A connection per send, for the same reason IMAP opens one per unit of work:
 * Fastmail documents a per-user ceiling of 500 logins per 10 minutes across all
 * services, so a pool would have to be accounted for, and mail is not sent often
 * enough for a pool to pay for itself.
 */
export async function sendViaSmtp({
  options,
  message,
}: {
  options: SendViaSmtpOptions;
  message: OutgoingMessage;
}) {
  if (getCloudflareBindings() && options.port === 25) {
    throw new Error(
      "Workers cannot connect to SMTP port 25; use submission port 465 or 587",
    );
  }
  const raw = await composeRawMessage(message);

  const transport = createTransport({
    host: options.host,
    port: options.port,
    // `secure: true` is implicit TLS. Providers document different ports for it
    // (Fastmail 465, Yahoo "465 or 587"), so the stored value decides rather than
    // a guess from the port number.
    secure: options.secure,
    auth: { user: options.username, pass: options.secret },
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });

  try {
    const info = await transport.sendMail({
      raw,
      // The envelope cannot be inferred from `raw`, and without it the server has
      // no recipients to deliver to.
      envelope: {
        from: message.from,
        to: [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])],
      },
    });

    return { messageId: info.messageId, raw };
  } finally {
    transport.close();
  }
}
