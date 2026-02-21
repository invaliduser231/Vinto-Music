export class CommandRegistry {
  constructor() {
    this.commands = new Map();
    this.aliases = new Map();
  }

  register(definition) {
    const name = definition.name.toLowerCase();
    if (this.commands.has(name)) {
      throw new Error(`Duplicate command name: ${name}`);
    }

    this.commands.set(name, definition);

    for (const alias of definition.aliases ?? []) {
      const normalized = alias.toLowerCase();
      if (this.aliases.has(normalized) || this.commands.has(normalized)) {
        throw new Error(`Duplicate command alias: ${normalized}`);
      }
      this.aliases.set(normalized, name);
    }
  }

  resolve(name) {
    const normalized = name.toLowerCase();
    const primary = this.commands.has(normalized)
      ? normalized
      : this.aliases.get(normalized);

    if (!primary) return null;
    return this.commands.get(primary) ?? null;
  }

  list() {
    return [...this.commands.values()]
      .filter((command) => command.hidden !== true)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
