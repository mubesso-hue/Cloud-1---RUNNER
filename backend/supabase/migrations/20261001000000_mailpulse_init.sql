-- MailPulse: tracked emails + open/click events.
-- RLS is enabled with no policies, so only the Edge Function (service role) can read/write.

create table if not exists public.mp_emails (
  id              text primary key,             -- random, unguessable tracking id
  account         text,                         -- the Gmail address that sent it
  subject         text,
  recipients      jsonb not null default '[]',  -- [{ "email": "...", "name": "..." }]
  links           jsonb not null default '[]',  -- original URLs, index = link number in /c/:id/:n
  sent_at         timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  thread_id       text,                         -- Gmail thread id (filled by reply detection)
  replied_at      timestamptz,
  reply_from      text,
  status          text not null default 'active' check (status in ('active', 'done', 'archived')),
  follow_up_at    timestamptz,                  -- snooze / reminder date
  notes           text,
  suppress_until  timestamptz                   -- opens before this are the sender viewing their own mail
);

create index if not exists mp_emails_sent_at_idx on public.mp_emails (sent_at desc);

create table if not exists public.mp_events (
  id          bigserial primary key,
  email_id    text not null references public.mp_emails (id) on delete cascade,
  kind        text not null check (kind in ('open', 'click')),
  link_index  int,
  url         text,
  created_at  timestamptz not null default now(),
  user_agent  text,
  client      text,             -- best-effort guess: Gmail, Apple Mail, Outlook, ...
  counted     boolean not null default true,
  reason      text              -- why an event was not counted: grace, self, duplicate
);

create index if not exists mp_events_email_idx on public.mp_events (email_id, created_at desc);

alter table public.mp_emails enable row level security;
alter table public.mp_events enable row level security;
