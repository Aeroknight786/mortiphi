export interface CliOptions {
  port: number;
  open: boolean;
  museBin?: string;
  help: boolean;
  version: boolean;
}

export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = { port: 0, open: true, help: false, version: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--version" || argument === "-V") options.version = true;
    else if (argument === "--no-open") options.open = false;
    else if (argument === "--port") options.port = port(argv[++index]);
    else if (argument.startsWith("--port=")) options.port = port(argument.slice(7));
    else if (argument === "--muse-bin") options.museBin = value(argv[++index], "--muse-bin");
    else if (argument.startsWith("--muse-bin=")) options.museBin = value(argument.slice(11), "--muse-bin");
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function value(input: string | undefined, option: string) {
  if (!input) throw new Error(`${option} requires a value.`);
  return input;
}

function port(input: string | undefined) {
  const parsed = Number(value(input, "--port"));
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error("--port must be an integer from 0 to 65535.");
  return parsed;
}
