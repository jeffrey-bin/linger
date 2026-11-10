import type {
  TeamHubActor,
  TeamHubDiscordChannel,
  TeamHubExternalApp,
  TeamHubExternalConnection,
  TeamHubExternalConnectionAgentAccess,
  TeamHubGitHubRepository,
  TeamHubGoogleCalendar,
  TeamHubNotionResource,
  TeamHubSlackConversation,
  TeamHubAgentTemplatePage,
  TeamHubLocalComputerPage,
  TeamHubCurrentIdentity,
  TeamHubDocument,
  TeamHubDocumentVersion,
  TeamHubMessage,
  TeamHubMessageCardHumanActorRef,
  TeamHubMyDocumentTree,
  TeamHubPersonalProfileDocument,
  TeamHubRunStatus,
  TeamHubRoomEvent,
  TeamHubRoomListItem,
  TeamHubRoomMember,
  TeamHubRuntimePresentationEventRecord,
  TeamHubSkillManifest,
  TeamHubTenant,
  TeamHubTenantAgent,
  TeamHubTenantAgentAvailabilitySnapshot,
  TeamHubTeamMdDocument,
  TeamHubWorkItem,
} from "@/features/teamhub/teamhub-types";

export type TestTenantAgent = TeamHubTenantAgent & {
  availability: TeamHubTenantAgentAvailabilitySnapshot["availability"];
  local_runtime_status?: TeamHubTenantAgentAvailabilitySnapshot["local_runtime_status"];
};

export interface TeamHubTestSeed {
  actors: TeamHubActor[];
  agentTemplates: TeamHubAgentTemplatePage["items"];
  directRoomIdByPeerActor: Map<string, string>;
  /** The My pages tree; without it every active Document the Human owns sits at the root. */
  documentTree?: TeamHubMyDocumentTree;
  documents: Map<string, TeamHubDocument>;
  documentVersionContents: Map<string, Blob>;
  documentVersions: Map<string, TeamHubDocumentVersion>;
  eventsByRoom: Map<string, TeamHubRoomEvent[]>;
  externalSources: ReturnType<typeof createExternalSourceSeed>;
  identity: TeamHubCurrentIdentity;
  localComputers: TeamHubLocalComputerPage["items"];
  membersByRoom: Map<string, TeamHubRoomMember[]>;
  runStatusesByRoom: Map<string, TeamHubRunStatus[]>;
  messagesByRoom: Map<string, TeamHubMessage[]>;
  runtimePresentationEventsByRunStatusId: Map<
    string,
    TeamHubRuntimePresentationEventRecord[]
  >;
  rooms: TeamHubRoomListItem[];
  skillManifests: TeamHubSkillManifest[];
  tenant: TeamHubTenant;
  tenantAgents: TestTenantAgent[];
  workItems: TeamHubWorkItem[];
}

const createdAt = "2026-07-23T08:00:00Z";
const productBriefDocumentId = "document-product-v0-brief";
const gamePrdDocumentId = "document-2048-prd";
const gameArchitectureDocumentId = "document-2048-architecture";
const gameNotesDocumentId = "document-2048-notes";

export function createTeamHubTestSeed(): TeamHubTestSeed {
  const tenant: TeamHubTenant = {
    created_at: createdAt,
    id: "tenant-northstar",
    name: "Northstar Studio",
  };
  const actors: TeamHubActor[] = [
    actor("actor-jenny", "human", "Jenny Bin", "@jenny", "account-jenny"),
    actor("actor-maya", "human", "Maya Chen", "@maya", "account-maya"),
    actor("actor-codex", "agent", "Codex", "@codex"),
    actor("actor-lev8", "agent", "Lev8 GTM", "@lev8"),
    actor("actor-delegate", "agent", "Jenny's Delegate", "@jenny_delegate"),
  ];
  const identity: TeamHubCurrentIdentity = {
    account: {
      created_at: createdAt,
      id: "account-jenny",
      email: "jenny@northstar.example",
    },
    actors: [actors[0]!],
  };
  const tenantAgents = [
    tenantAgent(
      actors[2]!,
      actors[0]!,
      "Coding Agent for repository analysis and implementation.",
    ),
    tenantAgent(
      actors[3]!,
      actors[1]!,
      "Remote GTM Agent for People Search and GTM Tables.",
    ),
    tenantAgent(
      actors[4]!,
      actors[0]!,
      "Personal Delegate grounded in Jenny's reviewed context.",
    ),
  ];
  // Jenny's private Delegate represents the active Another Me projection.
  tenantAgents[2]!.agent_type = "anotherme";
  tenantAgents[0]!.skill_bindings = [
    {
      description:
        "Review repository changes and report concrete, actionable findings before approval.",
      manifest_version: "1.0.0",
      name: "Review Changes",
      skill_id: "skill-review-changes",
    },
  ];
  tenantAgents[1]!.skill_bindings = [
    {
      description:
        "Research a target market and return a sourced brief for the GTM team.",
      manifest_version: "1.0.0",
      name: "Research Market",
      skill_id: "skill-research-market",
    },
  ];
  const rooms: TeamHubRoomListItem[] = [
    room("room-all", "all", "General collaboration for the whole team.", 4, 4),
    room(
      "room-gtm-launch",
      "gtm-launch",
      "People research, launch planning, and GTM execution.",
      1,
      0,
      1,
      1,
    ),
    room(
      "room-product-v0",
      "product-v0",
      "Ship the Room-centered Product Client V0.",
      3,
      3,
    ),
    room(
      "room-enterprise-readiness",
      "enterprise-launch-readiness-and-compliance-review",
      "Cross-functional launch readiness and compliance review.",
      0,
      0,
    ),
    room(
      "room-structured-delivery",
      "structured-delivery",
      "Verify structured Agent files and concurrent runtime status.",
      3,
      3,
    ),
    {
      ...room(
        "room-dm-codex",
        "Codex",
        "Direct collaboration with Codex.",
        1,
        0,
        1,
      ),
      direct_peer: actorRef(actors[2]!),
      direct_peer_active: true,
      kind: "direct",
    },
    {
      ...room(
        "room-another-me",
        "Chat",
        "Your private Another Me Chat.",
        5,
        5,
        0,
      ),
      direct_peer: actorRef(actors[4]!),
      direct_peer_active: true,
      kind: "direct",
      latest_message: {
        author: actorRef(actors[4]!),
        created_at: "2026-07-23T09:27:00Z",
        id: "message-another-me-setup-sources",
        raw_message: profileSetupSourcesPrompt,
        room_seq: 5,
      },
    },
  ];
  const membersByRoom = new Map<string, TeamHubRoomMember[]>();

  for (const currentRoom of rooms) {
    const roomActors =
      currentRoom.id === "room-dm-codex"
        ? [actors[0]!, actors[2]!]
        : currentRoom.id === "room-another-me"
          ? [actors[0]!, actors[4]!]
          : currentRoom.id === "room-gtm-launch"
            ? [actors[0]!, actors[1]!, actors[3]!]
            : actors;
    membersByRoom.set(
      currentRoom.id,
      roomActors.map((currentActor, index) => ({
        added_by: actorRef(actors[0]!),
        actor: actorRef(currentActor),
        joined_at: createdAt,
        role: index === 0 ? "owner" : "member",
        room_id: currentRoom.id,
        updated_at: createdAt,
      })),
    );
  }

  const agent = actorRef(actors[2]!);
  const decisionOwner = actorRef(actors[0]!);
  const cardAgent = messageCardActorRef(agent);
  const cardDecisionOwner = messageCardHumanActorRef(decisionOwner);
  const workItem: TeamHubWorkItem = {
    assignees: [
      {
        actor: agent,
        assigned_at: "2026-07-30T08:30:00Z",
        assigned_by: agent,
      },
    ],
    created_at: "2026-07-30T08:30:00Z",
    created_by: agent,
    description:
      "Deliver the TeamHub-owned typed-card collaboration path and its read-only Dashboard projection.",
    explicit_access_grants: [],
    id: "work-item-typed-card",
    kind: "task",
    number: 17,
    origin_room_id: "room-product-v0",
    priority: "high",
    referenced_actors: [],
    state: "in_progress",
    tenant_id: tenant.id,
    title: "Ship typed-card collaboration",
    updated_at: "2026-07-30T08:42:00Z",
    updated_by: agent,
    version: 1,
  };
  const longRoomWorkItem: TeamHubWorkItem = {
    assignees: [],
    created_at: "2026-07-29T10:00:00Z",
    created_by: decisionOwner,
    description: "Prepare the cross-functional enterprise launch review.",
    explicit_access_grants: [],
    id: "work-item-enterprise-readiness",
    kind: "issue",
    number: 18,
    origin_room_id: "room-enterprise-readiness",
    priority: "medium",
    referenced_actors: [],
    state: "open",
    tenant_id: tenant.id,
    title: "Prepare enterprise launch readiness review",
    updated_at: "2026-07-29T10:00:00Z",
    updated_by: decisionOwner,
    version: 1,
  };
  const typedCardMessages: TeamHubMessage[] = [
    {
      ...message(
        "message-card-room-creation",
        "room-product-v0",
        actors[2]!,
        "Room creation coordination requested",
        "2026-07-30T08:46:00Z",
      ),
      card: {
        card_type: "personal_notice",
        decision_id: "decision-room-creation",
        decision_owner: cardDecisionOwner,
        intent: "decision_requested",
        kind: "room_creation",
        requester: cardAgent,
        status: "pending",
        title: "Request to create a collaboration room: release-readiness",
        room_creation: {
          description: "Focused release readiness coordination.",
          initial_message_segments: [
            { type: "text", content: "Start the approved Room coordination." },
          ],
          member_ids: ["actor-codex", "actor-maya"],
          name: "release-readiness",
          origin_room_id: "room-product-v0",
        },
        version: 1,
      },
    },
  ];

  const messagesByRoom = new Map<string, TeamHubMessage[]>([
    [
      "room-all",
      [
        message(
          "message-1",
          "room-all",
          actors[1]!,
          "I moved the launch notes into Shared Documents. @codex, please review the release checklist.",
          "2026-07-23T09:12:00Z",
        ),
        {
          ...message(
            "message-2",
            "room-all",
            actors[2]!,
            "Reviewed the checklist. The remaining client risks are realtime recovery and attachment publication. I left the concrete gaps in the integration notes.",
            "2026-07-23T09:14:00Z",
          ),
        },
        message(
          "message-3",
          "room-all",
          actors[3]!,
          "People Search is ready for the first GTM cohort. I found 84 matching product leaders and prepared a table for review.",
          "2026-07-23T09:18:00Z",
        ),
        message(
          "message-4",
          "room-all",
          actors[0]!,
          "Keep the first release focused on Room chat, members, and governed Documents. We can connect Runs and Threads when TeamHub publishes those contracts.",
          "2026-07-23T09:21:00Z",
        ),
        message(
          "message-workflow-query",
          "room-all",
          actors[0]!,
          "@codex Please create a task to adapt the Room panel workflow to real runtime status and drafts.",
          "2026-08-12T10:00:00Z",
        ),
        {
          ...message(
            "message-workflow-task-approval",
            "room-all",
            actors[2]!,
            "Started the Task to adapt the Room panel workflow to runtime drafts.",
            "2026-08-12T10:01:00Z",
          ),
          reply_to_message_id: "message-workflow-query",
        },
      ],
    ],
    [
      "room-gtm-launch",
      [
        message(
          "message-gtm-1",
          "room-gtm-launch",
          actors[3]!,
          "The initial People Search targets B2B founders in Singapore with teams of 20-200.",
          "2026-07-23T08:40:00Z",
        ),
      ],
    ],
    ["room-product-v0", typedCardMessages],
    [
      "room-structured-delivery",
      [
        message(
          "message-structured-delivery-request",
          "room-structured-delivery",
          actors[0]!,
          "@codex Publish the approved review and keep both Agent runs visible.",
          "2026-08-28T09:00:00Z",
        ),
      ],
    ],
    [
      "room-dm-codex",
      [
        message(
          "message-dm-1",
          "room-dm-codex",
          actors[2]!,
          "I can continue the Room V0 implementation here using the same Message and File surfaces.",
          "2026-07-23T09:24:00Z",
        ),
      ],
    ],
    ["room-another-me", anotherMeSetupMessages(actors[4]!, actors[0]!)],
  ]);
  const seededDocuments = createSeedDocuments(actors[0]!, tenant.id);
  const documents = seededDocuments.documents;
  const productBriefVersion = [...seededDocuments.versions.values()].find(
    (version) => version.document_id === productBriefDocumentId,
  );
  if (!productBriefVersion) {
    throw new Error("Product brief seed version is unavailable");
  }
  messagesByRoom.get("room-structured-delivery")?.push({
    ...message(
      "message-structured-delivery-result",
      "room-structured-delivery",
      actors[2]!,
      "The approved review is ready.",
      "2026-08-28T09:01:00Z",
    ),
    raw_message:
      "The approved review is ready. [Open local HTML](./playground/review.html)",
    segments: [
      {
        content:
          "The approved review is ready. [Open local HTML](./playground/review.html)",
        type: "text",
      },
      {
        content: "Open the approved review",
        document_id: productBriefVersion.document_id,
        document_version_id: productBriefVersion.id,
        filename: productBriefVersion.filename,
        media_type: productBriefVersion.media_type,
        type: "file",
      },
    ],
  });
  messagesByRoom
    .get("room-structured-delivery")
    ?.push(
      message(
        "message-legacy-web-citations",
        "room-structured-delivery",
        actors[2]!,
        "**Legacy web sources**\n\nFirst source。\uE200cite\uE202turn3search9\uE201 Second source。\uE200cite\uE202turn0search0\uE202turn0search3\uE201\n\n[Example source](https://example.com/source)\n\nSyntax example: `\uE200cite\uE202turn2view1\uE201`",
        "2026-08-28T09:01:30Z",
      ),
    );
  const offlineLocalReviewerActor = {
    created_at: "2026-09-29T09:30:00.000Z",
    display_name: "Offline Local Reviewer",
    handle: "@offline_local_reviewer",
    id: "actor-offline-local-reviewer",
    kind: "agent" as const,
    tenant_id: tenant.id,
  };
  const offlineLocalReviewer: TestTenantAgent = {
    actor: offlineLocalReviewerActor,
    agent_type: "general",
    agent_management_id: "management-actor-offline-local-reviewer",
    availability: {
      active_task_count: 0,
      current_activity: { summary: "Computer offline" },
      label: "Offline",
      status: "offline",
    },
    configuration_revision: 1,
    created_at: offlineLocalReviewerActor.created_at,
    created_by: actorRef(actors.find((actor) => actor.id === "actor-codex")!),
    description: "Local review Agent retained while its Computer is offline.",
    instructions: "Review local changes when the assigned Computer is online.",
    runtime: {
      model: "openai/gpt-5.4",
      placement: {
        computer_id: "computer-assigned-offline",
        runtime_type: "codex",
        type: "local",
        workspace_grant_id: "grant-assigned-offline",
      },
    },
    skill_bindings: [],
    updated_at: offlineLocalReviewerActor.created_at,
    visibility_scope: "workspace",
  };
  const agentTemplates: TeamHubAgentTemplatePage["items"] = [
    {
      avatar_key: "figure:raccoon:43A46A",
      routines: [],
      connector_bindings: [],
      created_at: "2026-09-01T10:00:00.000Z",
      description: "Reviews changes for correctness, risk, and clarity.",
      instructions: "You are a Code Reviewer working with your Human Sponsor.",
      name: "Code Reviewer",
      origin: "builtin",
      skill_bindings: [
        {
          manifest_version: "1.0.0",
          name: "Review Changes",
          skill_id: "skill-review-changes",
        },
      ],
      template_id: "code-reviewer",
      updated_at: "2026-09-01T10:00:00.000Z",
    },
    {
      routines: [],
      connector_bindings: ["gmail"],
      created_at: "2026-09-02T10:00:00.000Z",
      description: "Turns questions into sourced briefs.",
      instructions: "You are a Research Analyst working with your Sponsor.",
      name: "Market Researcher",
      origin: "published",
      published_by: {
        display_name: "Jenny",
        id: "actor-jenny",
        kind: "human",
        tenant_id: "tenant-northstar",
      },
      skill_bindings: [
        {
          manifest_version: "1.0.0",
          name: "Research Market",
          skill_id: "skill-research-market",
        },
      ],
      template_id: "agent_template_market_researcher",
      updated_at: "2026-09-02T10:00:00.000Z",
    },
  ];
  const localComputers: TeamHubLocalComputerPage["items"] = [
    {
      active_operations: 0,
      available_capacity: 2,
      capacity: 2,
      display_name: "Jenny's Mac",
      computer_id: "computer-jenny-mac",
      runtimes: [
        {
          models: [
            {
              id: "openai/gpt-5.4",
              label: "GPT-5.4",
              allowed_reasoning_effort: ["low", "medium", "high"],
              default_reasoning_effort: "medium",
            },
          ],
          status: "ready",
          type: "codex",
          version: "0.150.1",
        },
      ],
      status: "online",
      upgrade_required: false,
      workspace_grants: [
        {
          grant_id: "grant-linger-workspace",
          label: "Linger Workspace",
          mode: "workspace-write",
        },
      ],
    },
    {
      active_operations: 0,
      available_capacity: 0,
      capacity: 2,
      display_name: "Offline Lab Mac",
      computer_id: "computer-offline-lab",
      last_seen_at: "2026-09-29T10:00:00.000Z",
      runtimes: [
        {
          models: [
            {
              id: "openai/gpt-5.4",
              label: "GPT-5.4",
              allowed_reasoning_effort: ["low", "medium", "high"],
              default_reasoning_effort: "medium",
            },
          ],
          status: "ready",
          type: "codex",
          version: "0.150.1",
        },
      ],
      status: "offline",
      upgrade_required: false,
      workspace_grants: [
        {
          grant_id: "grant-offline-lab",
          label: "Offline Lab Workspace",
          mode: "workspace-write",
        },
      ],
    },
    {
      active_operations: 0,
      available_capacity: 0,
      capacity: 2,
      display_name: "Assigned Offline Mac",
      computer_id: "computer-assigned-offline",
      last_seen_at: "2026-09-29T09:30:00.000Z",
      runtimes: [
        {
          models: [
            {
              id: "openai/gpt-5.4",
              label: "GPT-5.4",
              allowed_reasoning_effort: ["low", "medium", "high"],
              default_reasoning_effort: "medium",
            },
          ],
          status: "ready",
          type: "codex",
          version: "0.150.1",
        },
      ],
      status: "offline",
      upgrade_required: false,
      workspace_grants: [
        {
          grant_id: "grant-assigned-offline",
          label: "Assigned Workspace",
          mode: "workspace-write",
        },
      ],
    },
    {
      active_operations: 0,
      available_capacity: 0,
      capacity: 2,
      display_name: "Legacy Mac",
      computer_id: "computer-legacy-mac",
      last_seen_at: "2026-09-29T08:00:00.000Z",
      runtimes: [
        {
          models: [
            {
              id: "openai/gpt-5.4",
              label: "GPT-5.4",
              allowed_reasoning_effort: ["low", "medium", "high"],
              default_reasoning_effort: "medium",
            },
          ],
          status: "ready",
          type: "codex",
          version: "0.140.0",
        },
      ],
      status: "offline",
      upgrade_required: true,
      workspace_grants: [
        {
          grant_id: "grant-legacy-mac",
          label: "Legacy Workspace",
          mode: "workspace-write",
        },
      ],
    },
  ];
  const eventsByRoom = new Map<string, TeamHubRoomEvent[]>();

  for (const currentRoom of rooms) {
    const events = (messagesByRoom.get(currentRoom.id) ?? []).map(
      (currentMessage, index) => messageEvent(currentMessage, index + 1),
    );
    eventsByRoom.set(currentRoom.id, events);
  }

  return {
    actors: [...actors, offlineLocalReviewerActor],
    agentTemplates,
    directRoomIdByPeerActor: new Map([
      ["actor-codex", "room-dm-codex"],
      ["actor-delegate", "room-another-me"],
    ]),
    documents,
    documentVersionContents: seededDocuments.contents,
    documentVersions: seededDocuments.versions,
    eventsByRoom,
    externalSources: createExternalSourceSeed(),
    identity,
    localComputers,
    membersByRoom,
    runStatusesByRoom: new Map([
      [
        "room-all",
        [
          {
            agent: {
              display_name: actors[2]!.display_name,
              id: actors[2]!.id,
              kind: "agent" as const,
            },
            created_at: "2026-07-23T09:12:30Z",
            id: "run-status-checklist-review",
            run_id: "run-status-checklist-review",
            replied: false,
            revision: 1,
            room_id: "room-all",
            status: "completed",
            updated_at: "2026-07-23T09:14:00Z",
          },
          {
            agent: {
              display_name: actors[2]!.display_name,
              id: actors[2]!.id,
              kind: "agent" as const,
            },
            created_at: "2026-08-12T10:00:30Z",
            id: "run-status-panel-workflow-status",
            run_id: "run-status-panel-workflow-status",
            replied: false,
            revision: 3,
            room_id: "room-all",
            status: "active",
            updated_at: "2026-08-12T10:01:00Z",
          },
        ],
      ],
      [
        "room-structured-delivery",
        [
          {
            agent: {
              display_name: actors[2]!.display_name,
              id: actors[2]!.id,
              kind: "agent" as const,
            },
            created_at: "2026-08-28T09:01:10Z",
            id: "run-status-structured-codex",
            run_id: "run-status-structured-codex",
            replied: false,
            revision: 1,
            room_id: "room-structured-delivery",
            status: "active",
            updated_at: "2026-08-28T09:01:10Z",
          },
          {
            agent: {
              display_name: actors[3]!.display_name,
              id: actors[3]!.id,
              kind: "agent" as const,
            },
            created_at: "2026-08-28T09:01:20Z",
            id: "run-status-structured-lev8",
            run_id: "run-status-structured-lev8",
            replied: false,
            revision: 1,
            room_id: "room-structured-delivery",
            status: "active",
            updated_at: "2026-08-28T09:01:20Z",
          },
        ],
      ],
    ]),
    messagesByRoom,
    runtimePresentationEventsByRunStatusId: new Map([
      [
        "run-status-checklist-review",
        [
          runtimePresentationRecord("1", {
            type: "status.changed",
            status: "thinking",
            title: "Review the remaining client risks",
          }),
          runtimePresentationRecord("2", {
            type: "activity.started",
            activity_id: "activity-checklist-search",
            content: [
              {
                content: "Release checklist and integration notes",
                format: "text",
                label: "Scope",
              },
            ],
            kind: "search",
            title: "Reviewing release risks",
          }),
          runtimePresentationRecord("3", {
            type: "activity.updated",
            activity_id: "activity-checklist-search",
            detail: "Found the remaining client risks",
          }),
          runtimePresentationRecord("4", {
            type: "activity.updated",
            activity_id: "activity-checklist-search",
            detail: "Found the remaining client risks",
          }),
          runtimePresentationRecord("5", {
            type: "activity.finished",
            activity_id: "activity-checklist-search",
            outcome: "succeeded",
          }),
          runtimePresentationRecord("6", {
            type: "status.changed",
            status: "stopped",
            outcome: "completed",
          }),
          runtimePresentationRecord(
            "7",
            {
              type: "presentation.output_created",
              output_id: "message-2",
              output_kind: "message",
              surface: "room_timeline",
            },
            "message-2",
          ),
        ],
      ],
      [
        "run-status-panel-workflow-status",
        [
          runtimePresentationRecord("1", {
            type: "status.changed",
            status: "working",
          }),
          runtimePresentationRecord("2", {
            type: "plan.updated",
            explanation: "Create the requested Room panel workflow.",
            steps: [
              { content: "Parse the Human request", status: "completed" },
              { content: "Draft task parameters", status: "completed" },
              { content: "Create the task", status: "in_progress" },
            ],
          }),
          runtimePresentationRecord("3", {
            type: "activity.started",
            activity_id: "activity-1",
            content: [
              {
                content: "Room panel workflow task creation",
                format: "text",
                label: "Query",
              },
            ],
            kind: "search",
            title: "Searching the workspace",
          }),
          runtimePresentationRecord("4", {
            type: "activity.updated",
            activity_id: "activity-1",
            detail: "Comparing related Room workflows",
          }),
          runtimePresentationRecord("5", {
            type: "activity.finished",
            activity_id: "activity-1",
            content: [
              {
                content: "3 related workflows",
                format: "text",
                label: "Results",
              },
            ],
            outcome: "succeeded",
          }),
          runtimePresentationRecord("6", {
            type: "activity.started",
            activity_id: "activity-2",
            content: [
              {
                content:
                  '{\n  "title": "Create Room panel workflow",\n  "room_id": "room-all"\n}',
                format: "json",
                label: "Input",
              },
            ],
            kind: "tool",
            title: "Using Create task",
          }),
          runtimePresentationRecord("7", {
            type: "activity.updated",
            activity_id: "activity-2",
            detail: "Submitting the task parameters",
          }),
          runtimePresentationRecord("8", {
            type: "activity.updated",
            activity_id: "activity-2",
            detail: "Submitting the task parameters",
          }),
          runtimePresentationRecord(
            "9",
            {
              type: "presentation.output_created",
              output_id: "message-workflow-task-approval",
              output_kind: "card",
              surface: "room_timeline",
            },
            "message-workflow-task-approval",
          ),
        ],
      ],
      [
        "run-status-structured-codex",
        [
          runtimePresentationRecord(
            "1",
            {
              type: "status.changed",
              status: "thinking",
              title: "Check documents\nVerify permissions\nPublish results",
            },
            undefined,
            "segment-structured-codex",
          ),
          runtimePresentationRecord(
            "2",
            {
              activity_id: "activity-structured-codex",
              content: [
                {
                  content: "Publishing the locked Document Version",
                  format: "text",
                  label: "Progress",
                },
              ],
              kind: "tool",
              title: "Using Upload artifacts",
              type: "activity.started",
            },
            undefined,
            "segment-structured-codex",
          ),
        ],
      ],
      [
        "run-status-structured-lev8",
        [
          runtimePresentationRecord(
            "1",
            { type: "status.changed", status: "working" },
            undefined,
            "segment-structured-lev8",
          ),
          runtimePresentationRecord(
            "2",
            {
              activity_id: "activity-structured-lev8",
              content: [
                {
                  content: "Checking the delivery metadata",
                  format: "text",
                  label: "Progress",
                },
              ],
              kind: "review",
              title: "Reviewing delivery metadata",
              type: "activity.started",
            },
            undefined,
            "segment-structured-lev8",
          ),
        ],
      ],
    ]),
    rooms,
    skillManifests: seedSkillManifests(),
    tenant,
    tenantAgents: [...tenantAgents, offlineLocalReviewer],
    workItems: [workItem, longRoomWorkItem],
  };
}

const runtimePresentationRecord = (
  eventOrdinal: string,
  event: TeamHubRuntimePresentationEventRecord["event"],
  messageId?: string,
  segmentId = "segment-panel-workflow-1",
): TeamHubRuntimePresentationEventRecord => ({
  event,
  event_ordinal: eventOrdinal,
  segment_id: segmentId,
  ...(messageId === undefined ? {} : { message_id: messageId }),
});

function seedSkillManifests(): TeamHubSkillManifest[] {
  return [
    skillManifest({
      description: "Turns Room context into a concise research brief.",
      manifestVersion: "2.0.0",
      name: "Research brief",
      packageName: "research-brief",
      skillId: "research-brief",
    }),
    skillManifest({
      description:
        "Use a disciplined workflow before coding. Apply when creating features or fixing bugs.",
      manifestVersion: "1.0.0",
      name: "Superpowers",
      packageName: "superpowers",
      skillId: "simplexai_superpowers",
    }),
    skillManifest({
      description:
        "Use when designing or polishing product UI. Covers hierarchy, spacing, and states.",
      manifestVersion: "1.0.0",
      name: "Impeccable",
      packageName: "impeccable",
      skillId: "simplexai_impeccable",
    }),
    skillManifest({
      description:
        "Use when UI looks generic or off-brand. Keeps Room surfaces calm and scannable.",
      manifestVersion: "1.0.0",
      name: "Taste",
      packageName: "taste",
      skillId: "simplexai_taste",
    }),
    skillManifest({
      description: "Turns Room context into a concise research brief.",
      manifestVersion: "1.0.0",
      name: "Research brief",
      packageName: "research-brief",
      skillId: "research-brief",
    }),
    skillManifest({
      configSchema: {
        additionalProperties: false,
        properties: { prefix: { type: "string" } },
        required: ["prefix"],
        type: "object",
      },
      description:
        "Requires configuration that Agent registration cannot provide.",
      manifestVersion: "1.0.0",
      name: "Configured exporter",
      packageName: "configured-exporter",
      skillId: "configured-exporter",
    }),
    skillManifest({
      availability: "disabled",
      description:
        "A disabled Skill kept visible in the product catalog response.",
      manifestVersion: "1.0.0",
      name: "Legacy summary",
      packageName: "legacy-summary",
      skillId: "legacy-summary",
    }),
    skillManifest({
      description:
        "Review repository changes and report concrete, actionable findings before approval.",
      manifestVersion: "1.0.0",
      name: "Review Changes",
      packageName: "review-changes",
      skillId: "skill-review-changes",
    }),
    skillManifest({
      description:
        "Research a target market and return a sourced brief for the GTM team.",
      manifestVersion: "1.0.0",
      name: "Research Market",
      packageName: "research-market",
      skillId: "skill-research-market",
    }),
  ];
}

function skillManifest({
  availability = "active",
  configSchema = { additionalProperties: false, type: "object" },
  description,
  manifestVersion,
  name,
  packageName,
  skillId,
}: {
  availability?: TeamHubSkillManifest["availability"];
  configSchema?: TeamHubSkillManifest["config_schema"];
  description: string;
  manifestVersion: string;
  name: string;
  packageName: string;
  skillId: string;
}): TeamHubSkillManifest {
  return {
    access_scope: "tenant",
    availability,
    config_schema: configSchema,
    created_at: createdAt,
    created_by_actor_id: "actor-jenny",
    description,
    file_count: 1,
    manifest_version: manifestVersion,
    name,
    package_name: packageName,
    package_sha256: "a".repeat(64),
    size_bytes: 128,
    skill_id: skillId,
    tenant_id: "tenant-northstar",
    updated_at: createdAt,
    updated_by_actor_id: "actor-jenny",
  };
}

export function actorRef(currentActor: TeamHubActor) {
  return {
    display_name: currentActor.display_name,
    id: currentActor.id,
    kind: currentActor.kind,
    tenant_id: currentActor.tenant_id,
  } as const;
}

export function messageCardActorRef(
  currentActor: Pick<TeamHubActor, "display_name" | "id" | "kind">,
) {
  return {
    display_name: currentActor.display_name,
    id: currentActor.id,
    kind: currentActor.kind,
  } as const;
}

export function messageCardHumanActorRef(
  currentActor: Pick<TeamHubActor, "display_name" | "id" | "kind">,
): TeamHubMessageCardHumanActorRef {
  if (currentActor.kind !== "human") {
    throw new Error("Seed card Decision Actor must be Human.");
  }
  return {
    display_name: currentActor.display_name,
    id: currentActor.id,
    kind: currentActor.kind,
  };
}

export function messageEvent(
  currentMessage: TeamHubMessage,
  roomSeq: number,
): TeamHubRoomEvent {
  return {
    actor: currentMessage.author,
    event_id: `event-${currentMessage.id}`,
    event_type: "message.created",
    occurred_at: currentMessage.created_at,
    payload: { kind: "message.created", message: currentMessage },
    room_id: currentMessage.room_id,
    room_seq: roomSeq,
    tenant_id: currentMessage.tenant_id,
  };
}

function actor(
  id: string,
  kind: "agent" | "human",
  displayName: string,
  handle: string,
  accountId?: string,
): TeamHubActor {
  return {
    ...(accountId ? { account_id: accountId } : {}),
    created_at: createdAt,
    display_name: displayName,
    handle,
    id,
    kind,
    tenant_id: "tenant-northstar",
  };
}

function room(
  id: string,
  name: string,
  description: string,
  latestRoomSeq: number,
  readThroughRoomSeq: number,
  unreadMessageCount = 0,
  unreadMentionCount = 0,
): TeamHubRoomListItem {
  return {
    created_at: createdAt,
    created_by: {
      display_name: "Jenny Bin",
      id: "actor-jenny",
      kind: "human",
      tenant_id: "tenant-northstar",
    },
    description,
    id,
    kind: "room",
    latest_room_seq: latestRoomSeq,
    name,
    read_through_room_seq: readThroughRoomSeq,
    tenant_id: "tenant-northstar",
    unread_mention_count: unreadMentionCount,
    unread_message_count: unreadMessageCount,
    updated_at: createdAt,
  };
}

function tenantAgent(
  currentActor: TeamHubActor,
  sponsor: TeamHubActor,
  description: string,
): TestTenantAgent {
  return {
    agent_type: "general",
    actor: currentActor,
    agent_management_id: `management-${currentActor.id}`,
    availability: {
      active_task_count: 0,
      label: "Online",
      status: "online",
    },
    configuration_revision: 1,
    created_at: currentActor.created_at,
    created_by: actorRef(sponsor),
    description,
    instructions: `Assist ${sponsor.display_name} in shared Rooms.`,
    local_runtime_status: {
      computer_id: "computer-jenny-mac",
      computer_status: "online",
      display_name: "Jenny's Mac",
      runtime_type: "codex",
      status: "ready",
    },
    runtime: {
      model: "openai/gpt-5.4",
      placement: {
        type: "local",
        computer_id: "computer-jenny-mac",
        runtime_type: "codex",
        workspace_grant_id: "grant-linger-workspace",
      },
    },
    skill_bindings: [],
    updated_at: currentActor.created_at,
    visibility_scope: "workspace",
  };
}

function message(
  id: string,
  roomId: string,
  author: TeamHubActor,
  body: string,
  timestamp: string,
): TeamHubMessage {
  return {
    attachments: [],
    author: actorRef(author),
    created_at: timestamp,
    id,
    message_kind: "conversation",
    raw_message: body,
    room_id: roomId,
    segments: [{ content: body, type: "text" }],
    tenant_id: "tenant-northstar",
  };
}

function createSeedDocuments(createdBy: TeamHubActor, tenantId: string) {
  const inputs: Array<{
    content: string;
    documentId: string;
    filename: string;
    mediaType: string;
    sha256: string;
  }> = [
    {
      content:
        "# Product V0\n\nRoom-first collaboration with Human and Agent members.\n\n- Chat\n- Members\n- Shared Documents\n",
      documentId: productBriefDocumentId,
      filename: "product-v0-brief.md",
      mediaType: "text/markdown",
      sha256:
        "f25d6ac200eb7f00425eeac2b498850ab97069d81cd2bf16e4d58494b6861692",
    },
    {
      content: [
        "# 2048 PRD (W1)",
        "",
        "## Goal",
        "Ship a classic 4x4 2048 MVP playable in desktop and mobile browsers.",
        "",
        "## P0 scope",
        "- Slide, merge, and scoring",
        "- One-step undo",
        "- Local save",
        "- Keyboard / touch input",
        "",
        "## Acceptance",
        "Every P0 requirement needs a runnable acceptance case; nothing unconfirmed enters W2.",
        "",
      ].join("\n"),
      documentId: gamePrdDocumentId,
      filename: "2048-prd.md",
      mediaType: "text/markdown",
      sha256:
        "1111111111111111111111111111111111111111111111111111111111111111",
    },
    {
      content: [
        "# 2048 technical architecture (W2)",
        "",
        "## Layers",
        "1. Pure-function game engine (rules / random seed)",
        "2. State reducer + save adapter",
        "3. Input adapters (keyboard / touch / buttons)",
        "4. Rendering layer (never touches rules)",
        "",
        "## Current focus",
        "Freeze the engine interface and test boundary so UI and storage stay replaceable.",
        "",
      ].join("\n"),
      documentId: gameArchitectureDocumentId,
      filename: "2048-architecture.md",
      mediaType: "text/markdown",
      sha256:
        "2222222222222222222222222222222222222222222222222222222222222222",
    },
    {
      content: [
        "# Collaborative editing check notes",
        "",
        "Opening this file should enter the Room Document collaborative editor.",
        "",
        "- Multi-user cursors / presence",
        "- State recovery after an offline reconnect",
        "- A stable Document Version after saving",
        "",
        "Edit a few sentences right here to check that the editing path works end to end.",
        "",
      ].join("\n"),
      documentId: gameNotesDocumentId,
      filename: "2048-collab-notes.md",
      mediaType: "text/markdown",
      sha256:
        "3333333333333333333333333333333333333333333333333333333333333333",
    },
    {
      content:
        "sequenceDiagram\n  participant Human\n  participant TeamHub\n  participant Agent\n  Human->>TeamHub: @agent Message\n  TeamHub->>Agent: Agent Link\n  Agent->>TeamHub: Agent Message\n  TeamHub-->>Human: Room Event\n",
      documentId: "document-room-agent-flow",
      filename: "room-agent-flow.mmd",
      mediaType: "text/plain",
      sha256:
        "a9a6f569be741b698b04b2e6c3a13c6c6aaec71103a54dada4ddaa75b7d5776c",
    },
    {
      content:
        "[00:02:52 - 00:03:09] Sure, sure, then you you you just follow this, this format here and that works. Fine, fine, so I. And then look, this part needs some breathing room, you know? Bao said.\n\n[00:03:09 - 00:03:15] Look, it blinks, but it does not tell you it is recording. And what you have now is not the same thing either.\n\n[00:03:15 - 00:03:33] Right, so, I feel like, because our earlier one, version A looked like this, you know? Ours really looks like this, but this may need a change.\n\n[00:03:33 - 00:03:43] Like we should build it ourselves. Okay okay, you you send me a screenshot, I am online.\n\n[00:03:43 - 00:03:47] Sure, I will send it to you, send it over.\n\n[00:04:49 - 00:04:51] What can you do?\n\n[00:05:11 - 00:05:14] Just leave it running locally. Mm.\n\n[00:05:14 - 00:05:15] Mm\n\n[00:05:41 - 00:05:43] Mm\n",
      documentId: "document-meeting-transcript",
      filename: "transcript.md",
      mediaType: "text/markdown",
      sha256:
        "caf762562e47701c63dcf81060e7861e975c8e7491826117cb89091f4ec699c5",
    },
    {
      content:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 220"><rect width="640" height="220" fill="#f7f8f8"/><rect x="45" y="70" width="150" height="80" rx="8" fill="#dff5f1" stroke="#0f766e"/><rect x="245" y="70" width="150" height="80" rx="8" fill="#eef2ff" stroke="#315fb5"/><rect x="445" y="70" width="150" height="80" rx="8" fill="#fff4df" stroke="#b45309"/><path d="M195 110h50m150 0h50" stroke="#606873" stroke-width="2"/><text x="120" y="116" text-anchor="middle" font-family="sans-serif" font-size="17">Product Client</text><text x="320" y="116" text-anchor="middle" font-family="sans-serif" font-size="17">TeamHub</text><text x="520" y="116" text-anchor="middle" font-family="sans-serif" font-size="17">Agent Service</text></svg>',
      documentId: "document-top-level-architecture",
      filename: "top-level-architecture.svg",
      mediaType: "image/svg+xml",
      sha256:
        "7e41c8e11578807e5e0e01f1d5bfe8a29ffa42f911487739f225730c127a53c2",
    },
    {
      content: "PK fixture archive for download-only behavior",
      documentId: "document-lev8-gtm-assets",
      filename: "lev8-gtm-assets.zip",
      mediaType: "application/zip",
      sha256:
        "70b1f586b40a29afa751fe326d68367257655aa296caca0c9a29c52c10c70021",
    },
  ];
  const contents = new Map<string, Blob>();
  const documents = new Map<string, TeamHubDocument>();
  const versions = new Map<string, TeamHubDocumentVersion>();
  for (const input of inputs) {
    const versionId = `${input.documentId}-version-1`;
    const blob = new Blob([input.content], { type: input.mediaType });
    const version: TeamHubDocumentVersion = {
      document_id: input.documentId,
      created_at: createdAt,
      created_by: actorRef(createdBy),
      filename: input.filename,
      id: versionId,
      media_type: input.mediaType,
      representation_format:
        input.mediaType === "text/markdown" ? "markdown" : "binary",
      sha256: input.sha256,
      size_bytes: blob.size,
      source: "ordinary_upload",
      version_number: 1,
    };
    contents.set(versionId, blob);
    versions.set(versionId, version);
    documents.set(input.documentId, {
      capabilities: {
        comment: true,
        delete: true,
        duplicate: true,
        export: true,
        manage: true,
        read: true,
        use_as_context: true,
        write: true,
      },
      created_at: createdAt,
      creator: actorRef(createdBy),
      current_version: {
        id: version.id,
        sha256: version.sha256,
        version_number: version.version_number,
      },
      can_edit_native_content: true,
      draft_capability: "write",
      format: version.representation_format,
      representation_format: version.representation_format,
      from: [{ binding_kind: "room", context_id: "room-all" }],
      id: input.documentId,
      owner: actorRef(createdBy),
      status: "active",
      tenant_id: tenantId,
      title: input.filename,
      updated_at: createdAt,
    });
  }
  // A BlockNote Document makes the Room Document editor and its anchored
  // comment lane reachable.
  const transcript = documents.get("document-meeting-transcript");
  if (transcript) transcript.format = "blocknote";
  return { contents, documents, versions };
}

// TeamHub's template opening and its two AnotherMe setup cards: the apps
// card already answered, the sources card waiting for Jenny.
const profileSetupAppsPrompt =
  "Before I help with replies and follow-ups, I'd like to get to know you. The quickest way is to let me see where you talk about work — one account is enough.";
const profileSetupSourcesPrompt =
  "Do you have a personal website or portfolio? Paste a link, or upload your resume and work samples.";

function anotherMeSetupMessages(
  anotherMe: TeamHubActor,
  human: TeamHubActor,
): TeamHubMessage[] {
  const roomId = "room-another-me";
  const setupCard = (
    id: string,
    kind: "profile_setup_apps" | "profile_setup_sources",
    title: string,
    view: { apps?: string[]; more_apps?: string[] },
    version: number,
  ) => ({
    card_type: "personal_notice" as const,
    decision_id: id,
    decision_owner: messageCardHumanActorRef(human),
    intent: "decision_requested" as const,
    kind,
    profile_setup: view,
    requester: messageCardActorRef(anotherMe),
    title,
    version,
  });
  return [
    message(
      "message-another-me-welcome",
      roomId,
      anotherMe,
      "Hi jenny, I'm your Another Me — think of me as another you in Linger.",
      "2026-07-23T09:25:00Z",
    ),
    {
      ...message(
        "message-another-me-setup-apps",
        roomId,
        anotherMe,
        profileSetupAppsPrompt,
        "2026-07-23T09:25:00Z",
      ),
      card: {
        ...setupCard(
          "decision-another-me-setup-apps",
          "profile_setup_apps",
          profileSetupAppsPrompt,
          { apps: ["gmail"], more_apps: ["github"] },
          2,
        ),
        answer: { decision: "connected" },
        decided_at: "2026-07-23T09:26:00Z",
        decided_by: messageCardHumanActorRef(human),
        status: "answered",
      },
    },
    message(
      "message-another-me-setup-connected",
      roomId,
      human,
      "Connected",
      "2026-07-23T09:26:00Z",
    ),
    message(
      "message-another-me-setup-ack",
      roomId,
      anotherMe,
      "Got it.",
      "2026-07-23T09:26:00Z",
    ),
    {
      ...message(
        "message-another-me-setup-sources",
        roomId,
        anotherMe,
        profileSetupSourcesPrompt,
        "2026-07-23T09:27:00Z",
      ),
      card: {
        ...setupCard(
          "decision-another-me-setup-sources",
          "profile_setup_sources",
          profileSetupSourcesPrompt,
          {},
          1,
        ),
        status: "pending",
      },
    },
  ];
}

export const seedTeamMd: TeamHubTeamMdDocument = {
  collaborate_pattern: "adversarial-verification",
  task_goal: "Review the launch plan against implementation evidence.",
  orchestrator: {
    name: "Codex",
    actor_id: "actor-codex",
    role: "Prepare the implementation plan, provide evidence, and resolve review findings.",
    receive_from: [],
    report_to: [],
  },
  members: [
    {
      name: "Lev8 GTM",
      actor_id: "actor-lev8",
      role: "Independently verify the launch assumptions and return evidence for each finding.",
      receive_from: ["Codex"],
      report_to: ["Codex"],
    },
  ],
  revision: 1,
  updated_at: "2026-10-15T08:00:00Z",
  raw_markdown:
    "---\ncollaborate_pattern: adversarial-verification\n---\n\n## Task Goal\n\nReview the launch plan against implementation evidence.\n\n## Orchestrator\n\n- Codex\n  - ID: actor-codex\n  - Role: Prepare the implementation plan, provide evidence, and resolve review findings.\n\n## Team Member\n\n- Lev8 GTM\n  - ID: actor-lev8\n  - Role: Independently verify the launch assumptions and return evidence for each finding.\n  - Receive from: Codex\n  - Report to: Codex\n",
};

export const seedProfile: TeamHubPersonalProfileDocument = {
  name: "Jenny Bin",
  background: {
    overview:
      "Product-minded operator who turns ambiguous collaboration into durable plans.",
    points: [],
    timeline: [
      {
        period: "2021–Present",
        organization: "Northstar",
        place: "",
        role: "Operations lead",
        description: "Runs planning across product and customer teams.",
        details: [],
      },
    ],
  },
  communication_style: {
    overview: "Direct and written-first.",
    points: [],
  },
  working_style: {
    overview: "",
    points: [
      {
        title: "Execution",
        text: "Keeps execution close to customer outcomes.",
        items: [
          "Prefers direct evidence and clear ownership",
          "Uses written decisions to reduce coordination cost",
        ],
      },
    ],
  },
  preferences: { overview: "Prefers async updates.", points: [] },
  writing_style: { overview: "Short, concrete sentences.", points: [] },
};
// TeamHub renders this Markdown from the document; the Web reads the fields.
export const seedProfileMarkdown =
  "# Jenny Bin\n\n## Background\n\nProduct-minded operator who turns ambiguous collaboration into durable plans.";

/** The external sources TeamHub lists for the seeded Human. */
export function createExternalSourceSeed() {
  const now = "2026-08-06T08:00:00.000Z";
  const reminders = [
    "connect",
    "personal_wiki_import",
    "agent_tools",
    "proactive_reminders",
  ] as const;
  // A subset of the fixed list, in the order TeamHub returns it.
  const apps: TeamHubExternalApp[] = [
    {
      allows_multiple_connections: true,
      availability: "available",
      capabilities: [...reminders],
      description: "Connect email for Personal Wiki imports.",
      display_name: "Gmail",
      key: "gmail",
    },
    {
      allows_multiple_connections: true,
      availability: "available",
      capabilities: [...reminders],
      description: "Connect workspaces and selected channels.",
      display_name: "Slack",
      key: "slack",
    },
    {
      allows_multiple_connections: true,
      availability: "unavailable",
      capabilities: ["connect", "personal_wiki_import", "agent_tools"],
      description: "Connect discord data.",
      display_name: "Discord",
      key: "discord",
    },
    {
      allows_multiple_connections: true,
      availability: "unavailable",
      capabilities: [],
      description: "Connect facebook data.",
      display_name: "Facebook",
      key: "facebook",
    },
    {
      allows_multiple_connections: true,
      availability: "available",
      capabilities: ["connect", "personal_wiki_import"],
      description: "Connect a public profile and selected public repositories.",
      display_name: "GitHub",
      key: "github",
    },
    {
      allows_multiple_connections: true,
      availability: "unavailable",
      capabilities: [],
      description: "Connect google meet data.",
      display_name: "Google Meet",
      key: "google_meet",
    },
    {
      allows_multiple_connections: true,
      availability: "unavailable",
      capabilities: [...reminders],
      description: "Connect google calendar data.",
      display_name: "Google Calendar",
      key: "google_calendar",
    },
    {
      allows_multiple_connections: true,
      availability: "available",
      capabilities: ["connect", "personal_wiki_import", "agent_tools"],
      description: "Connect Notion and use selected pages or databases.",
      display_name: "Notion",
      key: "notion",
    },
  ];
  const connections: TeamHubExternalConnection[] = [
    {
      auto_reminders: true,
      created_at: now,
      id: "external-connection-gmail",
      identity_label: "jenny@linger.test",
      provider: "gmail",
      revision: 1,
      status: "active",
      status_checked_at: now,
      updated_at: now,
    },
  ];
  const agentAccess = new Map<string, TeamHubExternalConnectionAgentAccess[]>(
    connections.map((item) => [
      item.id,
      [
        {
          agent_actor_id: "actor-anotherme-jenny",
          agent_management_id: "anotherme-jenny",
          agent_display_name: "Jenny's AnotherMe",
          tenant_id: "tenant-northstar",
          granted: true,
          revision: 1,
        },
      ],
    ]),
  );
  const conversations: TeamHubSlackConversation[] = [
    { id: "C01", is_private: false, kind: "public_channel", name: "general" },
    { id: "C02", is_private: false, kind: "public_channel", name: "product" },
    {
      id: "C03",
      is_private: true,
      kind: "private_channel",
      name: "leadership",
    },
  ];
  const discordChannels: TeamHubDiscordChannel[] = [
    { id: "D01", kind: "text", name: "general" },
    { id: "D02", kind: "forum", name: "product-feedback" },
  ];
  const googleCalendars: TeamHubGoogleCalendar[] = [
    {
      access_role: "owner",
      id: "primary",
      primary: true,
      selected: true,
      summary: "Primary calendar",
    },
    {
      access_role: "reader",
      id: "team",
      primary: false,
      selected: true,
      summary: "Team calendar",
    },
  ];
  const notionResources: TeamHubNotionResource[] = [
    {
      id: "page-about",
      kind: "notion_page",
      title: "About me",
      url: "https://www.notion.so/about-me",
    },
    {
      id: "db-projects",
      kind: "notion_database",
      title: "Projects",
      url: "https://www.notion.so/projects",
    },
  ];
  const githubRepositories: TeamHubGitHubRepository[] = [
    {
      default_branch: "main",
      description: "Product collaboration workspace",
      full_name: "jenny/linger",
      html_url: "https://github.com/jenny/linger",
      id: "1001",
      language: "TypeScript",
      name: "linger",
      updated_at: now,
    },
  ];
  return {
    agentAccess,
    apps,
    connections,
    conversations,
    discordChannels,
    githubRepositories,
    googleCalendars,
    notionResources,
  };
}
