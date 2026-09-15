import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Redis } from 'ioredis';

/** Scripts that touch room state. Each is loaded with the shared prelude prepended */
export const ROOM_SCRIPTS = [
  'join',
  'check',
  'heartbeat',
  'leave',
  'promote',
  'stats',
  'verify',
] as const;

export type RoomScriptName = (typeof ROOM_SCRIPTS)[number];
export type ScriptName = RoomScriptName | 'register-config';

/** ioredis custom command name in the turnway_ namespace */
export function commandName(script: ScriptName): string {
  return `turnway_${script.replace(/-/g, '_')}`;
}

/** Lua directory shipped with the build output */
export function defaultLuaDir(): string {
  return join(__dirname, '..', 'lua');
}

function read(dir: string, name: string): string {
  return readFileSync(join(dir, `${name}.lua`), 'utf8');
}

/** Return the script sources with the prelude merged in */
export function loadScriptSources(dir: string = defaultLuaDir()): Record<ScriptName, string> {
  const prelude = read(dir, '_prelude');
  const sources = {} as Record<ScriptName, string>;

  for (const name of ROOM_SCRIPTS) {
    sources[name] = `${prelude}\n\n-- ${name}.lua\n${read(dir, name)}`;
  }
  // Config registration uses none of the fixed room keys, so it runs without the prelude
  sources['register-config'] = read(dir, 'register-config');

  return sources;
}

/**
 * Register the scripts as ioredis custom commands.
 * ioredis handles resending when EVALSHA misses.
 * Registers turnway_* commands on both owned and injected connections.
 */
export function defineScripts(client: Redis, dir?: string): void {
  const sources = loadScriptSources(dir);

  for (const name of ROOM_SCRIPTS) {
    client.defineCommand(commandName(name), { numberOfKeys: 4, lua: sources[name] });
  }
  client.defineCommand(commandName('register-config'), {
    numberOfKeys: 1,
    lua: sources['register-config'],
  });
}

/** Signature of an ioredis command registered with defineCommand() */
type ScriptCommand = (...params: Array<string | number>) => Promise<string>;

/** Invoke a registered script */
export function callScript(
  client: Redis,
  script: ScriptName,
  keys: string[],
  args: Array<string | number>,
): Promise<string> {
  const command = commandName(script);
  const invoke = (client as Redis & Partial<Record<string, ScriptCommand>>)[command];

  if (typeof invoke !== 'function') {
    throw new Error(`Turnway script "${script}" is not defined on this Redis client.`);
  }

  return invoke.call(client, ...keys, ...args);
}
