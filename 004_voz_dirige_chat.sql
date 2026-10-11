-- =====================================================================
-- APP BANDA · Actualización 004
--   1. "Voz principal" y "Coros" se unifican en "Voz".
--   2. "Dirige" deja de ser un rol: es una marca sobre una Voz en cada día.
--   3. Nuevo instrumento "Percusión menor" (no requiere cambios en la BD).
--   4. Chat por evento (cada día de la agenda tiene su conversación).
--   5. Cifrado en compases por canción (estilo iReal Pro).
-- Ejecutar DESPUÉS de schema.sql, 002_agenda.sql y 003_partituras.sql:
--   Supabase → SQL Editor → New query → pegar todo → Run
-- No borra datos útiles. Se puede volver a ejecutar sin romper nada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ASIGNACIONES: columna "dirige" y migración de roles viejos
-- ---------------------------------------------------------------------
alter table public.asignaciones add column if not exists dirige boolean not null default false;

-- Si alguien tenía "dirige" y además "voz"/"coros" el mismo día, se marca su fila de voz y se borra el duplicado
update public.asignaciones v set dirige = true
where v.rol in ('voz','coros') and exists (
  select 1 from public.asignaciones d
  where d.setlist_id = v.setlist_id and d.perfil_id = v.perfil_id and d.rol = 'dirige');
delete from public.asignaciones d
where d.rol = 'dirige' and exists (
  select 1 from public.asignaciones v
  where v.setlist_id = d.setlist_id and v.perfil_id = d.perfil_id and v.rol in ('voz','coros'));
update public.asignaciones set rol = 'voz', dirige = true where rol = 'dirige';

-- "coros" → "voz" (si ya tenía "voz" ese día, se conserva una sola fila)
update public.asignaciones v set dirige = v.dirige or c.dirige
from public.asignaciones c
where v.rol = 'voz' and c.rol = 'coros' and c.setlist_id = v.setlist_id and c.perfil_id = v.perfil_id;
delete from public.asignaciones c
where c.rol = 'coros' and exists (
  select 1 from public.asignaciones v
  where v.setlist_id = c.setlist_id and v.perfil_id = c.perfil_id and v.rol = 'voz');
update public.asignaciones set rol = 'voz' where rol = 'coros';

-- Un miembro solo puede cambiar el estado/nota de SU asignación (ahora también protege "dirige")
create or replace function public.proteger_asignacion() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.es_admin() then
    new.setlist_id := old.setlist_id;
    new.perfil_id  := old.perfil_id;
    new.rol        := old.rol;
    new.dirige     := old.dirige;
  end if;
  if new.estado is distinct from old.estado then new.respondido_at := now(); end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 2. PERFILES, NOTAS Y PARTITURAS: "coros" → "voz"
-- ---------------------------------------------------------------------
update public.profiles   set instrumento = 'voz' where instrumento = 'coros';
update public.partituras set instrumento = 'voz' where instrumento = 'coros';

-- Notas: si la canción ya tiene nota de "voz", se le agrega al final la de "coros"
update public.notas_cancion v
set contenido = trim(both from coalesce(v.contenido, '') || E'\n\n— Coros —\n' || coalesce(c.contenido, ''))
from public.notas_cancion c
where v.instrumento = 'voz' and c.instrumento = 'coros' and c.cancion_id = v.cancion_id
  and coalesce(c.contenido, '') <> '';
delete from public.notas_cancion c
where c.instrumento = 'coros' and exists (
  select 1 from public.notas_cancion v where v.cancion_id = c.cancion_id and v.instrumento = 'voz');
update public.notas_cancion set instrumento = 'voz' where instrumento = 'coros';

-- ---------------------------------------------------------------------
-- 3. CHAT POR EVENTO
-- ---------------------------------------------------------------------
create table if not exists public.mensajes_evento (
  id          uuid primary key default gen_random_uuid(),
  setlist_id  uuid not null references public.setlists(id) on delete cascade,
  autor_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  texto       text not null check (char_length(trim(texto)) between 1 and 1000),
  created_at  timestamptz not null default now()
);
create index if not exists idx_mensajes_evento on public.mensajes_evento (setlist_id, created_at);

alter table public.mensajes_evento enable row level security;

-- Todos los aprobados leen y escriben; borra el autor o un admin
drop policy if exists "msg_ver"    on public.mensajes_evento;
drop policy if exists "msg_crear"  on public.mensajes_evento;
drop policy if exists "msg_borrar" on public.mensajes_evento;
create policy "msg_ver"    on public.mensajes_evento for select to authenticated using (public.es_aprobado());
create policy "msg_crear"  on public.mensajes_evento for insert to authenticated
  with check (public.es_aprobado() and autor_id = auth.uid());
create policy "msg_borrar" on public.mensajes_evento for delete to authenticated
  using (autor_id = auth.uid() or public.es_admin());

-- Tiempo real
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mensajes_evento'
  ) then
    alter publication supabase_realtime add table public.mensajes_evento;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. CIFRADO EN COMPASES (vacío = la app lo genera automático desde la letra)
-- ---------------------------------------------------------------------
alter table public.canciones add column if not exists cifrado text;
