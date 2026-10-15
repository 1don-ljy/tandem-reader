import type { ProviderId } from './providers.ts';

export type DisplayMode = 'source' | 'dual' | 'translation';
export type RuleAction = 'keep' | 'translate' | 'first';
export type RuleScope = 'page' | 'collection' | 'domain' | 'global';

export interface Settings {
  activeProfileId: string;
  domain: string;
  context: string;
  mode: DisplayMode;
  targetLanguage: string;
  autoDiscover: boolean;
}

export interface ModelProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  keyPersistence: 'session' | 'local';
  provider?: ProviderId;
}
export interface PublicProfile extends ModelProfile { hasKey: boolean }
export type ProfileInput = Omit<ModelProfile, 'id'> & { id?: string };

export interface Rule {
  id: string;
  term: string;
  action: RuleAction;
  translation: string;
  scope: RuleScope;
  scopeValue: string;
  domain: string;
}
export type RuleInput = Omit<Rule, 'id'> & { id?: string };
export interface Skip { id: string; url: string; text: string }

export interface DocumentMemory {
  id: string;
  scope: 'page' | 'collection';
  scopeValue: string;
  domain: string;
  context: string;
  updatedAt: number;
}
export type MemoryInput = Omit<DocumentMemory, 'id' | 'updatedAt'> & { id?: string };
export interface DomainTerm {
  term: string;
  translation: string;
  meaning: string;
  action: RuleAction;
  evidence: string;
}
export interface DomainMemory {
  id: string;
  scopeValue: string;
  domain: string;
  context: string;
  terms: DomainTerm[];
  documents: { url: string; fingerprint: string }[];
  updatedAt: number;
}
export interface DomainAnalysis { domain: string; context: string; terms: DomainTerm[] }
export interface SessionTurn { source: string; translation: string; heading: string; at: number }
export interface DocumentSession { id: string; url: string; identity: string; turns: SessionTurn[]; updatedAt: number }
export interface SessionSummary { id: string; url: string; turnCount: number; updatedAt: number }

export interface PublicState {
  settings: Settings;
  profiles: PublicProfile[];
  rules: Rule[];
  skips: Skip[];
  memories: DocumentMemory[];
  sessions: SessionSummary[];
  domainMemories: DomainMemory[];
}
export interface PageContext {
  settings: Settings;
  rules: Rule[];
  skips: Skip[];
  profileConfigured: boolean;
  memory?: DocumentMemory;
  domainMemory?: DomainMemory;
}
export interface ContentStatus { running: boolean; total: number; done: number; failed: number; mode: DisplayMode }
export interface AppData { settings: Settings; profiles: ModelProfile[]; rules: Rule[]; skips: Skip[]; revision: number }
export interface KeyStores { local: Record<string, string>; session: Record<string, string> }
export interface Connection { profile: ModelProfile; baseUrl: string; endpoint: string; origin: string; local: boolean; apiKey: string }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ProtectedData { text: string; replacements: { token: string; value: string }[]; codeTokens: string[]; seenTerms: string[] }

export interface ExportedConfig { version: 1; settings: Settings; profiles: ModelProfile[]; rules: Rule[]; memories?: DocumentMemory[] }
