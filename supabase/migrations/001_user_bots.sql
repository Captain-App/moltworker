-- OpenClaw: User Bot Instances Table
-- This table tracks the mapping between users and their bot sandbox instances

CREATE TABLE public.user_bots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    sandbox_name TEXT NOT NULL,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
    config JSONB DEFAULT '{}',
    r2_prefix TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_active_at TIMESTAMPTZ,
    UNIQUE (user_id)
);

-- Create index for faster lookups by user_id
CREATE INDEX idx_user_bots_user_id ON public.user_bots(user_id);

-- Enable Row Level Security
ALTER TABLE public.user_bots ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only view their own bot
CREATE POLICY "Users can view own bot"
    ON public.user_bots FOR SELECT
    USING (auth.uid() = user_id);

-- Policy: Users can update their own bot's config (but not sandbox_name or r2_prefix)
CREATE POLICY "Users can update own bot config"
    ON public.user_bots FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Function to automatically create a bot record when a new user signs up
CREATE OR REPLACE FUNCTION handle_new_user_bot()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.user_bots (user_id, sandbox_name, r2_prefix)
    VALUES (
        NEW.id,
        'openclaw-' || NEW.id::text,
        'users/' || NEW.id::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create bot record on user signup
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user_bot();

-- Function to update last_active_at timestamp
CREATE OR REPLACE FUNCTION update_bot_last_active()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_active_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update last_active_at on any update
CREATE TRIGGER on_user_bot_update
    BEFORE UPDATE ON public.user_bots
    FOR EACH ROW EXECUTE FUNCTION update_bot_last_active();
