-- 0024_adjustment_reasons: Required reason codes for scrap/damage/count adjustments.
create table if not exists adjustment_reasons (
  code text primary key,
  label_ar text not null,
  label_en text not null,
  category text not null check (category in ('scrap', 'damage', 'count_adjust', 'other')),
  created_at timestamptz not null default now()
);

alter table adjustment_reasons enable row level security;
alter table adjustment_reasons force row level security;

create policy adjustment_reasons_read_all on adjustment_reasons
  using (true)
  with check (true);

grant select on adjustment_reasons to authenticated;
revoke insert, update, delete, truncate, references, trigger on adjustment_reasons from authenticated;

-- Seed default reasons
insert into adjustment_reasons (code, label_ar, label_en, category) values
  ('damaged', 'تالف', 'Damaged', 'damage'),
  ('expired', 'منتهي الصلاحية', 'Expired', 'scrap'),
  ('lost', 'مفقود', 'Lost', 'scrap'),
  ('count_variance', '差異盘库', 'Count variance', 'count_adjust'),
  ('other', 'أخرى', 'Other', 'other')
on conflict (code) do nothing;
