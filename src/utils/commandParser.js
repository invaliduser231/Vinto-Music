const TOKEN_PATTERN = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;

function unescapeQuoted(value) {
  return value.replace(/\\(["'\\])/g, '$1');
}

export function parseArguments(input) {
  const text = String(input ?? '').trim();
  if (!text) return [];

  const args = [];
  let match;
  while ((match = TOKEN_PATTERN.exec(text)) !== null) {
    const [, doubleQuoted, singleQuoted, bare] = match;
    if (doubleQuoted != null) {
      args.push(unescapeQuoted(doubleQuoted));
      continue;
    }
    if (singleQuoted != null) {
      args.push(unescapeQuoted(singleQuoted));
      continue;
    }
    args.push(bare);
  }

  return args;
}

export function parseCommand(content, prefix) {
  if (!content || !prefix || !content.startsWith(prefix)) {
    return null;
  }

  const raw = content.slice(prefix.length).trim();
  if (!raw) return null;

  const args = parseArguments(raw);
  if (!args.length) return null;

  const [name, ...rest] = args;
  return {
    name: name.toLowerCase(),
    args: rest,
    rawArgs: raw.slice(name.length).trim(),
  };
}
