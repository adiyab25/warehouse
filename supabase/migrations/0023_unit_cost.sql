-- 0023_unit_cost: Add integer piastre cost to variants and snapshot on movements.
alter table item_variants add column if not exists unit_cost_piastres int not null default 0;

alter table stock_movements add column if not exists unit_cost_piastres int not null default 0;
