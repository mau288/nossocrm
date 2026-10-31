'use client';

/**
 * Alertas do gestor (ARK Onda 3 / 3.4) — preenchido no bloco 6.
 */

import React from 'react';
import { Bell } from 'lucide-react';

export const AlertSettingsSection: React.FC = () => (
  <div className="glass p-4 rounded-xl border border-slate-200 dark:border-white/5 shadow-sm">
    <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
      <Bell size={16} className="text-red-500" />
      Alertas no WhatsApp
    </h3>
    <p className="text-xs text-slate-500 mt-2">Em construção.</p>
  </div>
);

export default AlertSettingsSection;
