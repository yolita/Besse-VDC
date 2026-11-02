create table if not exists public.households (
  id text primary key,
  created_at timestamptz not null,
  surname text not null default '',
  first_name text not null default '',
  initials text not null default '',
  date_of_birth text not null default '',
  phone text not null default '',
  id_number text not null default '',
  site_address text not null default '',
  plot_number text not null default '',
  property_type text not null default '',
  alternate_contact_name text not null default '',
  alternate_contact_phone text not null default '',
  area text not null default '',
  house_number text not null default '',
  street text not null default '',
  supply_plot text not null default '',
  record jsonb not null default '{}'::jsonb
);

alter table public.households
  add column if not exists surname text not null default '',
  add column if not exists first_name text not null default '',
  add column if not exists initials text not null default '',
  add column if not exists date_of_birth text not null default '',
  add column if not exists phone text not null default '',
  add column if not exists id_number text not null default '',
  add column if not exists site_address text not null default '',
  add column if not exists plot_number text not null default '',
  add column if not exists property_type text not null default '',
  add column if not exists alternate_contact_name text not null default '',
  add column if not exists alternate_contact_phone text not null default '',
  add column if not exists area text not null default '',
  add column if not exists house_number text not null default '',
  add column if not exists street text not null default '',
  add column if not exists supply_plot text not null default '',
  add column if not exists record jsonb not null default '{}'::jsonb;

create table if not exists public.applications (
  id text primary key,
  household_id text references public.households (id),
  application_number text not null unique,
  status text not null check (status in ('Pending', 'Approved', 'Rejected')),
  created_at timestamptz not null,
  record jsonb not null
);

alter table public.applications
  add column if not exists household_id text references public.households (id);

create table if not exists public.readings (
  id text primary key,
  application_id text not null references public.applications (id),
  date date not null,
  reading_month date generated always as (date_trunc('month', date::timestamp)::date) stored,
  created_at timestamptz not null,
  record jsonb not null
);

create table if not exists public.payments (
  id text primary key,
  application_id text not null references public.applications (id),
  date date not null,
  created_at timestamptz not null,
  record jsonb not null
);

create table if not exists public.invoices (
  id text primary key references public.readings (id) on delete restrict,
  application_id text not null references public.applications (id),
  invoice_number text not null unique,
  date date not null,
  amount numeric(12, 2) not null check (amount >= 0),
  created_at timestamptz not null,
  record jsonb not null
);

alter table public.payments
  add column if not exists invoice_id text;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'readings' and column_name = 'customer_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'readings' and column_name = 'application_id'
  ) then
    alter table public.readings rename column customer_id to application_id;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payments' and column_name = 'customer_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payments' and column_name = 'application_id'
  ) then
    alter table public.payments rename column customer_id to application_id;
  end if;
end $$;

alter table public.readings
  add column if not exists reading_month date generated always as (date_trunc('month', date::timestamp)::date) stored;

do $$
begin
  if exists (
    select 1
    from public.readings
    group by application_id, reading_month
    having count(*) > 1
  ) then
    raise exception 'Duplicate meter readings exist for the same application and month. Resolve these duplicates before applying the monthly reading limit.';
  end if;
end $$;

create unique index if not exists readings_one_per_meter_month_idx
  on public.readings (application_id, reading_month);

insert into public.households (id, created_at, record)
select
  id,
  created_at,
  record - array[
    'applicationNumber', 'status', 'connectionType', 'meterSize', 'purposes',
    'purposeOther', 'documents', 'connectionFee', 'connectionReceipt',
    'meterNumber', 'initialReading', 'approvedDate', 'approverName', 'rejectedDate',
    'householdId'
  ]::text[]
from public.applications
where household_id is null
  and record ? 'firstName'
  and not exists (
    select 1 from public.households where households.id = applications.id
  );

update public.households
set
  surname = coalesce(nullif(surname, ''), record ->> 'surname', ''),
  first_name = coalesce(nullif(first_name, ''), record ->> 'firstName', ''),
  initials = coalesce(nullif(initials, ''), record ->> 'initials', ''),
  date_of_birth = coalesce(nullif(date_of_birth, ''), record ->> 'dob', ''),
  phone = coalesce(nullif(phone, ''), record ->> 'phone', ''),
  id_number = coalesce(nullif(id_number, ''), record ->> 'idNumber', ''),
  site_address = coalesce(nullif(site_address, ''), record ->> 'siteAddress', ''),
  plot_number = coalesce(nullif(plot_number, ''), record ->> 'plotNumber', ''),
  property_type = coalesce(nullif(property_type, ''), record ->> 'propertyType', ''),
  alternate_contact_name = coalesce(nullif(alternate_contact_name, ''), record ->> 'altName', ''),
  alternate_contact_phone = coalesce(nullif(alternate_contact_phone, ''), record ->> 'altPhone', ''),
  area = coalesce(nullif(area, ''), record ->> 'area', ''),
  house_number = coalesce(nullif(house_number, ''), record ->> 'houseNumber', ''),
  street = coalesce(nullif(street, ''), record ->> 'street', ''),
  supply_plot = coalesce(nullif(supply_plot, ''), record ->> 'supplyPlot', '');

update public.applications
set household_id = id
where household_id is null;

update public.applications
set record = jsonb_set(
  record - array[
    'surname', 'firstName', 'initials', 'dob', 'phone', 'idNumber',
    'siteAddress', 'plotNumber', 'propertyType', 'altName', 'altPhone',
    'area', 'houseNumber', 'street', 'supplyPlot'
  ]::text[],
  '{householdId}',
  to_jsonb(household_id),
  true
)
where record ? 'firstName';

alter table public.applications alter column household_id set not null;

create index if not exists applications_household_id_idx on public.applications (household_id);
create index if not exists readings_application_date_idx on public.readings (application_id, date);
create index if not exists invoices_application_date_idx on public.invoices (application_id, date);
create unique index if not exists invoices_id_application_idx on public.invoices (id, application_id);
create index if not exists payments_application_date_idx on public.payments (application_id, date);
create index if not exists payments_invoice_id_idx on public.payments (invoice_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payments_invoice_application_fk'
      and conrelid = 'public.payments'::regclass
  ) then
    alter table public.payments
      add constraint payments_invoice_application_fk
      foreign key (invoice_id, application_id)
      references public.invoices (id, application_id);
  end if;
end $$;

insert into public.invoices (id, application_id, invoice_number, date, amount, created_at, record)
select
  readings.id,
  readings.application_id,
  'INV-' || to_char(readings.date, 'YYYYMM') || '-' || upper(replace(readings.id, '-', '')),
  readings.date,
  coalesce(nullif(readings.record ->> 'charge', '')::numeric, 0),
  readings.created_at,
  jsonb_build_object(
    'id', readings.id,
    'readingId', readings.id,
    'invoiceNumber', 'INV-' || to_char(readings.date, 'YYYYMM') || '-' || upper(replace(readings.id, '-', '')),
    'customerId', readings.application_id,
    'date', readings.date,
    'amount', coalesce(nullif(readings.record ->> 'charge', '')::numeric, 0),
    'createdAt', readings.created_at
  )
from public.readings
on conflict (id) do nothing;

create or replace function public.sync_reading_invoice()
returns trigger
language plpgsql
as $$
declare
  generated_invoice_number text;
  invoice_amount numeric(12, 2);
  invoice_record jsonb;
begin
  generated_invoice_number :=
    'INV-' || to_char(new.date, 'YYYYMM') || '-' || upper(replace(new.id, '-', ''));
  invoice_amount := coalesce(nullif(new.record ->> 'charge', '')::numeric, 0);
  invoice_record := jsonb_build_object(
    'id', new.id,
    'readingId', new.id,
    'invoiceNumber', generated_invoice_number,
    'customerId', new.application_id,
    'date', new.date,
    'amount', invoice_amount,
    'createdAt', new.created_at
  );

  insert into public.invoices (id, application_id, invoice_number, date, amount, created_at, record)
  values (new.id, new.application_id, generated_invoice_number, new.date, invoice_amount, new.created_at, invoice_record)
  on conflict (id) do update
  set application_id = excluded.application_id,
      invoice_number = excluded.invoice_number,
      date = excluded.date,
      amount = excluded.amount,
      created_at = excluded.created_at,
      record = excluded.record;
  return new;
end;
$$;

drop trigger if exists readings_sync_invoice on public.readings;
create trigger readings_sync_invoice
  after insert or update on public.readings
  for each row execute function public.sync_reading_invoice();

create table if not exists public.workspace_settings (
  id smallint primary key check (id = 1),
  tariff numeric(12, 2) not null check (tariff >= 0),
  chairperson_name text not null default ''
);

alter table public.workspace_settings
  add column if not exists chairperson_name text not null default '';

create table if not exists public.workspace_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.households enable row level security;
alter table public.applications enable row level security;
alter table public.readings enable row level security;
alter table public.invoices enable row level security;
alter table public.payments enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.workspace_members enable row level security;

drop policy if exists "Users can view own membership" on public.workspace_members;
create policy "Users can view own membership"
  on public.workspace_members for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Workspace members access" on public.households;
create policy "Workspace members access"
  on public.households for all to authenticated
  using (exists (select 1 from public.workspace_members where user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members where user_id = auth.uid()));

drop policy if exists "Authenticated workspace access" on public.applications;
drop policy if exists "Workspace members access" on public.applications;
create policy "Workspace members access"
  on public.applications for all to authenticated
  using (exists (select 1 from public.workspace_members where user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members where user_id = auth.uid()));

drop policy if exists "Authenticated workspace access" on public.readings;
drop policy if exists "Workspace members access" on public.readings;
create policy "Workspace members access"
  on public.readings for all to authenticated
  using (exists (select 1 from public.workspace_members where user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members where user_id = auth.uid()));

drop policy if exists "Workspace members access" on public.invoices;
create policy "Workspace members access"
  on public.invoices for all to authenticated
  using (exists (select 1 from public.workspace_members where user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members where user_id = auth.uid()));

drop policy if exists "Authenticated workspace access" on public.payments;
drop policy if exists "Workspace members access" on public.payments;
create policy "Workspace members access"
  on public.payments for all to authenticated
  using (exists (select 1 from public.workspace_members where user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members where user_id = auth.uid()));

drop policy if exists "Authenticated workspace access" on public.workspace_settings;
drop policy if exists "Workspace members access" on public.workspace_settings;
create policy "Workspace members access"
  on public.workspace_settings for all to authenticated
  using (exists (select 1 from public.workspace_members where user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members where user_id = auth.uid()));

revoke all on public.households, public.applications, public.readings, public.invoices, public.payments,
  public.workspace_settings, public.workspace_members from anon;
grant select, insert, update, delete on public.households, public.applications,
  public.readings, public.invoices, public.payments, public.workspace_settings to authenticated;
grant select on public.workspace_members to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-receipts',
  'payment-receipts',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Workspace members can view payment receipts" on storage.objects;
create policy "Workspace members can view payment receipts"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'payment-receipts'
    and exists (select 1 from public.workspace_members where user_id = auth.uid())
  );

drop policy if exists "Workspace members can upload payment receipts" on storage.objects;
create policy "Workspace members can upload payment receipts"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'payment-receipts'
    and exists (select 1 from public.workspace_members where user_id = auth.uid())
  );

drop policy if exists "Workspace members can delete payment receipts" on storage.objects;
create policy "Workspace members can delete payment receipts"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'payment-receipts'
    and exists (select 1 from public.workspace_members where user_id = auth.uid())
  );
