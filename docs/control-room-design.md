# Control Room: customer-facing dashboard design

Status: **proposal**. Nothing in this document is implemented unless a section
says so and cites the file. The clickable mockup lives at
`docs/assets/control-room-mockup.html`; every number, agent and receipt in it is
sample data.

## 1. Problem

A customer who installs HUQAN cannot see HUQAN doing its job. Today's local UI
(`public/index.html`) opens on panels that report what is missing: dashes,
`LOCKED`, `API key required`, a surface counter such as `2/5`. Nothing on the
first screen answers the three questions a customer actually has:

1. What did my agents try to do, and with which tools?
2. What did HUQAN decide, and why?
3. What is waiting on me?

The product promise is a checkpoint between "the model said it" and "we trusted
it". The Control Room is where that promise has to be visible, every day,
without reading logs.

## 2. Principles

- **Show the work, not the wiring.** The first screen is decisions and the
  approval queue. Setup gaps collapse into one line; they never occupy a panel.
- **Every figure is counted from a record.** Watched / passed / waiting /
  blocked are counts of recorded gate decisions, never client-side estimates.
  If a figure cannot be traced to a record, it is not shown.
- **Unverifiable is its own state.** A receipt whose chain cannot be checked is
  never counted as passed, and the UI never prints a success message over a
  broken chain.
- **HUQAN's own errors stay out of agent decisions.** System problems live in a
  separate Errors view with a badge; they are not mixed into the activity feed.
- **Motion only where state changes.** A new approval request arrives; an
  approval turns into a sealed receipt. No scroll-driven or ambient animation
  on a surface people use all day. `prefers-reduced-motion` is honoured.

## 3. Information architecture

| View | Job | Main content |
| --- | --- | --- |
| Overview | "Is HUQAN doing its job?" | Decision summary bar, 7-day trend, waiting-on-you queue, connected agents, latest actions, one-line system notice |
| Agent activity | "What did my agents do?" | One row per attempted action: agent, tool, what it tried, decision, receipt. Search and filters by agent, tool, decision; saved views. Row opens the decision chain |
| Approvals | "What is waiting on me?" | Queue of paused actions with the policy reason and evidence count; approve or reject with a stated reason |
| Receipts | "Can I prove it?" | Receipt archive split into verified, awaiting approval and unverifiable |
| Agents | "Who is being watched?" | Connected, disconnected and never-connected agents; per-agent counts and a 24-hour activity sparkline |
| Errors | "Is HUQAN itself healthy?" | Connection, storage and receipt-check problems, kept apart from decisions |
| Notifications | "Tell me without opening the page" | Adapters and routing rules (section 6) |
| Customize | "Put it in my order" | Reorder and hide sidebar items and Overview widgets (section 5) |
| Coming soon | Honest roadmap | Planned features, never shown as locked panels elsewhere |

### The decision chain

Selecting any action opens the same five-step chain, so a customer learns one
mental model:

`Agent asked` → `Evidence` → `Policy` → `Approval` → `Receipt`

Each step carries its own state (passed, needs a person, blocked, not required,
unverifiable) and the policy name that produced it.

### Decision buckets

The Overview bar and every count use these buckets. The mockup shows the first
four; **auto-approved must be added** before implementation (section 7):

| Bucket | Meaning |
| --- | --- |
| Passed on policy | `allow` without a person |
| Passed after approval | `review`, then approved by a person |
| Auto-approved | `review`, allowed because human approval was switched off for it |
| Waiting for review | `review`, no decision yet |
| Blocked | `block`, or `review` rejected by a person |

Auto-approved is deliberately separate. Folding it into "passed" would make
switching approval off invisible in the very figures meant to prove oversight.

## 4. Where the data comes from

| Figure or view | Source today | Gap |
| --- | --- | --- |
| Decision counts and trend | Gate decisions emitted by `lib/gate-telemetry.js` into the observability store through `lib/observability/kernel-sink.js`; `plugins/metric-collector.js` observes the same `afterGateDecision` event | Counts are only complete since the sink was attached to MCP and CLI processes. The Overview must show "counting since <date>" rather than imply full history |
| Activity feed | `/api/workbench/activity` and the observability events read surface `/api/observability/v1/events` (see `docs/observability-dashboard-events.md`) | Tool and agent attribution must be confirmed per event type; missing attribution is shown as "unattributed", not guessed |
| Approval queue | `/api/v2/approvals`, MCP `huqan.approvals`, decisions through `huqan.approve` | Rejection reason capture in the UI |
| Receipts | `/api/trust-receipt`, MCP `huqan.trust_receipt` | A list view that exposes verified / pending / unverifiable as a filter |
| Auto-approved bucket | `lib/human-approval-toggle.js` stamps `autoApproved: true` and keeps `originalDecision` in gate metadata | Needs to be aggregated as its own count |
| Connected agents | **No source.** There is no agent registry or heartbeat in the runtime today | Needs a design decision: derive "last seen" from the most recent gate event per client identity, or add an explicit registration. Until then the Agents view cannot ship |
| Errors | Scattered: notification adapter failures, receipt verification failures, sink attachment | Needs one bounded error feed |
| Roles (Admin / Approver / Viewer) | Not present | Needs an authorization model before approve buttons are role-gated in the UI |

## 5. Customization

- Sidebar items can be dragged directly in the sidebar, or reordered and hidden
  from the Customize view with arrow buttons (keyboard accessible).
- Overview widgets can be reordered and hidden the same way.
- Overview and Customize can never be hidden, so the layout can always be
  restored. "Reset to default" restores the original order.
- Saved activity views store only filter values (agent, tool, decision, search).
- Layout preferences are per browser and carry no receipt content, API key or
  workspace secret, matching the rule `public/js/onboarding-checklist.js`
  already follows.

## 6. Notifications and chat adapters

### Today

`lib/observability/notification-adapter.js` is an HTTPS webhook adapter with an
HMAC-SHA256 signature, bounded retries and redacted payloads, wired only for
observability alert lifecycle events and only when a caller passes it
explicitly (`docs/observability-notifications.md`).

### Proposal

Slack, Telegram, Microsoft Teams and email are adapters behind that same
boundary, not new code paths around it. Each keeps the existing guarantees:
signed delivery, redacted payload, bounded retry, failure isolated from the
decision path.

Routing rules are chosen by the customer per event type:

| Event | Example route |
| --- | --- |
| Action blocked | Telegram |
| Approval requested | Slack channel of the approvers |
| Receipt unverifiable | Email to the admin |
| HUQAN system error | Email to the admin |

**Notify and approve are separate capabilities.** "Tell me" can go to anyone
the customer configures. "Approve from chat" is a second, later slice: the chat
button must call back through an authenticated, signed endpoint, resolve to a
person with the Approver role, and produce the same receipt an in-app approval
produces. Until that exists, chat messages link to the Approvals view.

## 7. From human approval to automation

### Today

`lib/human-approval-toggle.js` implements #321 as one process-wide switch,
`HUQAN_HUMAN_APPROVAL_DISABLED=true`. It only converts `review` into `allow`,
never touches `block`, is off by default, and records `autoApproved` with the
original decision in metadata.

### Proposal

Keep those guarantees and make the switch visible and narrow:

- **Per policy, not global.** The Approvals view shows an "Auto-approve" switch
  next to each policy that can produce `review`. Running the test suite can be
  automated; pushing to a protected branch cannot.
- **Some policies can never be automated.** Money movement, destructive schema
  changes, bulk personal data egress and cross-workspace access stay locked to
  a person. The lock is enforced by the runtime, not only hidden in the UI.
- **Switching it is itself a receipt:** who changed which policy, when, and
  why.
- **Optional expiry:** "auto-approve for 24 hours, then ask again".
- **Admin only.**
- **Always counted:** auto-approved actions appear in their own bucket
  (section 3) and in the activity feed with the reason.

The global environment switch remains for headless and CI use, and the Control
Room shows a persistent banner while it is on.

## 8. First-run setup wizard

### Today

`public/js/onboarding-checklist.js` (#1931) is a dismissible three-step
checklist on Home: connect the session, run one read workflow, open the
evidence behind an answer. A step completes only when the underlying request
succeeded.

### Proposal

Extend that checklist into a guided first run, keeping its rules (outcomes,
not clicks; never a blocking modal; progress stored locally without secrets):

| Step | Outcome that completes it |
| --- | --- |
| 1. Connect this workspace | Session saved and a runtime surface answered |
| 2. Connect your first agent | The MCP config snippet for the chosen client was copied and HUQAN received that agent's first gate event |
| 3. Watch the first decision | One real action reached the gate and appears in Agent activity |
| 4. Open its receipt | The receipt for that action was opened and verified |
| 5. Choose how strict to be | Approval policy reviewed; optional auto-approve choices recorded as receipts |
| 6. Get notified | One adapter configured and a signed test notification delivered |

Visual treatment:

- One icon per step, drawn from a single icon set, with a clear pending /
  in-progress / done state.
- A short, state-driven animation when a step completes, and a final moment
  when the first real receipt appears: the decision chain draws itself once.
- All motion is disabled under `prefers-reduced-motion`; the wizard stays fully
  usable without it.
- Skippable at every step, resumable later from Home.

## 9. Visual direction

The mockup sets the direction; it is not a component library.

- HUQAN navy and gold as the brand pair, with separate semantic colours:
  passed green, review blue, blocked red, system error violet. Review is not
  gold, so a waiting action is never confused with brand decoration.
- Translucent, blurred surfaces over soft background light instead of hard
  borders; separators fade at their ends. A solid-surface fallback applies
  where backdrop blur is unsupported.
- Smooth stacked area chart for the trend, a ring for "decided by policy
  alone", sparklines per agent.
- Light and dark themes defined from one token set.
- Display type for figures and headings, a text face for prose, a monospace
  face only for agent names, tools, policies and receipt identifiers.

## 10. Out of scope for this document

- Any runtime, API or UI implementation.
- Hosted or multi-tenant deployment, SSO, billing.
- Approve-from-chat (named above as a later slice).
- Changes to gate semantics other than the scoped auto-approve proposal.

## 11. Suggested order

1. Decision buckets and the auto-approved count from existing gate telemetry,
   with "counting since" shown.
2. Overview, Agent activity and Approvals on existing read surfaces.
3. Receipts list with the unverifiable state.
4. Agent identity and last-seen design, then the Agents view.
5. Per-policy auto-approve with runtime-enforced locks and change receipts.
6. Setup wizard on top of the existing checklist.
7. Chat notification adapters behind the existing webhook boundary.
8. Customization, roles, approve-from-chat.
