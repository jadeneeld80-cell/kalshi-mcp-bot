import { exportBrain } from './store.js';

const asset = (process.argv[2] ?? 'btc').toUpperCase();
try {
  const brain = exportBrain(asset);
  process.stdout.write(JSON.stringify(brain, null, 2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
