/**
 * The playbooks, one per audience.
 *
 * Every entry names a workflow the product actually has, so a page cannot
 * promise something the app does not do. The page for an audience is built
 * from this list rather than written out again per route.
 */

export type Audience = {
  /** The route segment the page lives at. */
  slug: string;
  /** The nav label. */
  title: string;
  /** The headline on the page. */
  headline: string;
  /** One sentence under the headline. */
  subtitle: string;
  /** The three workflows, most useful first. */
  workflows: { title: string; description: string }[];
  /** What the audience gets on top of the workflows. */
  alsoUseful: string[];
};

export const AUDIENCES: Audience[] = [
  {
    slug: "founders",
    title: "Founders",
    headline: "Email, handled, while you build",
    subtitle:
      "Investors, customers and the occasional recruiter all want a reply. OneMail sorts them, drafts the answer in your voice, and reminds you about the ones that matter.",
    workflows: [
      {
        title: "Every inbound, in its own split",
        description:
          "Splits are saved queries. Keep one for investors, one for customers, one for recruiters, and the counts stay live.",
      },
      {
        title: "A draft in your voice, not a template",
        description:
          "The assistant learns how you write and drafts replies that sound like you wrote them, ready to edit and send.",
      },
      {
        title: "Nothing slips",
        description:
          "Follow-up reminders bring a thread back when you have not answered, so a warm lead never goes quiet.",
      },
    ],
    alsoUseful: [
      "Digests that summarise what you missed",
      "Snooze anything that is not for today",
      "Slack and Telegram reach you when you are away from the desk",
    ],
  },
  {
    slug: "small-business",
    title: "Small Business",
    headline: "The front desk of a small business",
    subtitle:
      "Order questions, supplier quotes and newsletter noise arrive in the same inbox. OneMail keeps the two apart and answers the first one for you.",
    workflows: [
      {
        title: "Newsletters leave on their own",
        description:
          "Unsubscribe from a sender in one click, and let a rule archive everything else that is not a customer.",
      },
      {
        title: "Rules that run without you",
        description:
          "Label by sender, file by topic, and let the assistant draft the reply to anything that needs one.",
      },
      {
        title: "One team, one set of rules",
        description:
          "An organization rule reaches every member, so the whole team files mail the same way.",
      },
    ],
    alsoUseful: [
      "Booking links that put your calendar in the signature",
      "Snippets for the answers you write every day",
      "Per-mailbox plan limits you control from the settings",
    ],
  },
  {
    slug: "creator",
    title: "Content Creators",
    headline: "Sponsors, fans and the rest",
    subtitle:
      "Partnerships, fan mail and newsletter subscriptions all want your attention. OneMail keeps the valuable mail obvious and the rest quiet.",
    workflows: [
      {
        title: "Sponsor mail, separated",
        description:
          "A split for partnership threads and another for fan mail means the business is never buried in newsletters.",
      },
      {
        title: "Reply in your voice",
        description:
          "The assistant drafts from the thread you replied to last time, so a sponsorship answer still sounds like you.",
      },
      {
        title: "Every pitch, followed up",
        description:
          "A follow-up reminder on the thread that went quiet keeps the partnership moving without a spreadsheet.",
      },
    ],
    alsoUseful: [
      "Search that reaches every message you have synced",
      "Category rules that spot the newsletters you never want",
      "An MCP server, so your own tools can read the inbox",
    ],
  },
  {
    slug: "real-estate",
    title: "Real Estate",
    headline: "Every lead, before it goes cold",
    subtitle:
      "Showing requests, buyer questions and portal noise all arrive by mail. OneMail separates them and keeps the lead warm.",
    workflows: [
      {
        title: "Lead mail, sorted by sender",
        description:
          "A rule per portal or client files the mail as it arrives, so the list you read is the list that matters.",
      },
      {
        title: "Nothing sits unanswered",
        description:
          "Snooze what cannot be answered now, and let the follow-up reminder bring the showing request back.",
      },
      {
        title: "Your usual answers, one line away",
        description:
          "Snippets hold the replies you send every week, so a repeat answer takes a single keystroke.",
      },
    ],
    alsoUseful: [
      "A calendar that drafts around your showing times",
      "Meeting briefs for the calls that need notes",
      "Search across every mailbox you have connected",
    ],
  },
  {
    slug: "customer-support",
    title: "Customer Support",
    headline: "The queue, already sorted",
    subtitle:
      "Tickets, questions and the occasional invoice all arrive together. OneMail classifies them, drafts the first answer, and tells you what waited too long.",
    workflows: [
      {
        title: "Tickets sorted before you open them",
        description:
          "Categories and rules file each request by topic, so the list starts as a queue instead of a pile.",
      },
      {
        title: "The first reply, already drafted",
        description:
          "The assistant reads the thread and writes a reply in your tone, which you edit and send.",
      },
      {
        title: "The ones that waited",
        description:
          "Follow-up reminders and the weekly digest name the customers who have not had an answer.",
      },
    ],
    alsoUseful: [
      "Snooze a ticket until you know the answer",
      "Cold-email blocking for the senders that are not customers",
      "A shared thread, when a colleague needs to weigh in",
    ],
  },
  {
    slug: "ecommerce",
    title: "E-commerce",
    headline: "Order noise out of the way",
    subtitle:
      "Shipping updates, invoices and marketing blasts should never reach the same list as a customer who needs an answer. OneMail keeps them apart.",
    workflows: [
      {
        title: "Order updates, filed away",
        description:
          "A rule files every notification from the platforms you sell on, so the list only holds the mail that needs a person.",
      },
      {
        title: "Refunds and returns, findable",
        description:
          "Search reaches every message you have synced, including the order thread from six months ago.",
      },
      {
        title: "The senders you never want again",
        description:
          "Block a sender and the assistant keeps the cold mail out of the inbox from then on.",
      },
    ],
    alsoUseful: [
      "Bulk archive for a whole category of senders",
      "Snippets for the shipping answers you repeat",
      "Webhooks to push a reply into the tools you already use",
    ],
  },
];

export function findAudience(slug: string) {
  return AUDIENCES.find((audience) => audience.slug === slug);
}
