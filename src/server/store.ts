import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { z } from 'zod';
import {
  ConnectionSchema,
  ToolSchema,
  formatZodError,
  validateToolRules,
  type Connection,
  type Tool,
} from '../shared/schema.js';

export interface Invalid {
  file: string;
  errors: string[];
}

interface Logger {
  warn(obj: unknown, msg?: string): void;
}

/** Loads connections and tools from JSON files under `dataDir` and keeps them in memory. */
export class ConfigStore extends EventEmitter {
  private conns = new Map<string, Connection>();
  private toolMap = new Map<string, Tool>();
  // Tools that parsed but failed cross-checks still count as references to a connection.
  private toolRefs = new Map<string, string>();
  private problems: Invalid[] = [];
  private watchers: FSWatcher[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private dataDir: string,
    private log?: Logger,
  ) {
    super();
  }

  private dir(kind: 'connections' | 'tools') {
    return join(this.dataDir, kind);
  }

  private async readAll(kind: 'connections' | 'tools') {
    const files = (await readdir(this.dir(kind))).filter((f) => f.endsWith('.json')).sort();
    return Promise.all(
      files.map(async (f) => ({ file: `${kind}/${f}`, id: basename(f, '.json'), raw: await readFile(join(this.dir(kind), f), 'utf8') })),
    );
  }

  async load(): Promise<void> {
    await mkdir(this.dir('connections'), { recursive: true });
    await mkdir(this.dir('tools'), { recursive: true });

    const conns = new Map<string, Connection>();
    const tools = new Map<string, Tool>();
    const refs = new Map<string, string>();
    const problems: Invalid[] = [];

    const parse = <S extends z.ZodType>(file: string, raw: string, schema: S): z.output<S> | undefined => {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (e) {
        problems.push({ file, errors: [`Invalid JSON: ${(e as Error).message}`] });
        return undefined;
      }
      const r = schema.safeParse(json);
      if (!r.success) {
        problems.push({ file, errors: formatZodError(r.error) });
        return undefined;
      }
      return r.data;
    };

    for (const { file, id, raw } of await this.readAll('connections')) {
      const c = parse(file, raw, ConnectionSchema);
      if (!c) continue;
      if (c.id !== id) problems.push({ file, errors: [`File name must match id "${c.id}"`] });
      else conns.set(c.id, c);
    }

    const ids = new Set(conns.keys());
    for (const { file, id, raw } of await this.readAll('tools')) {
      const t = parse(file, raw, ToolSchema);
      if (!t) continue;
      if (t.name !== id) {
        problems.push({ file, errors: [`File name must match name "${t.name}"`] });
        continue;
      }
      refs.set(t.name, t.connection);
      const errors = validateToolRules(t, ids);
      if (errors.length) problems.push({ file, errors });
      else tools.set(t.name, t);
    }

    for (const p of problems) this.log?.warn(p, 'invalid config file');
    this.conns = conns;
    this.toolMap = tools;
    this.toolRefs = refs;
    this.problems = problems;
  }

  /** Watches the data directories and reloads (debounced) on any change. */
  watch(): void {
    const onChange = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.load()
          .then(() => this.emit('change'))
          .catch((e) => this.log?.warn({ err: e }, 'reload failed'));
      }, 100);
    };
    for (const kind of ['connections', 'tools'] as const) this.watchers.push(watch(this.dir(kind), onChange));
  }

  close(): void {
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  connections = () => [...this.conns.values()];
  tools = () => [...this.toolMap.values()];
  getConnection = (id: string) => this.conns.get(id);
  getTool = (name: string) => this.toolMap.get(name);
  invalid = () => this.problems;

  private async writeJson(kind: 'connections' | 'tools', id: string, data: unknown) {
    const path = join(this.dir(kind), `${id}.json`);
    await writeFile(`${path}.tmp`, JSON.stringify(data, null, 2) + '\n');
    await rename(`${path}.tmp`, path);
    await this.load();
    this.emit('change');
  }

  private async remove(kind: 'connections' | 'tools', id: string) {
    await rm(join(this.dir(kind), `${id}.json`), { force: true });
    await this.load();
    this.emit('change');
  }

  saveConnection = (c: Connection) => this.writeJson('connections', c.id, c);
  saveTool = (t: Tool) => this.writeJson('tools', t.name, t);
  deleteTool = (name: string) => this.remove('tools', name);

  async deleteConnection(id: string): Promise<void> {
    const users = [...this.toolRefs].filter(([, c]) => c === id).map(([t]) => t);
    if (users.length) throw new ConflictError(`Connection "${id}" is used by: ${users.join(', ')}`);
    await this.remove('connections', id);
  }
}

export class ConflictError extends Error {}
