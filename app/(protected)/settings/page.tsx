import type { Metadata } from 'next';
import SettingsPage from '@/features/settings/SettingsPage'

export const metadata: Metadata = { title: 'Configurações | ARK ACADEMY' };

export default function Settings() {
    return <SettingsPage />
}
