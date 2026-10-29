# Support chat (live chat bubble + ticket inbox)

An Intercom-style chat bubble for the instance's own pages (landing, sign-in, /apply, the app) and any other website
that embeds the script, answered from an inbox in the web app (Admin → Support) and in the iOS app. Every chat is a
ticket with a number, a status and an assignee. Off by default; an instance admin turns it on in Admin → Support.

Built for the Workers Free plan: no Durable Objects or WebSockets, the widget polls only while it is open (every 5 s,
paused while the tab is hidden) and checks for unread replies once per page load and then every 60 s while a
conversation exists. Staff get APNs pushes, so the iOS app needs no polling.

## Data (migrations/0021_support.sql)

```sql
CREATE TABLE support_conversations (
  id TEXT PRIMARY KEY,                 -- sc_<random>
  number INTEGER NOT NULL UNIQUE,      -- ticket #, MAX(number) + 1
  status TEXT NOT NULL DEFAULT 'open', -- open | pending (waiting on the customer) | closed
  subject TEXT,                        -- first line of the first message unless staff renames it
  name TEXT, email TEXT,               -- given in the widget, or the signed-in user's
  user_id TEXT, workspace_id TEXT,     -- signed-in Postflare user (same-origin widget or the app)
  visitor_hash TEXT NOT NULL,          -- sha256 of the visitor token (the widget's localStorage secret)
  source TEXT NOT NULL,                -- widget | app
  page_url TEXT, user_agent TEXT, ip TEXT, country TEXT,
  assignee_id TEXT,
  staff_unread INTEGER NOT NULL DEFAULT 0,     -- customer messages no staff member has opened yet
  customer_unread INTEGER NOT NULL DEFAULT 0,  -- staff replies the customer has not seen
  customer_seen_at INTEGER,            -- last time the widget fetched the conversation
  last_message_at INTEGER NOT NULL, last_message_preview TEXT, last_author TEXT, -- customer | staff
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER
);
CREATE TABLE support_messages (
  id TEXT PRIMARY KEY,                 -- sm_<random>
  conversation_id TEXT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  author TEXT NOT NULL,                -- customer | staff | note (internal, never shown to the customer)
  author_id TEXT, author_name TEXT,
  body TEXT NOT NULL,                  -- plain text, max 5000 characters
  created_at INTEGER NOT NULL
);
```

Instance permission `instance.support.manage` ("Answer support chats"), added to the built-in Admin role. Settings:
`support_enabled` ("1"), `support_team_name`, `support_greeting`.

## Public API (the widget; no session needed)

CORS: `Access-Control-Allow-Origin: *` without credentials, so other websites can embed the widget. The visitor is
identified by `X-Support-Visitor: <token>` (32+ random characters the widget keeps in localStorage). On the instance's
own origin the session cookie is also read: the conversation is linked to the user (name, email, current workspace),
and a signed-in user sees their conversations from any browser.

- `GET /api/support/widget` → `{ enabled, teamName, greeting, staff }` (`staff`: the signed-in user answers chats; the
  widget hides itself for them).
- `GET /api/support/conversations` → `{ items: SupportConversationDTO[] }` of this visitor (and user), newest first.
- `POST /api/support/conversations { body, name?, email?, pageUrl?, website? }` → `{ conversation, messages }`.
  `website` is a honeypot (must be empty). Limits: 5 new conversations per IP per hour.
- `GET /api/support/conversations/:id?after=<ms>` → `{ conversation, messages }` (messages newer than `after`; notes
  never included). Marks staff replies seen (`customer_unread = 0`, `customer_seen_at = now`).
- `POST /api/support/conversations/:id/messages { body }` → `{ message, conversation }`. A closed conversation
  reopens. Limit: 20 messages per conversation per 10 minutes.
- `PATCH /api/support/conversations/:id { name?, email? }` → the visitor adds contact details later.

A visitor who is not the conversation's (token and user both differ) gets 404.

## Staff API (`instance.support.manage`; web session or iOS device token)

- `GET /api/admin/support/conversations?status=open|pending|closed|all&mine=1&q=&before=<last_message_at>&limit=` →
  `{ items, counts: { open, pending, closed, unread }, nextBefore }`. Sorted by `last_message_at` desc.
- `GET /api/admin/support/conversations/:id` → `{ conversation, messages, user?, workspace? }` (notes included).
  Marks it read (`staff_unread = 0`).
- `POST /api/admin/support/conversations/:id/messages { body, note?: boolean, status?: "open"|"pending"|"closed" }`
  → `{ message, conversation }`. A reply sets `status` (default `pending`); a note changes nothing.
- `PATCH /api/admin/support/conversations/:id { status?, assigneeId?: string|null, subject? }` → conversation.
- `DELETE /api/admin/support/conversations/:id` (spam).
- `GET /api/admin/support/count` → `{ unread, open }` (nav badges).
- `GET|PATCH /api/admin/support/settings { enabled, teamName, greeting }`.
- `GET /api/admin/support/staff` → users with the permission (assignee picker).

## Notifications

- A customer message → APNs to devices of active users with `instance.support.manage` whose prefs have
  `support !== false`: title "<name or email or Visitor>", body the message, `thread-id: support-<id>`,
  `collapse-id: <id>`, data `{ "type": "support_message", "id": "<conversation id>" }`. Tapping opens the
  conversation in the app. Max 5 devices per event, sent after the response (`waitUntil`).
- A staff reply → if the conversation has an email, email is configured and the widget has not fetched the
  conversation in the last 2 minutes: an email with the reply and a link back to the page it was started on (best
  effort; on Workers Free only verified addresses receive it).

## Widget (`/support/widget.js`)

`<script src="https://<instance>/support/widget.js" async></script>`. Vanilla JS in a shadow root (no styles leak
either way), bottom-right bubble with an unread dot, panel with the greeting, the conversation list (when there is
more than one), the thread and a composer. A first message from an anonymous visitor asks for an optional email ("so
we can reply if you leave"). Light/dark follows `prefers-color-scheme`. Included on the landing page, /apply, the
sign-in page and the app.

## Web inbox (Admin → Support)

Two panes: filterable list (Open / Pending / Closed / All, Mine, search) with unread dots, and the conversation:
thread, reply box (Reply, Reply & close, Internal note), status and assignee, customer card (email, user and
workspace links, page, browser, country). Polls the open conversation every 5 s and the list every 20 s while
visible. Nav badge = unread count.

## iOS

Settings → Support (for users with the permission, like Access requests): list with the same filters, conversation
view with the composer (reply / note / close), status and assignee menu, pull to refresh and a 5 s refresh while the
conversation is on screen. Push type `support_message` opens the conversation; a prefs toggle "Support messages".
