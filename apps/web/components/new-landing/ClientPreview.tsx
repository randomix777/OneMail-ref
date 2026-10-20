import { cn } from "@/utils";

/**
 * A picture of the client.
 *
 * The homepage has to say "this is a mail client" before anything else, and a
 * claim is easier to believe with the interface in front of it. The mock is
 * built from the client's own vocabulary - accounts, split tabs, labels,
 * message rows - so it shows what the product does rather than a mood board.
 */

type Row = {
  sender: string;
  subject: string;
  preview: string;
  tag?: { label: string; color: string };
  time: string;
  unread?: boolean;
  avatar: string;
  avatarColor: string;
};

const ROWS: Row[] = [
  {
    sender: "Jenny Louve",
    subject: "Availability for follow up meeting",
    preview: "That sounds great. Here are some slots I have next week…",
    tag: { label: "Team", color: "#C2A9E8" },
    time: "10:24",
    unread: true,
    avatar: "J",
    avatarColor: "#E3A98F",
  },
  {
    sender: "OneMail",
    subject: "Your weekly digest is ready",
    preview: "34 emails triaged, 6 need a reply, 12 unsubscribed.",
    tag: { label: "Digest", color: "#7C93F7" },
    time: "09:12",
    unread: true,
    avatar: "O",
    avatarColor: "#4A6CF7",
  },
  {
    sender: "Aquatics Ltd.",
    subject: "Outline for upcoming project proposal",
    preview: "Attaching the revised timeline we discussed on Tuesday…",
    tag: { label: "To Reply", color: "#E9A0A0" },
    time: "08:47",
    unread: true,
    avatar: "A",
    avatarColor: "#9FB4F5",
  },
  {
    sender: "Nebula Dynamics",
    subject: "Urgent server maintenance schedule",
    preview: "We will be taking the cluster down on Saturday night.",
    tag: { label: "Awaiting Reply", color: "#8FD6AE" },
    time: "Yesterday",
    avatar: "N",
    avatarColor: "#C2A9E8",
  },
  {
    sender: "QuanteX Systems",
    subject: "AI Advancements: the newest breakthrough",
    preview: "Five papers worth reading, summarised in two minutes.",
    tag: { label: "Newsletter", color: "#E79BC8" },
    time: "Yesterday",
    avatar: "Q",
    avatarColor: "#F2C08A",
  },
];

const FOLDERS = [
  { label: "Inbox", count: 12 },
  { label: "Starred" },
  { label: "Snoozed" },
  { label: "Sent" },
  { label: "Drafts", count: 2 },
];

const LABELS = [
  { label: "To Reply", color: "#E9A0A0" },
  { label: "Awaiting Reply", color: "#8FD6AE" },
  { label: "Newsletter", color: "#E79BC8" },
  { label: "Recruitment", color: "#F2C08A" },
  { label: "Team", color: "#C2A9E8" },
];

const SPLITS = ["All", "Unread", "Important", "To Reply"];

export function ClientPreview({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[18px] border border-[#E7E7E7] bg-white shadow-[0px_24px_60px_-24px_rgba(15,23,42,0.25)]",
        className,
      )}
    >
      <div className="flex items-center gap-3 border-b border-[#EFEFEF] bg-[#FCFCFC] px-4 py-3">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-[#E5E5E5]" />
          <span className="size-2.5 rounded-full bg-[#E5E5E5]" />
          <span className="size-2.5 rounded-full bg-[#E5E5E5]" />
        </div>
        <div className="mx-auto flex w-full max-w-[320px] items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs text-gray-400 ring-1 ring-[#EDEDED]">
          <SearchIcon />
          <span>Search mail</span>
        </div>
        <div className="size-6 rounded-full bg-[#4A6CF7]" />
      </div>

      <div className="grid grid-cols-[168px_minmax(0,1fr)_minmax(0,1.05fr)] text-left text-xs">
        <aside className="border-r border-[#F0F0F0] bg-[#FCFCFC] p-3">
          <div className="mb-3 flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 ring-1 ring-[#EDEDED]">
            <span className="size-4 rounded-full bg-[#4A6CF7]" />
            <span className="font-medium text-gray-700">All accounts</span>
          </div>

          <ul className="space-y-0.5">
            {FOLDERS.map((folder) => (
              <li
                key={folder.label}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1",
                  folder.label === "Inbox"
                    ? "bg-white font-medium text-gray-900 ring-1 ring-[#EDEDED]"
                    : "text-gray-500",
                )}
              >
                <FolderIcon />
                <span className="flex-1">{folder.label}</span>
                {folder.count ? (
                  <span className="text-[10px] text-gray-400">
                    {folder.count}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>

          <p className="mt-4 mb-1.5 px-2 text-[10px] font-semibold tracking-wide text-gray-400 uppercase">
            Labels
          </p>
          <ul className="space-y-0.5">
            {LABELS.map((label) => (
              <li
                key={label.label}
                className="flex items-center gap-2 px-2 py-1 text-gray-500"
              >
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: label.color }}
                />
                {label.label}
              </li>
            ))}
          </ul>
        </aside>

        <div className="border-r border-[#F0F0F0]">
          <div className="flex items-center gap-1 border-b border-[#F0F0F0] px-3 py-2.5">
            {SPLITS.map((split) => (
              <span
                key={split}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px]",
                  split === "All"
                    ? "bg-[#242424] text-white"
                    : "text-gray-500 ring-1 ring-[#EDEDED]",
                )}
              >
                {split}
              </span>
            ))}
          </div>

          <ul>
            {ROWS.map((row, index) => (
              <li
                key={row.sender}
                className={cn(
                  "flex gap-2.5 border-b border-[#F5F5F5] px-3 py-2.5",
                  index === 0 && "bg-[#F4F8FF]",
                )}
              >
                <span
                  className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                  style={{ backgroundColor: row.avatarColor }}
                >
                  {row.avatar}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "truncate",
                        row.unread
                          ? "font-semibold text-gray-900"
                          : "font-medium text-gray-600",
                      )}
                    >
                      {row.sender}
                    </span>
                    {row.tag ? (
                      <span
                        className="rounded-full px-1.5 py-px text-[10px] font-medium text-white"
                        style={{ backgroundColor: row.tag.color }}
                      >
                        {row.tag.label}
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0 text-[10px] text-gray-400">
                      {row.time}
                    </span>
                  </div>
                  <p className="truncate text-[11px] text-gray-500">
                    {row.subject}
                  </p>
                  <p className="truncate text-[11px] text-gray-400">
                    {row.preview}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="p-4">
          <p className="text-[11px] font-semibold text-gray-500">Jenny Louve</p>
          <p className="mt-0.5 text-sm font-semibold text-gray-900">
            Availability for follow up meeting
          </p>
          <p className="mt-1 text-[11px] text-gray-400">to me · 10:24</p>
          <div className="mt-3 space-y-2 text-[11px] leading-5 text-gray-600">
            <p>Hey Alex,</p>
            <p>That sounds great. Here are some slots I have next week:</p>
            <ul className="ml-4 list-disc space-y-1">
              <li className="text-[#2F63E8]">Monday at 8:00AM</li>
              <li className="text-[#2F63E8]">Tuesday at 2:00PM</li>
              <li className="text-[#2F63E8]">Wednesday at 9:30AM</li>
            </ul>
            <p>Kindest,</p>
            <p>Jenny</p>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <span className="rounded-md bg-[#242424] px-2.5 py-1 text-[11px] font-medium text-white">
              Reply
            </span>
            <span className="rounded-md px-2.5 py-1 text-[11px] text-gray-500 ring-1 ring-[#EDEDED]">
              Snooze
            </span>
            <span className="rounded-md px-2.5 py-1 text-[11px] text-gray-500 ring-1 ring-[#EDEDED]">
              Archive
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M7.8 7.8 10.5 10.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M1.5 3.2A1.2 1.2 0 0 1 2.7 2h2.1l1.1 1.4h3.4a1.2 1.2 0 0 1 1.2 1.2v4.2a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2V3.2Z"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}
