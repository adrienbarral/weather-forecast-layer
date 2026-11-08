import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const consumer = await mkdtemp(join(tmpdir(), 'wind-consumer-'));
try {
  const { stdout } = await execute('npm', ['pack', '--json', '--pack-destination', consumer]);
  const [result] = JSON.parse(stdout) as { filename: string }[];
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await execute('npm', ['install', '--no-audit', '--no-fund', join(consumer, result.filename)], { cwd: consumer });
  await writeFile(join(consumer, 'consumer.ts'), `import { OfficialGribProvider, WindLayer, bracketTime, type WindForecastProvider } from 'weather-forecast-layer';
    const provider: WindForecastProvider = new OfficialGribProvider();
    const wind = new WindLayer({ provider, time: new Date() });
    const date: Date = wind.getTime();
    const weight: number = bracketTime([0, 3], 1).alpha;
    console.log(date, weight);
  `);
  const compiler = resolve('node_modules/typescript/bin/tsc');
  await execute(process.execPath, [compiler, '--strict', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', 'consumer.ts'], { cwd: consumer });
  await execute(process.execPath, ['--input-type=module', '-e', "import { bracketTime, OfficialGribProvider, WindLayer } from 'weather-forecast-layer'; if (typeof OfficialGribProvider !== 'function' || typeof WindLayer !== 'function' || bracketTime([0,3],1).alpha !== 1/3) process.exit(1)"], { cwd: consumer });
  console.log('Packed ESM import and strict NodeNext consumer types verified');
} catch (error) {
  const commandError = error as Error & { stdout?: string; stderr?: string };
  console.error(commandError.stdout || commandError.stderr || commandError.message);
  process.exitCode = 1;
} finally { await rm(consumer, { recursive: true, force: true }); }