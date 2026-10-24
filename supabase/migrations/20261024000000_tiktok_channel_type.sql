-- ARK #52: TikTok como tipo de canal (DMs pela Zernio).
-- O CHECK original (20260205100000) só conhecia whatsapp/instagram/email/sms/telegram/voice.
ALTER TABLE public.messaging_channels
  DROP CONSTRAINT IF EXISTS messaging_channels_channel_type_check;

ALTER TABLE public.messaging_channels
  ADD CONSTRAINT messaging_channels_channel_type_check CHECK (channel_type IN (
    'whatsapp', 'instagram', 'tiktok', 'email', 'sms', 'telegram', 'voice'
  ));
