// The lifecycle run's history: one Human, Mira Chen, over a connect day and
// two working days. Every fact a check or question needs is stated here once,
// so a pass can be traced to its source. Times are Asia/Shanghai.

export const HUMAN = "Mira Chen";
export const DAY0 = "2026-10-31"; // Saturday: Another Me connected
export const DAY1 = "2026-11-01"; // Sunday
export const DAY2 = "2026-11-02"; // Monday: the night before runs Weekly
export const WEEK_START = "2026-10-26";
export const WEEK_END = "2026-11-01";
export const ASKED_AT = "2026-11-03T09:00:00+08:00";

export const PROFILE = {
  revisionId: "profile_rev_1",
  markdown: `# Mira Chen

- Product lead at Lumen Labs, a logistics analytics startup in Shanghai.
- Leads Project Atlas, a delivery analytics migration for the client Northwind Logistics.
- Eight years in data products; previously an analyst at Kestrel Freight.
- Works in English and Mandarin; keeps decisions in shared documents.
`,
};

export interface FixtureDocument {
  documentId: string;
  versionId: string;
  filename: string;
  origin: "my_pages" | "mail";
  markdown: string;
}

const ATLAS_BRIEF = "doc_atlas_brief";

/** The files connected on Day 0; they initialize the Wiki. */
export const CONNECTED: FixtureDocument[] = [
  {
    documentId: ATLAS_BRIEF,
    versionId: "ver_atlas_brief_1",
    filename: "Atlas project brief.md",
    origin: "my_pages",
    markdown: `# Project Atlas brief

Project Atlas moves Northwind Logistics' delivery analytics from legacy Oracle reports to a Lumen Labs warehouse with live dashboards.

- Client: Northwind Logistics, Rotterdam. Client sponsor: Tom Becker, Head of Procurement.
- Lumen lead: Mira Chen. Engineering lead: Daniel Okafor.
- Budget: USD 180,000, fixed price.
- Target launch: December 15, 2026.
- Scope: shipment ingestion, the on-time delivery dashboard and a weekly KPI export.
- Open risk: the legacy Oracle exports have no stable shipment IDs.
`,
  },
  {
    documentId: "doc_hiring_plan",
    versionId: "ver_hiring_plan_1",
    filename: "Q4 hiring plan.md",
    origin: "my_pages",
    markdown: `# Q4 hiring plan

Lumen Labs is hiring two senior data engineers for Project Atlas.

- Recruiter: Hannah Lee from TalentBridge.
- Interview loop: a SQL exercise, a pipeline design review with Daniel Okafor, and a final call with Mira Chen.
- Planned start: January 2027.
`,
  },
  {
    documentId: "doc_mail_sow",
    versionId: "ver_mail_sow_1",
    filename: "Re: Atlas statement of work.eml",
    origin: "mail",
    markdown: `# Re: Atlas statement of work

From: Tom Becker <tom.becker@northwind-logistics.example>
To: Mira Chen <mira@lumenlabs.example>
Date: October 30, 2026

Mira,

Northwind cannot approve a single upfront payment. Please revise the statement of work to three milestone payments: 30% at kickoff, 40% at dashboard delivery and 30% at launch. Our finance committee meets on Friday, November 6.

Best,
Tom
`,
  },
];

/** Day 2's edit of the Atlas brief: a new version of the same Document. */
export const ATLAS_BRIEF_V2: FixtureDocument = {
  ...CONNECTED[0]!,
  versionId: "ver_atlas_brief_2",
  markdown: `# Project Atlas brief

Project Atlas moves Northwind Logistics' delivery analytics from legacy Oracle reports to a Lumen Labs warehouse with live dashboards.

- Client: Northwind Logistics, Rotterdam. Client sponsor: Tom Becker, Head of Procurement.
- Lumen lead: Mira Chen. Engineering lead: Daniel Okafor. Northwind data lead: Priya Raman.
- Budget: USD 210,000, fixed price, after adding the carrier scorecard module.
- Target launch: December 22, 2026 (moved from December 15 on November 1).
- Scope: shipment ingestion, the on-time delivery dashboard, the carrier scorecard and a weekly KPI export.
- Open risk: the legacy Oracle exports have no stable shipment IDs; Daniel's ID-mapping plan addresses it.
`,
};

export interface FixtureMessage {
  at: string;
  /** `human` is Mira, `agent` her Another Me, anything else a colleague's name. */
  author: string;
  text: string;
}

export interface FixtureRoom {
  roomId: string;
  name: string;
  /** Room-day messages by date. */
  days: Record<string, FixtureMessage[]>;
}

export const ATLAS_ROOM = "room_atlas_core";
export const PRIVATE_ROOM = "room_mira_another_me";

export const ROOMS: FixtureRoom[] = [
  {
    roomId: ATLAS_ROOM,
    name: "Atlas core team",
    days: {
      [DAY1]: [
        {
          at: "10:02",
          author: "Daniel Okafor",
          text: "Bad news: the Oracle export for shipment events has no stable IDs, so the migration needs an extra week of mapping work.",
        },
        {
          at: "10:04",
          author: "human",
          text: "OK. Then let's move the Atlas launch from December 15 to December 22. I'll tell Tom at today's kickoff.",
        },
        {
          at: "10:05",
          author: "Daniel Okafor",
          text: "Works for me. I'll write the ID-mapping plan by Tuesday.",
        },
        {
          at: "10:07",
          author: "human",
          text: "I'll send the revised SOW with the three milestone payments to Tom at Northwind by Wednesday.",
        },
      ],
      [DAY2]: [
        {
          at: "09:30",
          author: "human",
          text: "Tom approved the three milestone payments this morning, and the revised SOW is signed. That item is done.",
        },
        {
          at: "09:32",
          author: "Daniel Okafor",
          text: "Great. The ID-mapping plan is in the Atlas folder.",
        },
      ],
    },
  },
  {
    roomId: PRIVATE_ROOM,
    name: "Mira & Another Me",
    days: {
      [DAY1]: [
        {
          at: "21:10",
          author: "human",
          text: "From now on, when you give me status updates, use bullet points, at most five bullets.",
        },
        {
          at: "21:10",
          author: "agent",
          text: "Understood. Status updates will be bullet points, five at most.",
        },
      ],
      [DAY2]: [
        {
          at: "18:05",
          author: "human",
          text: "Change of mind on status updates: no bullet points anymore. Write them as two short paragraphs.",
        },
        {
          at: "18:05",
          author: "agent",
          text: "Got it: two short paragraphs, no bullet points.",
        },
      ],
    },
  },
];

/** Day 1's finished meeting recording, in its own Room. */
export const MEETING = {
  captureId: "capture_atlas_kickoff",
  roomId: "room_northwind_kickoff",
  roomName: "Atlas kickoff with Northwind",
  date: DAY1,
  startedAt: "15:00",
  endedAt: "15:40",
  readyAt: "15:45",
  transcriptDocumentId: "doc_kickoff_transcript",
  transcriptVersionId: "ver_kickoff_transcript_1",
  transcript: `Mira Chen: Thanks for joining the Atlas kickoff. A quick update first: we are moving the launch to December 22 because of the shipment ID mapping.
Tom Becker: Understood. Our finance committee still needs the revised statement of work before Friday.
Priya Raman: I lead data at Northwind. I will own the data migration on our side, including the Oracle exports.
Mira Chen: Great. Daniel Okafor will be your counterpart at Lumen.
Tom Becker: We also want the dashboard to show the on-time delivery rate by carrier.
Mira Chen: Let's hold a weekly Atlas sync every Thursday at 10:00 Rotterdam time.
Priya Raman: Thursday at ten works. I will send the sample export files by November 4.
`,
};

/** The Human's Pocket Note pages. */
export const POCKET_NOTES: Record<string, string> = {
  [DAY1]:
    "Daniel's daughter Ada turns seven on November 7, get a gift card. Book the Rotterdam trip for the November 18 workshop.",
};

export interface FixtureQuestion {
  id: string;
  /** LongMemEval question type, for the judge prompt. */
  type: string;
  question: string;
  answer: string;
  unanswerable?: boolean;
  /** Where the answer comes from, for the report. */
  source: string;
}

/** Asked at ASKED_AT, after the second night. */
export const QUESTIONS: FixtureQuestion[] = [
  {
    id: "profile-employer",
    type: "single-session-user",
    question: "Which company do I work for, and what is my role there?",
    answer: "Lumen Labs; Mira is its product lead.",
    source: "Profile",
  },
  {
    id: "doc-recruiter",
    type: "single-session-user",
    question: "Who is the recruiter for the Atlas data engineer roles?",
    answer: "Hannah Lee from TalentBridge.",
    source: "Connected My pages file",
  },
  {
    id: "mail-payments",
    type: "single-session-user",
    question:
      "How did Northwind want the Atlas payments split in the statement of work?",
    answer:
      "Three milestone payments: 30% at kickoff, 40% at dashboard delivery and 30% at launch.",
    source: "Connected mail",
  },
  {
    id: "doc-budget-update",
    type: "knowledge-update",
    question: "What is the current budget for Project Atlas?",
    answer: "USD 210,000 (raised from USD 180,000).",
    source: "Day 2 edit of the Atlas brief",
  },
  {
    id: "chat-launch-update",
    type: "knowledge-update",
    question: "When is Project Atlas supposed to launch now?",
    answer: "December 22, 2026 (moved from December 15).",
    source: "Day 1 chat and meeting",
  },
  {
    id: "meeting-owner",
    type: "single-session-user",
    question: "Who owns the data migration on Northwind's side?",
    answer: "Priya Raman, Northwind's data lead.",
    source: "Day 1 meeting",
  },
  {
    id: "meeting-sync",
    type: "single-session-user",
    question: "When is the weekly Atlas sync with Northwind?",
    answer: "Every Thursday at 10:00 Rotterdam time.",
    source: "Day 1 meeting",
  },
  {
    id: "note-birthday",
    type: "single-session-user",
    question: "Whose birthday did I note down, and on what date?",
    answer: "Daniel's daughter Ada, on November 7.",
    source: "Day 1 Pocket Note",
  },
  {
    id: "chat-sow-signed",
    type: "temporal-reasoning",
    question: "Was the revised Atlas SOW signed, and on which day?",
    answer: "Yes, it was signed on November 2, 2026.",
    source: "Day 2 chat",
  },
  {
    id: "memory-preference",
    type: "knowledge-update",
    question: "How do I want my status updates written?",
    answer:
      "As two short paragraphs without bullet points; this replaced the earlier request for bullet points.",
    source: "memory.md after the Day 2 correction",
  },
  {
    id: "unanswerable-phone",
    type: "single-session-user",
    question: "What is Tom Becker's phone number?",
    answer:
      "The information is not available; Tom Becker's phone number was never mentioned.",
    unanswerable: true,
    source: "Not in any source",
  },
];
