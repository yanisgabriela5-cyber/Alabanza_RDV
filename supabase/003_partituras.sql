-- =====================================================================
-- APP BANDA · Actualización 003: Partituras por canción e instrumento
-- Ejecutar DESPUÉS de schema.sql y 002_agenda.sql:
--   Supabase → SQL Editor → New query → pegar todo → Run
-- No borra datos. Se puede volver a ejecutar sin romper nada.
-- =====================================================================

create table if not exists public.partituras (
  id          uuid primary key default gen_random_uuid(),
  cancion_id  uuid not null references public.canciones(id) on delete cascade,
  instrumento text not null default 'bateria',
  titulo      text,
  tipo        text not null check (tipo in ('imagen','pdf','link')),
  url         text not null,
  ruta        text,              -- ruta en el bucket "partituras" (null si es link externo)
  subido_por  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists idx_partituras_cancion on public.partituras (cancion_id);

alter table public.partituras enable row level security;

-- Todos los aprobados ven y suben; borra quien la subió o un admin
drop policy if exists "part_ver"    on public.partituras;
drop policy if exists "part_subir"  on public.partituras;
drop policy if exists "part_borrar" on public.partituras;
create policy "part_ver"    on public.partituras for select to authenticated using (public.es_aprobado());
create policy "part_subir"  on public.partituras for insert to authenticated
  with check (public.es_aprobado() and subido_por = auth.uid());
create policy "part_borrar" on public.partituras for delete to authenticated
  using (subido_por = auth.uid() or public.es_admin());

-- Bucket para archivos (fotos y PDF, máx 15 MB)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('partituras', 'partituras', true, 15728640,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Cada usuario sube dentro de su propia carpeta: partituras/<su-id>/archivo
drop policy if exists "part_archivo_subir"  on storage.objects;
drop policy if exists "part_archivo_borrar" on storage.objects;
create policy "part_archivo_subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'partituras' and public.es_aprobado()
              and (storage.foldername(name))[1] = auth.uid()::text);
create policy "part_archivo_borrar" on storage.objects for delete to authenticated
  using (bucket_id = 'partituras'
         and ((storage.foldername(name))[1] = auth.uid()::text or public.es_admin()));
