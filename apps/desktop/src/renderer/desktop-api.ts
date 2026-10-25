import type { MessageKey } from "@inboxzero/mail-core/identities";
import type { MailIpcSnapshotEvent } from "@inboxzero/mail-core/protocol/mail-ipc-client";
import type {
  LocalAccountInput,
  LocalSettingsSummary,
} from "../local/settings";
import type { localAnalysisSchema } from "../local/ai";
import type { z } from "zod";

export type InboxZeroDesktopApi = {
  readAttachment: (
    input: MessageKey & { attachmentId: string },
  ) => Promise<Uint8Array<ArrayBuffer>>;
  mailEngine: (payload: unknown) => Promise<unknown>;
  mailEngineSubscribe: (input: unknown) => Promise<unknown>;
  mailEngineUnsubscribe: (subscriptionId: string) => Promise<unknown>;
  onMailEngineSnapshot: (
    listener: (event: MailIpcSnapshotEvent) => void,
  ) => () => void;
  wipeMailbox: () => Promise<unknown>;
  requiresJyiLogin?: boolean;
  openWindow?: (path: string) => Promise<unknown>;
  signalReady?: () => void;
  onOpenSettings?: (listener: () => void) => () => void;
  localAssistant: {
    settings(): Promise<LocalSettingsSummary>;
    saveAccount(input: LocalAccountInput): Promise<LocalSettingsSummary>;
    removeAccount(id: string): Promise<LocalSettingsSummary>;
    connectAi(): Promise<LocalSettingsSummary>;
    refreshAi(): Promise<LocalSettingsSummary>;
    disconnectAi(): Promise<LocalSettingsSummary>;
    models(): Promise<string[]>;
    analyze(input: z.infer<typeof localAnalysisSchema>): Promise<string>;
  };
};
