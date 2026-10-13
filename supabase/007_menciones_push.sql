-- =====================================================================
-- APP ALABANZA · Actualización 007
--   1. Menciones (@persona, @todos, @voces, @musicos, @admins) en el chat del día
--   2. Indisponibilidad por fechas
--   3. Historial de canciones (última vez, veces en 90 días)
--   4. Metrónomo (columnas)
--   5. Notificaciones push (suscripciones y preferencias)
-- Ejecutar DESPUÉS de 004_voz_dirige_chat.sql:
--   Supabase → SQL Editor → New query → pegar todo → Run
-- Se puede volver a ejecutar sin romper nada.
-- =====================================================================

-- ===== MENCIONES =====
create table if not exists public.menciones (
  id uuid primary key default gen_random_uuid(),
  mensaje_id uuid not null references public.mensajes_evento(id) on delete cascade,
  perfil_id  uuid not null references public.profiles(id) on delete cascade,
  leido_at   timestamptz,
  created_at timestamptz not null default now(),
  unique (mensaje_id, perfil_id)
);
create index if not exists idx_menciones_perfil on public.menciones (perfil_id, leido_at);
alter table public.menciones enable row level security;
drop policy if exists "men_ver" on public.menciones;
drop policy if exists "men_leer" on public.menciones;
create policy "men_ver"  on public.menciones for select to authenticated using (perfil_id = auth.uid() or public.es_admin());
create policy "men_leer" on public.menciones for update to authenticated using (perfil_id = auth.uid()) with check (perfil_id = auth.uid());

create or replace function public.extraer_menciones() returns trigger
language plpgsql security definer set search_path = public as $$
declare g text;
begin
  insert into menciones (mensaje_id, perfil_id)
  select new.id, m[1]::uuid
  from regexp_matches(new.texto, '@\[[^\]]+\]\(([0-9a-f-]{36})\)', 'g') as m
  where exists (select 1 from profiles p where p.id = m[1]::uuid and p.estado = 'aprobado')
  on conflict do nothing;

  for g in select (regexp_matches(new.texto, '@\[(todos|voces|musicos|admins)\]\(grupo\)', 'g'))[1] loop
    insert into menciones (mensaje_id, perfil_id)
    select distinct new.id, a.perfil_id from asignaciones a
    where a.setlist_id = new.setlist_id
      and (g = 'todos' or (g = 'voces' and a.rol = 'voz') or (g = 'musicos' and a.rol <> 'voz'))
    union
    select new.id, p.id from profiles p where g = 'admins' and p.rol = 'admin' and p.estado = 'aprobado'
    on conflict do nothing;
  end loop;

  delete from menciones where mensaje_id = new.id and perfil_id = new.autor_id;
  return new;
end $$;

drop trigger if exists trg_menciones on public.mensajes_evento;
create trigger trg_menciones after insert on public.mensajes_evento
  for each row execute function public.extraer_menciones();

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='menciones') then
    alter publication supabase_realtime add table public.menciones;
  end if;
end $$;

-- ===== INDISPONIBILIDAD =====
create table if not exists public.indisponibilidad (
  id uuid primary key default gen_random_uuid(),
  perfil_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  desde date not null,
  hasta date not null,
  motivo text check (char_length(motivo) <= 120),
  created_at timestamptz not null default now(),
  check (hasta >= desde)
);
create index if not exists idx_indisp on public.indisponibilidad (perfil_id, desde, hasta);
alter table public.indisponibilidad enable row level security;
drop policy if exists "ind_ver" on public.indisponibilidad;
drop policy if exists "ind_mio" on public.indisponibilidad;
create policy "ind_ver" on public.indisponibilidad for select to authenticated using (public.es_aprobado());
create policy "ind_mio" on public.indisponibilidad for all to authenticated
  using (perfil_id = auth.uid() or public.es_admin())
  with check (perfil_id = auth.uid() or public.es_admin());

-- ===== HISTORIAL =====
create or replace view public.historial_canciones with (security_invoker = true) as
select si.cancion_id,
       max(s.fecha)                                          as ultima_vez,
       count(*) filter (where s.fecha >= current_date - 90)  as veces_90d,
       count(*)                                              as veces_total
from public.setlist_items si
join public.setlists s on s.id = si.setlist_id
where s.fecha <= current_date
group by si.cancion_id;

-- ===== METRÓNOMO =====
alter table public.canciones add column if not exists bpm smallint check (bpm between 30 and 260);
alter table public.canciones add column if not exists compas text default '4/4';
alter table public.en_vivo add column if not exists click_inicio timestamptz;
alter table public.en_vivo add column if not exists click_bpm smallint;
alter table public.en_vivo add column if not exists click_compas text;

create or replace function public.hora_servidor() returns timestamptz
language sql stable as $$ select now() $$;
grant execute on function public.hora_servidor() to authenticated;

-- ===== PUSH =====
create table if not exists public.push_suscripciones (
  id uuid primary key default gen_random_uuid(),
  perfil_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  dispositivo text,
  created_at timestamptz not null default now()
);
alter table public.push_suscripciones enable row level security;
drop policy if exists "push_mio" on public.push_suscripciones;
create policy "push_mio" on public.push_suscripciones for all to authenticated
  using (perfil_id = auth.uid()) with check (perfil_id = auth.uid());

alter table public.profiles add column if not exists notif jsonb not null
  default '{"asignacion":true,"recordatorio":true,"mencion":true,"en_vivo":true,"muro":false}';

create table if not exists public.push_enviados (
  clave text primary key,
  created_at timestamptz not null default now()
);
alter table public.push_enviados enable row level security;
