-- =====================================================================
-- APP BANDA · Script de base de datos para Supabase
-- Pegar completo en: Supabase → SQL Editor → New query → Run
-- Se puede volver a ejecutar sin romper nada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PERFILES (un registro por integrante)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  nombre      text not null default '',
  instrumento text,                       -- bateria, piano, guitarra, bajo, voz, coros...
  rol         text not null default 'miembro' check (rol in ('miembro','admin')),
  estado      text not null default 'pendiente' check (estado in ('pendiente','aprobado','bloqueado')),
  created_at  timestamptz not null default now()
);

-- Helpers de permisos (security definer para evitar recursión en RLS)
create or replace function public.es_aprobado() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and estado = 'aprobado');
$$;

create or replace function public.es_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and estado = 'aprobado' and rol = 'admin');
$$;

-- Crear perfil automáticamente al registrarse
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, nombre, instrumento)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'nombre', ''), split_part(new.email, '@', 1)),
    nullif(new.raw_user_meta_data->>'instrumento', '')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Un miembro no puede cambiarse su propio rol/estado/email.
-- (Desde el SQL Editor auth.uid() es null, así que ahí sí se permite.)
create or replace function public.proteger_perfil() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.es_admin() then
    new.rol    := old.rol;
    new.estado := old.estado;
    new.email  := old.email;
  end if;
  return new;
end $$;

drop trigger if exists trg_proteger_perfil on public.profiles;
create trigger trg_proteger_perfil
  before update on public.profiles
  for each row execute function public.proteger_perfil();

-- ---------------------------------------------------------------------
-- 2. MURO
-- ---------------------------------------------------------------------
create table if not exists public.publicaciones (
  id         uuid primary key default gen_random_uuid(),
  autor_id   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  tipo       text not null default 'frase' check (tipo in ('frase','imagen','video','comunicado')),
  titulo     text,
  contenido  text,
  media_url  text,   -- imagen subida al bucket "media"
  video_url  text,   -- link de YouTube / Google Drive
  fijada     boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_publicaciones_fecha on public.publicaciones (fijada desc, created_at desc);

create table if not exists public.comentarios (
  id             uuid primary key default gen_random_uuid(),
  publicacion_id uuid not null references public.publicaciones(id) on delete cascade,
  autor_id       uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  contenido      text not null check (length(trim(contenido)) > 0),
  created_at     timestamptz not null default now()
);
create index if not exists idx_comentarios_pub on public.comentarios (publicacion_id, created_at);

create table if not exists public.reacciones (
  publicacion_id uuid not null references public.publicaciones(id) on delete cascade,
  usuario_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  emoji          text not null,
  created_at     timestamptz not null default now(),
  primary key (publicacion_id, usuario_id, emoji)
);

-- ---------------------------------------------------------------------
-- 3. CANCIONES
-- ---------------------------------------------------------------------
create table if not exists public.canciones (
  id            uuid primary key default gen_random_uuid(),
  titulo        text not null,
  artista       text,
  tono_original text,          -- ej: C, D, Bb, F#m
  bpm           int,
  compas        text,          -- ej: 4/4, 6/8
  letra         text,          -- letra con acordes entre corchetes: [G]Letra de la [D]canción
  video_url     text,          -- referencia en YouTube
  creado_por    uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_canciones_titulo on public.canciones (lower(titulo));

-- Notas por instrumento (una por canción + instrumento, editable por el grupo)
create table if not exists public.notas_cancion (
  id          uuid primary key default gen_random_uuid(),
  cancion_id  uuid not null references public.canciones(id) on delete cascade,
  instrumento text not null,    -- general, bateria, piano, guitarra, bajo, voz, coros
  contenido   text not null default '',
  autor_id    uuid default auth.uid() references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now(),
  unique (cancion_id, instrumento)
);

-- Tono de cada canción para cada cantante (historial vivo)
create table if not exists public.tonos_cantante (
  id          uuid primary key default gen_random_uuid(),
  cancion_id  uuid not null references public.canciones(id) on delete cascade,
  cantante_id uuid not null references public.profiles(id) on delete cascade,
  tono        text not null,
  notas       text,
  updated_at  timestamptz not null default now(),
  unique (cancion_id, cantante_id)
);

-- ---------------------------------------------------------------------
-- 4. ENSAYOS / EVENTOS (SETLISTS)
-- ---------------------------------------------------------------------
create table if not exists public.setlists (
  id         uuid primary key default gen_random_uuid(),
  titulo     text not null,
  tipo       text not null default 'ensayo' check (tipo in ('ensayo','evento')),
  fecha      timestamptz not null,
  lugar      text,
  notas      text,
  creado_por uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_setlists_fecha on public.setlists (fecha desc);

create table if not exists public.setlist_items (
  id          uuid primary key default gen_random_uuid(),
  setlist_id  uuid not null references public.setlists(id) on delete cascade,
  cancion_id  uuid not null references public.canciones(id) on delete cascade,
  orden       int not null default 0,
  cantante_id uuid references public.profiles(id) on delete set null,
  tono        text,
  notas       text
);
create index if not exists idx_setlist_items on public.setlist_items (setlist_id, orden);

-- updated_at automático
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_canciones_upd on public.canciones;
create trigger trg_canciones_upd before update on public.canciones
  for each row execute function public.set_updated_at();
drop trigger if exists trg_notas_upd on public.notas_cancion;
create trigger trg_notas_upd before update on public.notas_cancion
  for each row execute function public.set_updated_at();
drop trigger if exists trg_tonos_upd on public.tonos_cantante;
create trigger trg_tonos_upd before update on public.tonos_cantante
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 5. SEGURIDAD (Row Level Security)
--    - Pendientes: solo ven su propio perfil.
--    - Aprobados: ven todo, comentan, reaccionan, editan notas por instrumento.
--    - Admins: publican en el muro, gestionan canciones, tonos, setlists y usuarios.
--    - Cada cantante puede registrar su propio tono.
-- ---------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.publicaciones  enable row level security;
alter table public.comentarios    enable row level security;
alter table public.reacciones     enable row level security;
alter table public.canciones      enable row level security;
alter table public.notas_cancion  enable row level security;
alter table public.tonos_cantante enable row level security;
alter table public.setlists       enable row level security;
alter table public.setlist_items  enable row level security;

-- profiles
drop policy if exists "perfiles_ver"        on public.profiles;
drop policy if exists "perfiles_editar"     on public.profiles;
drop policy if exists "perfiles_borrar"     on public.profiles;
create policy "perfiles_ver"    on public.profiles for select to authenticated
  using (id = auth.uid() or public.es_aprobado());
create policy "perfiles_editar" on public.profiles for update to authenticated
  using (id = auth.uid() or public.es_admin()) with check (id = auth.uid() or public.es_admin());
create policy "perfiles_borrar" on public.profiles for delete to authenticated
  using (public.es_admin());

-- publicaciones
drop policy if exists "pub_ver"   on public.publicaciones;
drop policy if exists "pub_admin" on public.publicaciones;
create policy "pub_ver"   on public.publicaciones for select to authenticated using (public.es_aprobado());
create policy "pub_admin" on public.publicaciones for all    to authenticated
  using (public.es_admin()) with check (public.es_admin());

-- comentarios
drop policy if exists "com_ver"     on public.comentarios;
drop policy if exists "com_crear"   on public.comentarios;
drop policy if exists "com_editar"  on public.comentarios;
drop policy if exists "com_borrar"  on public.comentarios;
create policy "com_ver"    on public.comentarios for select to authenticated using (public.es_aprobado());
create policy "com_crear"  on public.comentarios for insert to authenticated
  with check (public.es_aprobado() and autor_id = auth.uid());
create policy "com_editar" on public.comentarios for update to authenticated
  using (autor_id = auth.uid()) with check (autor_id = auth.uid());
create policy "com_borrar" on public.comentarios for delete to authenticated
  using (autor_id = auth.uid() or public.es_admin());

-- reacciones
drop policy if exists "reac_ver"    on public.reacciones;
drop policy if exists "reac_crear"  on public.reacciones;
drop policy if exists "reac_borrar" on public.reacciones;
create policy "reac_ver"    on public.reacciones for select to authenticated using (public.es_aprobado());
create policy "reac_crear"  on public.reacciones for insert to authenticated
  with check (public.es_aprobado() and usuario_id = auth.uid());
create policy "reac_borrar" on public.reacciones for delete to authenticated
  using (usuario_id = auth.uid());

-- canciones
drop policy if exists "can_ver"   on public.canciones;
drop policy if exists "can_admin" on public.canciones;
create policy "can_ver"   on public.canciones for select to authenticated using (public.es_aprobado());
create policy "can_admin" on public.canciones for all    to authenticated
  using (public.es_admin()) with check (public.es_admin());

-- notas por instrumento
drop policy if exists "notas_ver"    on public.notas_cancion;
drop policy if exists "notas_crear"  on public.notas_cancion;
drop policy if exists "notas_editar" on public.notas_cancion;
drop policy if exists "notas_borrar" on public.notas_cancion;
create policy "notas_ver"    on public.notas_cancion for select to authenticated using (public.es_aprobado());
create policy "notas_crear"  on public.notas_cancion for insert to authenticated with check (public.es_aprobado());
create policy "notas_editar" on public.notas_cancion for update to authenticated
  using (public.es_aprobado()) with check (public.es_aprobado());
create policy "notas_borrar" on public.notas_cancion for delete to authenticated
  using (autor_id = auth.uid() or public.es_admin());

-- tonos por cantante
drop policy if exists "tonos_ver"      on public.tonos_cantante;
drop policy if exists "tonos_escribir" on public.tonos_cantante;
create policy "tonos_ver"      on public.tonos_cantante for select to authenticated using (public.es_aprobado());
create policy "tonos_escribir" on public.tonos_cantante for all    to authenticated
  using (public.es_admin() or (public.es_aprobado() and cantante_id = auth.uid()))
  with check (public.es_admin() or (public.es_aprobado() and cantante_id = auth.uid()));

-- setlists
drop policy if exists "set_ver"   on public.setlists;
drop policy if exists "set_admin" on public.setlists;
create policy "set_ver"   on public.setlists for select to authenticated using (public.es_aprobado());
create policy "set_admin" on public.setlists for all    to authenticated
  using (public.es_admin()) with check (public.es_admin());

drop policy if exists "item_ver"   on public.setlist_items;
drop policy if exists "item_admin" on public.setlist_items;
create policy "item_ver"   on public.setlist_items for select to authenticated using (public.es_aprobado());
create policy "item_admin" on public.setlist_items for all    to authenticated
  using (public.es_admin()) with check (public.es_admin());

-- ---------------------------------------------------------------------
-- 6. ALMACENAMIENTO DE IMÁGENES (bucket "media", máx 10 MB, solo imágenes)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 10485760, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "media_subir"  on storage.objects;
drop policy if exists "media_borrar" on storage.objects;
create policy "media_subir"  on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.es_admin());
create policy "media_borrar" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public.es_admin());

-- ---------------------------------------------------------------------
-- 7. TIEMPO REAL (el muro se actualiza solo)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['publicaciones','comentarios','reacciones'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- =====================================================================
-- 8. PRIMER ADMINISTRADOR
-- Después de registrarte en la app, ejecutá SOLO esta línea
-- (en una query nueva) cambiando el correo por el tuyo:
--
-- update public.profiles set rol = 'admin', estado = 'aprobado' where email = 'tu-correo@ejemplo.com';
--
-- Los siguientes admins y aprobaciones se hacen desde la misma app.
-- =====================================================================
