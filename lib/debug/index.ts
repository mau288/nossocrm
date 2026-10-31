/**
 * Debug Mode - Sistema de geração de dados fake para testes
 *
 * Ativar: localStorage.setItem('DEBUG_MODE', 'true')
 * Desativar: localStorage.removeItem('DEBUG_MODE')
 *
 * Ou via console: window.enableDebugMode() / window.disableDebugMode()
 *
 * ARK (Onda 0 / 0.7): o Faker (pt_BR, ~1 MB) era importado estaticamente aqui e,
 * como o Layout importa `isDebugMode` deste arquivo, ia parar no bundle de TODAS as
 * telas. Agora as flags vivem em `./mode` (sem dependencias) e o Faker so e carregado
 * sob demanda, dentro dos geradores (import dinamico).
 */

import type { Faker } from '@faker-js/faker';

export { DEBUG_MODE_EVENT, isDebugMode, enableDebugMode, disableDebugMode } from './mode';

let fakerPromise: Promise<Faker> | null = null;
/** Carrega o Faker pt_BR uma unica vez, e so quando algum gerador e chamado. */
const loadFaker = (): Promise<Faker> => {
  if (!fakerPromise) {
    fakerPromise = import('@faker-js/faker/locale/pt_BR').then((m) => m.faker);
  }
  return fakerPromise;
};

// ============================================
// FAKE DATA GENERATORS
// ============================================

/**
 * Função pública `fakeContact` do projeto.
 * @returns {{ name: string; email: string; phone: string; role: string; companyName: string; }} Retorna um valor do tipo `{ name: string; email: string; phone: string; role: string; companyName: string; }`.
 */
export const fakeContact = async () => {
  const faker = await loadFaker();
  return {
  name: faker.person.fullName(),
  email: faker.internet.email().toLowerCase(),
  // Evita `fromRegExp` (pode gerar barra invertida em alguns ambientes)
  phone: (() => {
    const ddd = faker.number.int({ min: 11, max: 99 });
    const subscriber = `${faker.number.int({ min: 0, max: 99999999 })}`.padStart(8, '0');
    return `+55${ddd}9${subscriber}`;
  })(),
  role: faker.person.jobTitle(),
  companyName: faker.company.name(),
  };
};

/**
 * Função pública `fakeCompany` do projeto.
 * @returns {{ name: string; industry: "Tecnologia" | "Varejo" | "Saúde" | "Educação" | "Financeiro" | "Indústria" | "Serviços" | "Construção" | "Alimentação" | "Logística"; website: string; employees: "1-10" | ... 3 more ... | "500+"; }} Retorna um valor do tipo `{ name: string; industry: "Tecnologia" | "Varejo" | "Saúde" | "Educação" | "Financeiro" | "Indústria" | "Serviços" | "Construção" | "Alimentação" | "Logística"; website: string; employees: "1-10" | ... 3 more ... | "500+"; }`.
 */
export const fakeCompany = async () => {
  const faker = await loadFaker();
  return {
  name: faker.company.name(),
  industry: faker.helpers.arrayElement([
    'Tecnologia',
    'Varejo',
    'Saúde',
    'Educação',
    'Financeiro',
    'Indústria',
    'Serviços',
    'Construção',
    'Alimentação',
    'Logística',
  ]),
  website: faker.internet.url(),
  employees: faker.helpers.arrayElement(['1-10', '11-50', '51-200', '201-500', '500+']),
  };
};

/**
 * Função pública `fakeDeal` do projeto.
 * @returns {{ title: string; value: number; probability: 50 | 80 | 10 | 60 | 30 | 20 | 40 | 70 | 90; priority: "low" | "medium" | "high"; tags: ("Urgente" | "Enterprise" | "Renovação" | "Upsell" | "Novo Cliente" | "Indicação")[]; notes: string; }} Retorna um valor do tipo `{ title: string; value: number; probability: 50 | 80 | 10 | 60 | 30 | 20 | 40 | 70 | 90; priority: "low" | "medium" | "high"; tags: ("Urgente" | "Enterprise" | "Renovação" | "Upsell" | "Novo Cliente" | "Indicação")[]; notes: string; }`.
 */
export const fakeDeal = async () => {
  const faker = await loadFaker();
  return {
  title: `${faker.commerce.productAdjective()} ${faker.commerce.product()}`,
  value: faker.number.int({ min: 1000, max: 500000 }),
  probability: faker.helpers.arrayElement([10, 20, 30, 40, 50, 60, 70, 80, 90]),
  priority: faker.helpers.arrayElement(['low', 'medium', 'high'] as const),
  tags: faker.helpers.arrayElements(
    ['Urgente', 'Enterprise', 'Renovação', 'Upsell', 'Novo Cliente', 'Indicação'],
    faker.number.int({ min: 0, max: 3 })
  ),
  notes: faker.lorem.sentence(),
  };
};

/**
 * Função pública `fakeActivity` do projeto.
 * @returns {{ title: "Reunião de apresentação" | "Ligação de follow-up" | "Enviar proposta comercial" | "Demo do produto" | "Negociar contrato" | "Visita ao cliente" | "Apresentar case de sucesso" | "Alinhar expectativas"; description: string; type: "CALL" | ... 2 more ... | "TASK"; date: string; }} Retorna um valor do tipo `{ title: "Reunião de apresentação" | "Ligação de follow-up" | "Enviar proposta comercial" | "Demo do produto" | "Negociar contrato" | "Visita ao cliente" | "Apresentar case de sucesso" | "Alinhar expectativas"; description: string; type: "CALL" | ... 2 more ... | "TASK"; date: string; }`.
 */
export const fakeActivity = async () => {
  const faker = await loadFaker();
  return {
  title: faker.helpers.arrayElement([
    'Reunião de apresentação',
    'Ligação de follow-up',
    'Enviar proposta comercial',
    'Demo do produto',
    'Negociar contrato',
    'Visita ao cliente',
    'Apresentar case de sucesso',
    'Alinhar expectativas',
  ]),
  description: faker.lorem.sentence(),
  type: faker.helpers.arrayElement(['CALL', 'MEETING', 'TASK', 'EMAIL'] as const),
  date: faker.date.soon({ days: 14 }).toISOString(),
  };
};

/**
 * Função pública `fakeProduct` do projeto.
 * @returns {{ name: string; price: number; description: string; }} Retorna um valor do tipo `{ name: string; price: number; description: string; }`.
 */
export const fakeProduct = async () => {
  const faker = await loadFaker();
  return {
  name: faker.commerce.productName(),
  price: faker.number.float({ min: 100, max: 10000, fractionDigits: 2 }),
  description: faker.commerce.productDescription(),
  };
};

// ============================================
// BULK GENERATORS
// ============================================

/**
 * Função pública `generateFakeContacts` do projeto.
 *
 * @param {number} count - Parâmetro `count`.
 * @returns {{ name: string; email: string; phone: string; role: string; companyName: string; }[]} Retorna um valor do tipo `{ name: string; email: string; phone: string; role: string; companyName: string; }[]`.
 */
export const generateFakeContacts = async (count: number = 5) => {
  return Promise.all(Array.from({ length: count }, () => fakeContact()));
};

/**
 * Função pública `generateFakeDeals` do projeto.
 *
 * @param {number} count - Parâmetro `count`.
 * @returns {{ title: string; value: number; probability: 50 | 80 | 10 | 60 | 30 | 20 | 40 | 70 | 90; priority: "low" | "medium" | "high"; tags: ("Urgente" | "Enterprise" | "Renovação" | "Upsell" | "Novo Cliente" | "Indicação")[]; notes: string; }[]} Retorna um valor do tipo `{ title: string; value: number; probability: 50 | 80 | 10 | 60 | 30 | 20 | 40 | 70 | 90; priority: "low" | "medium" | "high"; tags: ("Urgente" | "Enterprise" | "Renovação" | "Upsell" | "Novo Cliente" | "Indicação")[]; notes: string; }[]`.
 */
export const generateFakeDeals = async (count: number = 5) => {
  return Promise.all(Array.from({ length: count }, () => fakeDeal()));
};

// ============================================
// DEBUG BUTTON STYLES
// ============================================

export const debugButtonStyles = {
  base: 'inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border transition-colors',
  primary: 'bg-purple-100 text-purple-700 border-purple-300 hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700 dark:hover:bg-purple-800/40',
  secondary: 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700',
  danger: 'bg-red-100 text-red-700 border-red-300 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700 dark:hover:bg-red-800/40',
};
