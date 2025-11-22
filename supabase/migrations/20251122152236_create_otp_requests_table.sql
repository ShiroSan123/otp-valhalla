create table if not exists public.otp_requests (
    request_id uuid primary key,
    phone text not null,
    provider text not null,
    status text not null default 'pending',
    code text,
    qr_payload text,
    qr_data_url text,
    expires_at timestamptz,
    verified_at timestamptz,
    created_at timestamptz not null default timezone('utc', now()),
    metadata jsonb not null default '{}'::jsonb
);

alter table public.otp_requests enable row level security;

create policy if not exists "otp_requests_service_select" on public.otp_requests
    for select using (auth.role() = 'service_role');

create policy if not exists "otp_requests_service_mutation" on public.otp_requests
    for all using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

create index if not exists otp_requests_phone_idx on public.otp_requests (phone);
create index if not exists otp_requests_created_idx on public.otp_requests (created_at desc);
