-- Support chat (docs/support-spec.md): conversations (tickets) and their messages, and the permission to answer them.
-- Keep every statement on its own: worker/lib/migrate.ts splits on ";" + newline. No ";" inside string literals.
CREATE TABLE support_conversations (
  id TEXT PRIMARY KEY, -- sc_<random>
  number INTEGER NOT NULL UNIQUE, -- ticket number shown as #12
  status TEXT NOT NULL DEFAULT 'open', -- open | pending (waiting on the customer) | closed
  subject TEXT,
  name TEXT,
  email TEXT,
  user_id TEXT, -- signed-in Postflare user
  workspace_id TEXT,
  visitor_hash TEXT NOT NULL, -- sha256 of the widget's visitor token
  source TEXT NOT NULL, -- widget | app
  page_url TEXT,
  user_agent TEXT,
  ip TEXT,
  country TEXT,
  assignee_id TEXT,
  staff_unread INTEGER NOT NULL DEFAULT 0,
  customer_unread INTEGER NOT NULL DEFAULT 0,
  customer_seen_at INTEGER,
  last_message_at INTEGER NOT NULL,
  last_message_preview TEXT,
  last_author TEXT, -- customer | staff
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX support_conversations_last ON support_conversations (status, last_message_at);
CREATE INDEX support_conversations_recent ON support_conversations (last_message_at);
CREATE INDEX support_conversations_visitor ON support_conversations (visitor_hash, last_message_at);
CREATE INDEX support_conversations_user ON support_conversations (user_id, last_message_at);
CREATE INDEX support_conversations_ip ON support_conversations (ip, created_at);

CREATE TABLE support_messages (
  id TEXT PRIMARY KEY, -- sm_<random>
  conversation_id TEXT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  author TEXT NOT NULL, -- customer | staff | note (internal, never shown to the customer)
  author_id TEXT,
  author_name TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX support_messages_conversation ON support_messages (conversation_id, created_at);

UPDATE roles SET permissions = json_insert(permissions, '$[#]', 'instance.support.manage')
  WHERE id = 'role_instance_admin' AND NOT EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value = 'instance.support.manage');
