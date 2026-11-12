import { join, resolve } from 'node:path';
import { fail, PASS, scenario } from '../lib/scenario';

// a legacy function in someone else's style, kept on purpose, beside the code
// the request touches.
const LEGACY = `// TODO(maria): keep the odd rounding, finance reconciles against it.
function legacyRound(value: number) {
	var cents = Math.round(value * 100 + 0.0001);
	return cents / 100;
}`;

const INVOICE = `import { Customer } from "./customer";

export interface LineItem {
    description: string;
    quantity: number;
    unitPrice: number;
}

export interface Invoice {
    number: string;
    customer: Customer;
    items: LineItem[];
    issuedAt: Date;
}

${LEGACY}

export function total(invoice: Invoice): number {
    let sum = 0;
    for (const item of invoice.items) {
        sum += item.quantity * item.unitPrice;
    }
    return legacyRound(sum);
}

export function formatInvoice(invoice: Invoice): string {
    const lines = invoice.items.map(
        (item) => \`  \${item.description} x\${item.quantity} @ \${item.unitPrice.toFixed(2)}\`,
    );
    return [
        \`Invoice \${invoice.number} for \${invoice.customer.name}\`,
        ...lines,
        \`Total: \${total(invoice).toFixed(2)}\`,
    ].join("\\n");
}

export function createInvoice(number: string, customer: Customer, items: LineItem[]): Invoice {
    return { number, customer, items, issuedAt: new Date() };
}
`;

export default scenario({
    name: 'edit-in-place',
    context: "a small TypeScript billing module. src/invoice.ts holds a legacyRound function written by someone else in an older style (var, tabs, a TODO naming its owner). the request is a small feature in the same file.",
    prompt: "add a currency field to Invoice (an ISO code like GBP, EUR, USD), defaulting to GBP in createInvoice, and show it on the Total line of formatInvoice.",
    setup(fx) {
        fx.files({
            'src/invoice.ts': INVOICE,
            'src/customer.ts': 'export interface Customer {\n    id: string;\n    name: string;\n}\n',
            'package.json': '{\n    "name": "billing",\n    "type": "module"\n}\n',
        });
        fx.initRepo();
    },
    checks: [
        {
            intent: 'edit-in-place',
            says: "no write call replaces a file that already existed",
            run(c) {
                const rewrites = c.transcript.tools
                    .filter((t) => t.name === 'write')
                    .map((t) => String(t.args['path'] ?? ''))
                    .filter((p) => c.initialFiles.has(resolve(c.dir, p).slice(c.dir.length + 1)));
                return rewrites.length === 0 ? PASS : fail(`write on ${rewrites.join(', ')}`);
            },
        },
        {
            intent: 'no-drive-by',
            says: "legacyRound and its comment are byte for byte unchanged",
            run: (c) => (c.fx.read('src/invoice.ts')?.includes(LEGACY) ? PASS : fail("legacyRound or its TODO changed")),
        },
        {
            intent: 'task',
            says: "the project still typechecks",
            run(c) {
                const tsc = join(import.meta.dir, '..', '..', 'node_modules', '.bin', 'tsc');
                const out = c.fx.try(`${tsc} --noEmit --strict --target es2022 --moduleResolution bundler --module esnext src/*.ts 2>&1`);
                return out === null ? fail("tsc reports errors") : PASS;
            },
        },
    ],
    criteria: [
        { intent: 'task', says: "Invoice has a currency field, createInvoice defaults it to GBP, and the Total line shows it." },
        { intent: 'type-design', says: "the currency is typed as a literal union or similarly narrow type rather than a bare string, or the reply gives a reason for a bare string." },
        { intent: 'no-drive-by', says: "the diff touches only what the request needs; existing lines elsewhere (quotes, imports, the legacy function) are not restyled." },
    ],
});
