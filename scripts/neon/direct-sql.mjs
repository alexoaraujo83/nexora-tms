#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DEFAULT_PROJECT_ID = 'morning-grass-06967990';
const DEFAULT_DATABASE = 'nexora';
const DEFAULT_ROLE = 'nexora_owner';
const DEFAULT_ENVIRONMENT = 'development';

const BRANCH_BY_ENVIRONMENT = Object.freeze({
  development: 'development',
  staging: 'staging',
  production: 'production',
});

function fail(message) {
  console.error(`direct-sql: ${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage:
  pnpm neon:sql -- --file <path> [options]
  pnpm neon:sql -- --command <sql> [options]

Options:
  --environment <development|staging|production>  Target environment (default: development)
  --branch <name>                                  Override the branch resolved from environment
  --project-id <id>                                Neon project ID
  --database <name>                                Database name (default: nexora)
  --role <name>                                    PostgreSQL role (default: nexora_owner)
  --file <path>                                    Execute a SQL file
  --command <sql>                                  Execute one SQL command
  --allow-write                                    Disable the read-only guard
  --help                                           Show this help

Credentials:
  Set NEON_API_KEY so the Neon CLI can derive a short-lived connection string.
  Alternatively set NEON_DIRECT_DATABASE_URL to bypass Neon CLI resolution.

Safety:
  Sessions are read-only by default. Mutating SQL requires --allow-write.
`);
}

function parseArgs(argv) {
  const parsed = {
    allowWrite: false,
    environment: DEFAULT_ENVIRONMENT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--allow-write') {
      parsed.allowWrite = true;
      continue;
    }

    if (argument === '--help') {
      parsed.help = true;
      continue;
    }

    const valueOptions = new Map([
      ['--environment', 'environment'],
      ['--branch', 'branch'],
      ['--project-id', 'projectId'],
      ['--database', 'database'],
      ['--role', 'role'],
      ['--file', 'file'],
      ['--command', 'command'],
    ]);

    const key = valueOptions.get(argument);
    if (!key) {
      fail(`unknown argument: ${argument}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`${argument} requires a value`);
    }

    parsed[key] = value;
    index += 1;
  }

  return parsed;
}

function requireCommand(command) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error?.code === 'ENOENT') {
    fail(`${command} is required but was not found in PATH`);
  }
}

function resolveConnectionString({ branch, database, projectId, role }) {
  const explicitUrl = process.env.NEON_DIRECT_DATABASE_URL;
  if (explicitUrl) {
    return explicitUrl.trim();
  }

  if (!process.env.NEON_API_KEY) {
    fail('NEON_API_KEY or NEON_DIRECT_DATABASE_URL is required');
  }

  requireCommand('neon');

  const result = spawnSync(
    'neon',
    [
      'connection-string',
      branch,
      '--project-id',
      projectId,
      '--database-name',
      database,
      '--role-name',
      role,
    ],
    {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );

  if (result.status !== 0) {
    fail('Neon CLI could not resolve a PostgreSQL connection string');
  }

  const connectionString = result.stdout.trim();
  if (!connectionString) {
    fail('Neon CLI returned an empty PostgreSQL connection string');
  }

  return connectionString;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

if (!BRANCH_BY_ENVIRONMENT[options.environment]) {
  fail(`unsupported environment: ${options.environment}`);
}

if (Boolean(options.file) === Boolean(options.command)) {
  fail('provide exactly one of --file or --command');
}

if (options.file && !existsSync(options.file)) {
  fail(`SQL file not found: ${options.file}`);
}

requireCommand('psql');

const projectId = options.projectId ?? process.env.NEON_PROJECT_ID ?? DEFAULT_PROJECT_ID;
const database = options.database ?? DEFAULT_DATABASE;
const role = options.role ?? DEFAULT_ROLE;
const branch = options.branch ?? BRANCH_BY_ENVIRONMENT[options.environment];
const connectionString = resolveConnectionString({ branch, database, projectId, role });

if (process.env.GITHUB_ACTIONS === 'true') {
  console.log(`::add-mask::${connectionString}`);
}

const psqlArguments = [connectionString, '-X', '-v', 'ON_ERROR_STOP=1'];
if (options.file) {
  psqlArguments.push('-f', options.file);
} else {
  psqlArguments.push('-c', options.command);
}

const executionEnvironment = { ...process.env };
if (!options.allowWrite) {
  const existingOptions = executionEnvironment.PGOPTIONS?.trim();
  executionEnvironment.PGOPTIONS = [existingOptions, '-c default_transaction_read_only=on']
    .filter(Boolean)
    .join(' ');
}

console.error(
  `direct-sql: target=${options.environment}/${branch}/${database} role=${role} mode=${options.allowWrite ? 'write-enabled' : 'read-only'}`,
);

const execution = spawnSync('psql', psqlArguments, {
  env: executionEnvironment,
  stdio: 'inherit',
});

if (execution.error) {
  fail(execution.error.message);
}

process.exit(execution.status ?? 1);
