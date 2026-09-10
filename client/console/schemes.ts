export interface FieldScheme {
  id: string;
  name: string;
  chrome: string;
  surface: string;
  raised: string;
  hair: string;
  hair2: string;
  t1: string;
  t2: string;
  t3: string;
  light: string;
  attn: string;
  fail: string;
  lightScheme?: boolean;
}

export const SCHEMES: FieldScheme[] = [
  {
    id: 'field',
    name: 'Field',
    chrome: '#121417',
    surface: '#16191d',
    raised: '#1c2025',
    hair: 'rgba(255,255,255,.07)',
    hair2: 'rgba(255,255,255,.12)',
    t1: '#e6e9ed',
    t2: '#a4acb6',
    t3: '#808b97',
    light: '#3fd6df',
    attn: '#e0a94a',
    fail: '#e06c6c',
  },
  {
    id: 'deep-field',
    name: 'Deep Field',
    chrome: '#0c1220',
    surface: '#101828',
    raised: '#162036',
    hair: 'rgba(255,255,255,.08)',
    hair2: 'rgba(255,255,255,.14)',
    t1: '#e8edf5',
    t2: '#a7b2c4',
    t3: '#7f8ca0',
    light: '#5cc8ff',
    attn: '#e6b45a',
    fail: '#e06c6c',
  },
  {
    id: 'graphite',
    name: 'Graphite',
    chrome: '#151515',
    surface: '#1a1a1a',
    raised: '#212121',
    hair: 'rgba(255,255,255,.07)',
    hair2: 'rgba(255,255,255,.12)',
    t1: '#ebe9e6',
    t2: '#aaa7a2',
    t3: '#8c8882',
    light: '#f0e6d2',
    attn: '#e0a94a',
    fail: '#e06c6c',
  },
  {
    id: 'verdigris',
    name: 'Verdigris',
    chrome: '#0a1716',
    surface: '#0e1c1b',
    raised: '#142523',
    hair: 'rgba(255,255,255,.07)',
    hair2: 'rgba(255,255,255,.12)',
    t1: '#e4efeb',
    t2: '#a5b8b2',
    t3: '#7f948e',
    light: '#4fd1a5',
    attn: '#e0a94a',
    fail: '#e06c6c',
  },
  {
    id: 'harbor',
    name: 'Harbor',
    chrome: '#0d1020',
    surface: '#12162a',
    raised: '#181d35',
    hair: 'rgba(255,255,255,.08)',
    hair2: 'rgba(255,255,255,.13)',
    t1: '#e7e9f2',
    t2: '#a8adc4',
    t3: '#8188a3',
    light: '#8aa2ff',
    attn: '#e6b45a',
    fail: '#e06c6c',
  },
  {
    id: 'ember',
    name: 'Ember',
    chrome: '#171311',
    surface: '#1c1715',
    raised: '#241d1a',
    hair: 'rgba(255,255,255,.07)',
    hair2: 'rgba(255,255,255,.12)',
    t1: '#ede7e2',
    t2: '#b0a59c',
    t3: '#90857c',
    light: '#ff8a5b',
    attn: '#e0a94a',
    fail: '#e06c6c',
  },
  {
    id: 'moss',
    name: 'Moss',
    chrome: '#111410',
    surface: '#151914',
    raised: '#1b201a',
    hair: 'rgba(255,255,255,.07)',
    hair2: 'rgba(255,255,255,.12)',
    t1: '#e7eae3',
    t2: '#a7ada0',
    t3: '#828a7a',
    light: '#b5d84a',
    attn: '#e0a94a',
    fail: '#e06c6c',
  },
  {
    id: 'dusk',
    name: 'Dusk',
    chrome: '#151219',
    surface: '#1a161f',
    raised: '#211c28',
    hair: 'rgba(255,255,255,.07)',
    hair2: 'rgba(255,255,255,.12)',
    t1: '#ebe6ef',
    t2: '#aea6b6',
    t3: '#8b8395',
    light: '#e58fb1',
    attn: '#e0a94a',
    fail: '#e06c6c',
  },
  {
    id: 'ink',
    name: 'Ink',
    chrome: '#0a0a0b',
    surface: '#0f0f10',
    raised: '#161617',
    hair: 'rgba(255,255,255,.08)',
    hair2: 'rgba(255,255,255,.14)',
    t1: '#f2f2f2',
    t2: '#b3b3b3',
    t3: '#8a8a8a',
    light: '#ffffff',
    attn: '#e0a94a',
    fail: '#e06c6c',
  },
  {
    id: 'paper',
    name: 'Paper',
    chrome: '#f3f4f6',
    surface: '#ffffff',
    raised: '#eef0f3',
    hair: 'rgba(0,0,0,.08)',
    hair2: 'rgba(0,0,0,.14)',
    t1: '#1a1d21',
    t2: '#4b5563',
    t3: '#666d7a',
    light: '#0e7c86',
    attn: '#b7791f',
    fail: '#c53030',
    lightScheme: true,
  },
];

export const DEFAULT_SCHEME = 'field';

export function schemeId(id: string | undefined): string {
  if (id === 'cobalt') return 'harbor';
  if (SCHEMES.some((s) => s.id === id)) return id as string;
  return 'field';
}
