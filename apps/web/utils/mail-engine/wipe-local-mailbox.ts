import { clearRecentSearchHistory } from "@/store/mail-search-history";
import { clearStoredSenderQueues } from "@/store/sender-queue";
import { getDesktopApp } from "@/utils/desktop-app";
import { wipeOpfsMailEngine } from "@/utils/mail-engine/wasm-sqlite";

export async function wipeLocalMailbox() {
  clearStoredSenderQueues();
  clearRecentSearchHistory();
  const wipe = getDesktopApp()?.wipeMailbox;
  if (typeof wipe === "function") {
    await wipe();
    return;
  }
  await wipeOpfsMailEngine();
}
