-- =====================================================================
-- APP BANDA · Actualización 002: Agenda, equipo por día y modo en vivo
-- Ejecutar DESPUÉS de schema.sql:
--   Supabase → SQL Editor → New query → pegar todo → Run
-- No borra datos. Se puede volver a ejecutar sin romper nada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TIPOS DE DÍA (horarios predeterminados, editables por admins)
-- ---------------------------------------------------------------------
create table if not exists public.tipos_evento (
  id                uuid primary key default gen_random_uuid(),
  nombre            text not null,
  emoji             text not null default '📅',
  color             text not null default '#e0b458',
  recurrente        boolean not null default false,               -- se crea con "Generar mes"
  dia_semana        int check (dia_semana between 0 and 6),       -- 0=domingo … 6=sábado
  hora              time,
  ensayo_dia_semana int check (ensayo_dia_semana between 0 and 6),-- null + ensayo_hora = mismo día
  ensayo_hora       time,
  orden             int not null default 0,
  created_at        timestamptz not null default now()
);

insert into public.tipos_evento (nombre, emoji, color, recurrente, dia_semana, hora, ensayo_dia_semana, ensayo_hora, orden)
select * from (values
  ('Estudio bíblico',    '📖', '#6ba8ef', true,  3,    time '20:00', null::int, time '18:30', 1),
  ('Servicio dominical', '⛪', '#e0b458', true,  0,    time '10:30', null::int, null::time,   2),
  ('Actividad especial', '⭐', '#c58af0', false, null, null::time,   null::int, null::time,   3),
  ('Ensayo',             '🎹', '#4fc38a', false, null, null::time,   null::int, null::time,   4)
) as v(nombre, emoji, color, recurrente, dia_semana, hora, ensayo_dia_semana, ensayo_hora, orden)
where not exists (select 1 from public.tipos_evento);

-- ---------------------------------------------------------------------
-- 2. DÍAS (se reutiliza la tabla setlists): tipo y fecha de ensayo
-- ---------------------------------------------------------------------
alter table public.setlists add column if not exists tipo_evento_id uuid references public.tipos_evento(id) on delete set null;
alter table public.setlists add column if not exists ensayo_fecha   timestamptz;
create index if not exists idx_setlists_ensayo on public.setlists (ensayo_fecha);

-- Asignar tipo a los registros que ya existían
update public.setlists s set tipo_evento_id = t.id
from public.tipos_evento t
where s.tipo_evento_id is null
  and t.nombre = case when s.tipo = 'ensayo' then 'Ensayo' else 'Actividad especial' end;

-- ---------------------------------------------------------------------
-- 3. EQUIPO DEL DÍA (quién sirve, en qué rol, y si confirmó)
-- ---------------------------------------------------------------------
create table if not exists public.asignaciones (
  id            uuid primary key default gen_random_uuid(),
  setlist_id    uuid not null references public.setlists(id) on delete cascade,
  perfil_id     uuid not null references public.profiles(id) on delete cascade,
  rol           text not null,   -- dirige, voz, coros, piano, guitarra, guitarra_electrica, bajo, bateria, otro
  estado        text not null default 'pendiente' check (estado in ('pendiente','confirmado','rechazado')),
  nota          text,
  respondido_at timestamptz,
  created_at    timestamptz not null default now(),
  unique (setlist_id, perfil_id, rol)
);
create index if not exists idx_asignaciones_perfil on public.asignaciones (perfil_id);

-- Un miembro solo puede cambiar el estado/nota de SU asignación
create or replace function public.proteger_asignacion() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.es_admin() then
    new.setlist_id := old.setlist_id;
    new.perfil_id  := old.perfil_id;
    new.rol        := old.rol;
  end if;
  if new.estado is distinct from old.estado then new.respondido_at := now(); end if;
  return new;
end $$;

drop trigger if exists trg_proteger_asignacion on public.asignaciones;
create trigger trg_proteger_asignacion
  before update on public.asignaciones
  for each row execute function public.proteger_asignacion();

-- ---------------------------------------------------------------------
-- 4. MODO EN VIVO (qué canción se está viendo en el ensayo/servicio)
-- ---------------------------------------------------------------------
create table if not exists public.en_vivo (
  setlist_id      uuid primary key references public.setlists(id) on delete cascade,
  indice          int not null default 0,
  cancion_id      uuid references public.canciones(id) on delete set null,
  tono            text,
  activo          boolean not null default true,
  actualizado_por uuid references public.profiles(id) on delete set null,
  updated_at      timestamptz not null default now()
);

drop trigger if exists trg_en_vivo_upd on public.en_vivo;
create trigger trg_en_vivo_upd before update on public.en_vivo
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 5. MURO: publicaciones tipo "programa" enlazadas a un día
-- ---------------------------------------------------------------------
alter table public.publicaciones add column if not exists setlist_id uuid references public.setlists(id) on delete set null;
alter table public.publicaciones drop constraint if exists publicaciones_tipo_check;
alter table public.publicaciones add constraint publicaciones_tipo_check
  check (tipo in ('frase','imagen','video','comunicado','programa'));

-- ---------------------------------------------------------------------
-- 6. SEGURIDAD
-- ---------------------------------------------------------------------
alter table public.tipos_evento enable row level security;
alter table public.asignaciones enable row level security;
alter table public.en_vivo      enable row level security;

drop policy if exists "tipos_ver"   on public.tipos_evento;
drop policy if exists "tipos_admin" on public.tipos_evento;
create policy "tipos_ver"   on public.tipos_evento for select to authenticated using (public.es_aprobado());
create policy "tipos_admin" on public.tipos_evento for all    to authenticated
  using (public.es_admin()) with check (public.es_admin());

drop policy if exists "asig_ver"        on public.asignaciones;
drop policy if exists "asig_crear"      on public.asignaciones;
drop policy if exists "asig_responder"  on public.asignaciones;
drop policy if exists "asig_borrar"     on public.asignaciones;
create policy "asig_ver"       on public.asignaciones for select to authenticated using (public.es_aprobado());
create policy "asig_crear"     on public.asignaciones for insert to authenticated with check (public.es_admin());
create policy "asig_responder" on public.asignaciones for update to authenticated
  using (public.es_admin() or (public.es_aprobado() and perfil_id = auth.uid()))
  with check (public.es_admin() or (public.es_aprobado() and perfil_id = auth.uid()));
create policy "asig_borrar"    on public.asignaciones for delete to authenticated using (public.es_admin());

drop policy if exists "vivo_ver"   on public.en_vivo;
drop policy if exists "vivo_admin" on public.en_vivo;
create policy "vivo_ver"   on public.en_vivo for select to authenticated using (public.es_aprobado());
create policy "vivo_admin" on public.en_vivo for all    to authenticated
  using (public.es_admin()) with check (public.es_admin());

-- ---------------------------------------------------------------------
-- 7. TIEMPO REAL
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['en_vivo','asignaciones'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
