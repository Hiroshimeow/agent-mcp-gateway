function shellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildNodeOutputCommand(bytes, { platform = process.platform, execPath = process.execPath } = {}) {
  const executable = shellQuote(execPath);
  const script = shellQuote(`process.stdout.write(Buffer.alloc(${bytes}, 120))`);
  return platform === 'win32' ? `& ${executable} -e ${script}` : `${executable} -e ${script}`;
}
