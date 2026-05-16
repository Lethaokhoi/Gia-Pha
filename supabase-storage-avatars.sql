-- Ảnh thành viên: upload lên Supabase Storage (chạy 1 lần trong SQL Editor)
-- Sau đó: Storage → gp-avatars → Public bucket (đã bật trong script)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'gp-avatars',
  'gp-avatars',
  true,
  3145728,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "gp_avatars_select" on storage.objects;
create policy "gp_avatars_select" on storage.objects
  for select using (bucket_id = 'gp-avatars');

drop policy if exists "gp_avatars_insert" on storage.objects;
create policy "gp_avatars_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'gp-avatars'
    and coalesce(array_length(storage.foldername(name), 1), 0) >= 2
    and public.gp_is_family_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "gp_avatars_update" on storage.objects;
create policy "gp_avatars_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'gp-avatars'
    and public.gp_is_family_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "gp_avatars_delete" on storage.objects;
create policy "gp_avatars_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'gp-avatars'
    and public.gp_is_family_member(((storage.foldername(name))[1])::uuid)
  );
