// The subset of the local settings contract this renderer consumes. The Rust
// shell serializes these shapes over `local_settings`.

export type Server = {
  host: string;
  port: number;
  secure: boolean;
};

export type LocalAccount = {
  id: string;
  email: string;
  name: string;
  username: string;
  imap: Server;
  smtp: Server;
};

export type LocalAccountInput = Omit<LocalAccount, "id"> & {
  id?: string;
  password: string;
};

export type AiConnectionSummary = {
  account_email?: string | null;
  spendable_credits?: number | null;
  allowance_syncing?: boolean;
  topup_url?: string | null;
};

export type LocalSettingsSummary = {
  accounts: LocalAccount[];
  ai: AiConnectionSummary | null;
};

export type AnalysisMessage = {
  subject: string;
  from: string;
  text: string;
};

export type AnalysisInput = {
  question: string;
  model: string;
  messages: AnalysisMessage[];
};
