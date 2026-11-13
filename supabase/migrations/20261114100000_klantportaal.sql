-- Klantportaal: medewerkers en klanten in dezelfde app.
--
-- Een klantportaal heeft geen deur van Cloudflare op het domein. Iedereen kan de inlogpagina
-- openen en per mail een account maken. De regels in de database zijn dan de enige grens,
-- en daarvoor geldt één regel (docs/WERKWIJZE.md): een recht hangt nooit aan iets wat een
-- klant zelf kan claimen.
--
-- Wat een klant zelf kan claimen, en waar dus nooit een recht aan mag hangen:
--   * een e-mailadres. Wie bij de mailbox van een medewerker kan, logt per mail in op het
--     account van die medewerker: Supabase kent één account per adres, hoe je ook inlogt.
--     Zo'n mailsessie heeft dus hetzelfde `auth.uid()` als de medewerker zelf.
--   * `user_metadata` in het token: dat past een gebruiker zelf aan.
--   * `app_metadata.provider` en `providers`: die zeggen hoe het account ooit is gemaakt en
--     welke inlogmanieren eraan hangen, niet hoe déze sessie is begonnen.
--
-- Waar deze functie wel op vertrouwt, en waarom:
--   1. `amr` in het token. Supabase Auth schrijft bij het begin van elke sessie op hoe er is
--      ingelogd (`oauth` via een inlogdienst zoals Cloudflare, `otp` of `magiclink` per mail,
--      `password` met een wachtwoord) en zet dat in elk token van die sessie, ook na
--      verversen. Het token is ondertekend door Supabase; de gebruiker kan het niet wijzigen.
--      Een mailsessie krijgt nooit `oauth`: alleen de terugkeer van een inlogdienst zet dat.
--   2. De sessie bestaat nog (`auth.sessions`). Na uitloggen is het recht meteen weg, ook al
--      is het token zelf nog een uur geldig.
--   3. Het account hangt aan Cloudflare (`auth.identities`) en aan geen andere inlogdienst.
--      `amr` zegt "via een inlogdienst", niet welke. Zolang Cloudflare de enige is (zo zet de
--      inrichting het), is dat dus Cloudflare. Hangt er ooit een tweede dienst aan het
--      account, dan zegt deze functie nee, in plaats van te gokken.
--
--   4. De inlog via Cloudflare is niet ouder dan twaalf uur. Een sessie van Supabase blijft
--      anders weken leven, ook als de medewerker intussen bij Cloudflare is afgesloten. De
--      tijd komt uit `auth.sessions.created_at`: dat schrijft Supabase bij het inloggen en
--      verandert niet bij het verversen van het token; de gebruiker kan er niet bij. Na
--      twaalf uur is de sessie nog gewoon ingelogd, maar zonder medewerkerrechten, tot de
--      medewerker opnieuw via de knop voor medewerkers inlogt.
--      De duur staat op één plek: `medewerkersessie_geldig` hieronder.
--   5. Het account is niet geblokkeerd (`auth.users.banned_until`). Een geblokkeerd account
--      kan geen nieuw token krijgen, maar een lopend token blijft tot een uur geldig; zo is
--      het recht ook met dat token meteen weg.
--
-- Voorwaarde: zet in Supabase geen andere inlogdienst (Google, Microsoft) rechtstreeks aan
-- naast Cloudflare. Wie dat toch wil, moet deze functie eerst herzien.
create function public.sessie_via_cloudflare()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- Zo lang geeft een inlog via Cloudflare medewerkerrechten. De enige plek waar dit staat.
  with instelling as (select interval '12 hours' as medewerkersessie_geldig)
  select
    exists (
      select 1
        from jsonb_array_elements(
               case when jsonb_typeof(auth.jwt() -> 'amr') = 'array'
                    then auth.jwt() -> 'amr'
                    else '[]'::jsonb
               end
             ) as stap
       where stap ->> 'method' = 'oauth'
    )
    and exists (
      select 1
        from auth.sessions s, instelling
       where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
         and s.user_id = auth.uid()
         and s.created_at > now() - instelling.medewerkersessie_geldig
    )
    and exists (
      select 1
        from auth.identities i
       where i.user_id = auth.uid()
         and i.provider = 'custom:cloudflare'
    )
    and not exists (
      select 1
        from auth.identities i
       where i.user_id = auth.uid()
         and i.provider not in ('custom:cloudflare', 'email')
    )
    and not exists (
      select 1
        from auth.users u
       where u.id = auth.uid()
         and u.banned_until > now()
    )
$$;

comment on function public.sessie_via_cloudflare() is
  'Is de huidige sessie via Cloudflare begonnen, hoogstens twaalf uur geleden? Per mail of met een wachtwoord: nee, ook op het adres van een medewerker.';

-- Wie via Cloudflare binnenkomt, is medewerker: Cloudflare laat alleen de groepen uit
-- toegang.json door. Kent de app soorten medewerkers (beheerder, verkoop), maak dan een
-- eigen lijst en eis hier beide: op de lijst én een sessie via Cloudflare.
create function public.is_medewerker()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.sessie_via_cloudflare()
$$;

comment on function public.is_medewerker() is
  'Medewerkerrechten: alleen in een sessie via Cloudflare. Gebruik deze functie in policies, nooit een e-mailadres of auth.uid().';

-- "Een klant mag niets tot een medewerker hem goedkeurt." Iedereen kan per mail een account
-- maken, dus een account alleen is geen recht. Een klant meldt zich aan met
-- `klant_aanmelden()`; een medewerker ziet de lijst en zet `goedgekeurd`. Of hij is
-- goedgekeurd, hoort de klant van `is_goedgekeurde_klant()`: de tabel zelf ziet alleen een
-- medewerker. Gebruik in de policies van de eigen tabellen `public.is_medewerker()` en
-- `public.is_goedgekeurde_klant()` als harde eis; met `"klantportaal": true` in
-- stack.config.json dwingt `pnpm guard:rls` dat af (docs/WERKWIJZE.md).
create table public.klanten (
  user_id uuid primary key references auth.users (id) on delete cascade,
  e_mail text not null,
  goedgekeurd boolean not null default false,
  aangemeld_op timestamptz not null default now()
);

comment on table public.klanten is
  'Wie zich als klant heeft aangemeld en of een medewerker hem heeft goedgekeurd. Zonder goedkeuring heeft een klant geen rechten.';

alter table public.klanten enable row level security;

-- Smal: lezen, en van één kolom wijzigen. Een regel maken gaat alleen via
-- klant_aanmelden(), zodat niemand zelf een adres of een goedkeuring kan invullen. Een regel
-- weghalen kan niemand via de app.
revoke all on public.klanten from public, anon, authenticated;
grant select on public.klanten to authenticated;
grant update (goedgekeurd) on public.klanten to authenticated;

create policy "klanten_select_medewerker"
  on public.klanten
  for select
  to authenticated
  using ((select public.is_medewerker()));

create policy "klanten_update_medewerker"
  on public.klanten
  for update
  to authenticated
  using ((select public.is_medewerker()))
  with check ((select public.is_medewerker()));

-- Het adres komt uit het account zelf, niet uit wat de browser of het token meestuurt. De
-- sessie van het token moet nog bestaan: na uitloggen, of na een adreswijziging (zie
-- hieronder), doet een oud token hier niets meer.
create function public.klant_aanmelden()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.klanten (user_id, e_mail)
  select u.id, u.email
    from auth.users u
   where u.id = auth.uid()
     and u.email is not null
     and exists (
       select 1
         from auth.sessions s
        where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
          and s.user_id = auth.uid()
     )
  on conflict (user_id) do nothing
$$;

comment on function public.klant_aanmelden() is
  'Zet het eigen account op de lijst van klanten, niet goedgekeurd. Het adres komt uit het account. Meer kan deze functie niet.';

create function public.is_goedgekeurde_klant()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from auth.users u
     where u.id = auth.uid()
       and u.banned_until > now()
  )
  and exists (
    select 1
      from public.klanten k
     where k.user_id = auth.uid()
       and k.goedgekeurd
  )
  and exists (
    select 1
      from auth.sessions s
     where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
       and s.user_id = auth.uid()
  )
$$;

comment on function public.is_goedgekeurde_klant() is
  'Heeft een medewerker dit account als klant goedgekeurd, is het niet geblokkeerd, en bestaat de sessie nog? Gebruik deze functie in policies voor wat alleen een goedgekeurde klant mag.';

-- Een klant wijzigt zijn e-mailadres niet zelf: dat loopt via een medewerker, en de inrichting
-- zet de mail voor een adreswijziging dicht. Gebeurt het toch (een beheerder past het adres
-- aan, of de instelling staat open), dan mag de goedkeuring niet meeverhuizen naar een adres
-- dat de medewerker nooit heeft gezien, en mag wie het account eerst had er niet in blijven:
--   * het adres in `klanten` loopt mee met het account, zodat de medewerker ziet wat er nu
--     staat;
--   * de goedkeuring vervalt: een medewerker keurt het nieuwe adres opnieuw goed;
--   * alle sessies van het account eindigen. Wie het account op het oude adres had, is
--     uitgelogd en komt er alleen weer in met de mailbox van het nieuwe adres.
create function public.klant_adres_gewijzigd()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.klanten
     set e_mail = coalesce(new.email, ''),
         goedgekeurd = false
   where user_id = new.id;
  delete from auth.sessions where user_id = new.id;
  return null;
end
$$;

create trigger klant_adres_gewijzigd
  after update on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.klant_adres_gewijzigd();

-- Wie mag wat aanroepen. Standaard mag iedereen elke nieuwe functie uitvoeren; dat gaat er
-- eerst af. De vier functies van het klantportaal zijn voor ingelogde gebruikers, de functie
-- achter de trigger voor niemand.
revoke all on function public.sessie_via_cloudflare() from public, anon, authenticated;
revoke all on function public.is_medewerker() from public, anon, authenticated;
revoke all on function public.klant_aanmelden() from public, anon, authenticated;
revoke all on function public.is_goedgekeurde_klant() from public, anon, authenticated;
revoke all on function public.klant_adres_gewijzigd() from public, anon, authenticated;
grant execute on function public.sessie_via_cloudflare() to authenticated;
grant execute on function public.is_medewerker() to authenticated;
grant execute on function public.klant_aanmelden() to authenticated;
grant execute on function public.is_goedgekeurde_klant() to authenticated;
