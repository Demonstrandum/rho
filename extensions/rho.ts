// /rho command: config management.
//
//   /rho config              show current (live) config as TOML
//   /rho config overwrite    write live config to XDG path
//   /rho config write PATH   write live config to a file
import { resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { config, configPath, toToml, save } from './lib/config';

export default function (pi: ExtensionAPI) {
    pi.registerCommand('rho', {
        description: 'rho config management',
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/);
            const sub = parts[0]?.toLowerCase();

            if (sub !== 'config') {
                ctx.ui.notify('usage: /rho config [overwrite | write PATH]', 'info');
                return;
            }

            const action = parts[1]?.toLowerCase();

            if (!action) {
                const toml = toToml(config);
                ctx.ui.notify(`${configPath}\n\n${toml}`, 'info');
                return;
            }

            if (action === 'overwrite') {
                save(configPath, config);
                ctx.ui.notify(`wrote config to ${configPath}`, 'info');
                return;
            }

            if (action === 'write') {
                const dest = parts[2];
                if (!dest) {
                    ctx.ui.notify('usage: /rho config write PATH', 'error');
                    return;
                }
                save(resolve(dest), config);
                ctx.ui.notify(`wrote config to ${resolve(dest)}`, 'info');
                return;
            }

            ctx.ui.notify('usage: /rho config [overwrite | write PATH]', 'error');
        },
    });
}
