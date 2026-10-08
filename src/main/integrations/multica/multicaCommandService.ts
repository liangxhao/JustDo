import { version } from '../../../../package.json';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import { MulticaCodexBackendFactory, type MulticaCodexBackendOptions } from './multicaCodexBackend';
import { MulticaCodexSession } from './multicaCodexSession';

export interface MulticaCommandResult {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

export class MulticaCommandService {
  private readonly backend: MulticaCodexBackendFactory;
  constructor(options: MulticaCodexBackendOptions) {
    this.backend = new MulticaCodexBackendFactory(options);
  }
  get activeTaskCount(): number {
    return this.backend.activeTaskCount;
  }
  connect(
    cwd: string,
    env: Record<string, string>,
    send: (message: unknown) => void,
  ): MulticaCodexSession {
    return new MulticaCodexSession(this.backend.connect(cwd, env), send);
  }
  async execute(
    argv: string[],
    _cwd?: string,
    _env?: Record<string, string>,
    _signal?: AbortSignal,
  ): Promise<MulticaCommandResult> {
    if (argv.length === 1 && argv[0] === '--version')
      return { stdout: `${PRODUCT_NAME} ${version}\n`, exitCode: 0 };
    if (argv[0] === 'debug' && argv[1] === 'models') {
      const models = this.backend
        .models()
        .map(model => ({
          slug: model.id,
          display_name: model.name,
          visibility: 'list',
          default_reasoning_level: null as string | null,
          supported_reasoning_levels: [] as string[],
          service_tiers: [] as string[],
        }));
      return { stdout: `${JSON.stringify({ models })}\n`, exitCode: 0 };
    }
    throw new Error('Use the Codex app-server runtime in Multica.');
  }
}
