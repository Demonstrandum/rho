const zip = (...arrays) =>
  arrays[0].map((_, i) => arrays.map(arr => arr[i]));

function choose<T>(items: T[], weights?: number[]): T {
    const n = items.length;
    const w = weights || Array(n).fill(1/n);
    const cum = w.reduce((c, x) => [...c, c[c.length-1] + x], [0]).slice(1);
    const t = Math.random() * cum[n - 1];

    for (const [c, item] of zip(cum, items)) {
        if (c > t) return item;
    }
    return items[n - 1];
}

const items = ['a','b','c','d'];
const weights = [0.2, 0.3, 0.4, 0.1];
const ideal = {}
for (const [i, w] of zip(items, weights)) {
    ideal[i] = w;
}

let hist = {
    'a': 0,
    'b': 0,
    'c': 0,
    'd': 0,
}

for (let i = 0; i < 100_000; ++i) {
    const it = choose(items, weights);
    hist[it] += 1
}

function printHistogram(h) {
    const AREA = 30;
    let total = 0;
    for (const bucket in h) {
        total += h[bucket];
    }
    for (const bucket in h) {
        const count = h[bucket];
        const size = Math.round(AREA * count / total);
        console.log(`${bucket}: ${'#'.repeat(size).padEnd(AREA)}  ${count/total}`)
    }
}


console.log('Seen:');
printHistogram(hist);
console.log('\nIdeal:');
printHistogram(ideal);
