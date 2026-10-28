-- A per-user language preference.
--
-- NULL means "follow the browser": the app detects English/Arabic from the
-- request's Accept-Language. 'ar' or 'en' means that language for that user on
-- every device, regardless of the browser. The running app resolves the
-- preference at sign-in into a `lang` cookie (the transport), and the language
-- toggle both writes this column AND sets the cookie.
alter table app_users
  add column preferred_lang text
  constraint app_users_preferred_lang_check check (preferred_lang is null or preferred_lang in ('ar', 'en'));