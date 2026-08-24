import { access, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

//* Package Smoke Test ========================================================

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = parseOutputPath(process.argv.slice(2))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'scheduler-package-smoke-'))
const distDirectory = join(repositoryRoot, 'dist')
const reactDirectory = join(repositoryRoot, 'node_modules', 'react')
const typescriptBin = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc')

const expectedPackageFiles = [
  'package/LICENSE',
  'package/README.md',
  'package/dist/index.cjs',
  'package/dist/index.d.cts',
  'package/dist/index.d.mts',
  'package/dist/index.d.ts',
  'package/dist/index.mjs',
  'package/dist/react.cjs',
  'package/dist/react.d.cts',
  'package/dist/react.d.mts',
  'package/dist/react.d.ts',
  'package/dist/react.mjs',
  'package/package.json',
].sort()

// Command Helpers -----------------------------------------------------------

function parseOutputPath(args) {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args

  if (normalizedArgs.length === 0) return undefined
  if (normalizedArgs.length !== 2 || normalizedArgs[0] !== '--output') {
    throw new Error('Usage: pnpm run smoke:package -- [--output <tarball-path>]')
  }

  return resolve(normalizedArgs[1])
}

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })

  if (result.error) throw result.error

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}.${output ? `\n${output}` : ''}`,
    )
  }

  return result.stdout?.trim() ?? ''
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function createConsumer(name, type = undefined) {
  const directory = join(temporaryRoot, name)
  await mkdir(directory)
  await writeJson(join(directory, 'package.json'), {
    name: `scheduler-smoke-${name}`,
    private: true,
    ...(type ? { type } : {}),
  })
  return directory
}

function installPackage(directory, archivePath, additionalPackages = []) {
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      archivePath,
      ...additionalPackages,
    ],
    directory,
  )
}

async function assertPathMissing(path, description) {
  try {
    await access(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  throw new Error(`${description} unexpectedly exists at ${path}.`)
}

// Consumer Checks -----------------------------------------------------------

async function verifyVanillaEsm(archivePath) {
  const directory = await createConsumer('vanilla-esm', 'module')
  installPackage(directory, archivePath)
  await assertPathMissing(join(directory, 'node_modules', 'react'), 'React dependency')
  await writeFile(
    join(directory, 'index.mjs'),
    [
      "import { getScheduler } from '@pmndrs/scheduler';",
      '',
      "if (typeof getScheduler !== 'function') throw new Error('ESM root export did not resolve.');",
      '',
    ].join('\n'),
  )
  run(process.execPath, ['index.mjs'], directory)
}

async function verifyVanillaCjs(archivePath) {
  const directory = await createConsumer('vanilla-cjs')
  installPackage(directory, archivePath)
  await writeFile(
    join(directory, 'index.cjs'),
    [
      "const { getScheduler } = require('@pmndrs/scheduler');",
      '',
      "if (typeof getScheduler !== 'function') throw new Error('CJS root export did not resolve.');",
      '',
    ].join('\n'),
  )
  run(process.execPath, ['index.cjs'], directory)
}

async function verifyTypescriptDeclarations(archivePath) {
  const directory = await createConsumer('typescript', 'module')
  installPackage(directory, archivePath)
  await writeJson(join(directory, 'tsconfig.json'), {
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      target: 'ES2020',
    },
    include: ['index.ts'],
  })
  await writeFile(
    join(directory, 'index.ts'),
    [
      "import { getScheduler, type SchedulerApi } from '@pmndrs/scheduler';",
      '',
      'const scheduler: SchedulerApi = getScheduler();',
      'scheduler.getRootIds();',
      '',
    ].join('\n'),
  )
  run(process.execPath, [typescriptBin, '--project', 'tsconfig.json'], directory)
}

async function verifyReactEntry(archivePath) {
  await access(join(reactDirectory, 'package.json'))
  const directory = await createConsumer('react', 'module')
  installPackage(directory, archivePath, [reactDirectory])
  await writeFile(
    join(directory, 'index.mjs'),
    [
      "import { useFrame } from '@pmndrs/scheduler/react';",
      "import React from 'react';",
      '',
      "if (typeof useFrame !== 'function') throw new Error('React entry export did not resolve.');",
      "if (typeof React.createElement !== 'function') throw new Error('React dependency did not resolve.');",
      '',
    ].join('\n'),
  )
  run(process.execPath, ['index.mjs'], directory)
}

// Pack and Verify -----------------------------------------------------------

try {
  if (outputPath) await rm(outputPath, { force: true })

  run('pnpm', ['run', 'build'], repositoryRoot)
  const packReport = JSON.parse(
    run(
      'pnpm',
      ['--config.ignore-scripts=true', 'pack', '--json', '--pack-destination', temporaryRoot],
      repositoryRoot,
      true,
    ),
  )
  const archivePath = resolve(packReport.filename)

  if (dirname(archivePath) !== temporaryRoot) {
    throw new Error(`pnpm packed outside the temporary directory: ${archivePath}`)
  }

  const packageFiles = run('tar', ['-tzf', archivePath], repositoryRoot, true).split('\n').filter(Boolean).sort()

  if (JSON.stringify(packageFiles) !== JSON.stringify(expectedPackageFiles)) {
    throw new Error(
      `Packed files do not match the expected package contents.\nExpected:\n${expectedPackageFiles.join(
        '\n',
      )}\nActual:\n${packageFiles.join('\n')}`,
    )
  }

  const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
  console.log(`\nTesting ${packageJson.name}@${packageJson.version} from ${packReport.filename}...`)

  await verifyVanillaEsm(archivePath)
  await verifyVanillaCjs(archivePath)
  await verifyTypescriptDeclarations(archivePath)
  await verifyReactEntry(archivePath)

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true })
    await copyFile(archivePath, outputPath)
    console.log(JSON.stringify({ tarball: outputPath }))
  }

  console.log('Package smoke test passed.')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
  await rm(distDirectory, { recursive: true, force: true })
}
