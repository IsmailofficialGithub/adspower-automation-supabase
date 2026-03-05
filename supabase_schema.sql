-- ============================================================
-- AdsPower Automation — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- All tables are kept in the 'public' schema but prefixed with 'ads_'
-- to avoid conflicts and stay isolated.

-- ─── Proxies ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ads_proxies (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    host        TEXT NOT NULL,
    port        INTEGER NOT NULL,
    "user"      TEXT NOT NULL,
    pass        TEXT NOT NULL,
    protocol    TEXT NOT NULL DEFAULT 'socks5',
    os          TEXT NOT NULL DEFAULT 'windows',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.ads_proxies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own proxies"
    ON public.ads_proxies FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ─── Used Proxies ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ads_used_proxies (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    host        TEXT NOT NULL,
    port        INTEGER NOT NULL,
    "user"      TEXT NOT NULL,
    pass        TEXT NOT NULL,
    protocol    TEXT NOT NULL DEFAULT 'socks5',
    os          TEXT NOT NULL DEFAULT 'windows',
    used_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.ads_used_proxies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own used proxies"
    ON public.ads_used_proxies FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ─── Websites ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ads_website (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    url         TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, url)
);

ALTER TABLE public.ads_website ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own websites"
    ON public.ads_website FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ─── Settings ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ads_settings (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
    data        JSONB NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.ads_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own settings"
    ON public.ads_settings FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ─── Logs ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ads_logs (
    id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id          UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    profile_id       TEXT NOT NULL,
    website_url      TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    proxy_host       TEXT,
    proxy_port       INTEGER,
    status           TEXT DEFAULT 'success',
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.ads_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own logs"
    ON public.ads_logs FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS ads_proxies_user_id_idx        ON public.ads_proxies(user_id);
CREATE INDEX IF NOT EXISTS ads_used_proxies_user_id_idx   ON public.ads_used_proxies(user_id);
CREATE INDEX IF NOT EXISTS ads_website_user_id_idx        ON public.ads_website(user_id);
CREATE INDEX IF NOT EXISTS ads_logs_user_id_idx           ON public.ads_logs(user_id);
