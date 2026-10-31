'use client';

/**
 * Metas por vendedor (ARK Onda 3 / 3.3) — preenchido no bloco 4.
 */

import React from 'react';
import { Target } from 'lucide-react';

export const SellerGoalsSection: React.FC<{ isAdmin: boolean; userId?: string }> = () => (
  <div className="glass p-4 rounded-xl border border-slate-200 dark:border-white/5 shadow-sm">
    <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
      <Target size={16} className="text-amber-500" />
      Metas por vendedor
    </h3>
    <p className="text-xs text-slate-500 mt-2">Em construção.</p>
  </div>
);

export default SellerGoalsSection;
